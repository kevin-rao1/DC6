// The flat page: the body strip and the flat islands laid out together,
// and the two maps between the surface and the page.
//
// Page coordinates are millimetres: x to the right (towards the tail), y up.
// The datum of page x is the nose tip (pageDatum below), so the ruler reads
// mm from the nose tip along the body. Later stages (the placement sheet)
// measure from the aft end; they convert with stationFromAft.
//
// The page is built once per assembly (buildPage: the expensive part, ray
// casts) and then shown at a centre roll (viewPage: cheap, cutting the strip
// at the seam for that roll). Building is a pure function of the assembly:
// the same assembly gives the same page.
//
// Layout: the strip lies along y = 0 with the nose at x = 0. Islands of
// faces on the side of the rocket sit in one row above the strip (those
// facing the top half, roll 0 to pi) and one row below it, clear of the
// strip's repeat band, an even gap apart. The sides of one part sit side
// by side (left, then right, seen from the tail). Each part's islands
// start at its own station and move along the row, aft or forward, to the
// nearest free place; the part nearest the side view goes first. So the
// page is about as tall as the strip and one row of islands on each side.
// End faces sit beyond the end of the strip they face, at their station,
// centred on the strip's line if that is free, else in the row above.

import type { Vec3 } from './vec3.ts';
import type { Surface } from './geodesic.ts';
import { closestPointOnTriangle, partGap } from './geodesic.ts';
import { trianglesNear } from './bvh.ts';
import { applyToPoint } from './transform.ts';
import { barycentricOf, meshVertex } from './surface-mesh.ts';
import type { DecalGrid } from './decal-map.ts';
import type { Band, Strip, StripPiece } from './page-strip.ts';
import { arcAt, buildStrip, cutLines, nearestTurn, repeatAngle, stripImages, stripPieces, stripPointNear, stripPointRoll, triangleKey } from './page-strip.ts';
import { dot, length, sub } from './vec3.ts';
import { AFT_DIRECTION } from './rocket-axis.ts';
import type { Island, PieceInfo } from './page-islands.ts';
import { findIslands } from './page-islands.ts';

// Two parts' strips this close meet at a joint (mm): the gap a decal may
// hop across.
const jointDistance = partGap;
// Gap between islands, and between the strip and the islands (mm).
export const islandGap = 10;
// Page x of the nose tip.
export const pageDatum = 0;

// Distance from the aft end, for a page x (the placement sheet's default datum).
export function stationFromAft(page: Page, x: number): number {
  return page.strip.length - x;
}

export interface Page {
  surface: Surface;
  // Placed id of each surface piece.
  placedIds: string[];
  strip: Strip;
  islands: Island[];
  // "piece:triangle" -> [island, position in island.triangles].
  islandTriangles: Map<string, [number, number]>;
  // Per strip triangle edge: edgeInside, edgeOutline or edgeJoint.
  edgeKinds: Uint8Array;
  // Half height of the strip and its repeat band, per 1 mm of page x from
  // envelopeStart (used by the layout).
  envelopeStart: number;
  envelope: Float64Array;
  // Bounds of everything on the page.
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  buildMilliseconds: number;
}

export function buildPage(surface: Surface, info: PieceInfo[]): Page {
  if (info.length !== surface.pieces.length) {
    throw new Error('buildPage: expected one PieceInfo per surface piece, got ' + String(info.length) + ' for ' + String(surface.pieces.length));
  }
  const start = performance.now();
  const strip = buildStrip(surface);
  const islands = findIslands(surface, info, strip);
  const placedIds: string[] = [];
  for (let i = 0; i < surface.pieces.length; i++) {
    placedIds.push(surface.pieces[i].placedId);
  }
  const islandTriangles = new Map<string, [number, number]>();
  for (let i = 0; i < islands.length; i++) {
    for (let k = 0; k < islands[i].triangles.length; k++) {
      islandTriangles.set(triangleKey(islands[i].piece, islands[i].triangles[k]), [i, k]);
    }
  }
  // The strip's half height at each page x: its widest corner there, out
  // to the end of the repeat band.
  let envelopeStart = 0;
  let envelopeEnd = 0;
  for (let i = 0; i < strip.triangles.length; i++) {
    for (let k = 0; k < 3; k++) {
      envelopeStart = Math.min(envelopeStart, Math.floor(strip.triangles[i].x[k]));
      envelopeEnd = Math.max(envelopeEnd, Math.ceil(strip.triangles[i].x[k]));
    }
  }
  const envelope = new Float64Array(envelopeEnd - envelopeStart + 1);
  for (let i = 0; i < strip.triangles.length; i++) {
    const s = strip.triangles[i];
    const first = Math.floor(Math.min(s.x[0], s.x[1], s.x[2])) - envelopeStart;
    const last = Math.ceil(Math.max(s.x[0], s.x[1], s.x[2])) - envelopeStart;
    const widest = Math.max(s.rho[0], s.rho[1], s.rho[2]) * (Math.PI + repeatAngle);
    for (let b = first; b <= last; b++) {
      envelope[b] = Math.max(envelope[b], widest);
    }
  }
  const page: Page = {
    surface: surface,
    placedIds: placedIds,
    strip: strip,
    islands: islands,
    islandTriangles: islandTriangles,
    edgeKinds: classifyEdges(surface, strip),
    envelopeStart: envelopeStart,
    envelope: envelope,
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    buildMilliseconds: 0,
  };
  layOut(page);
  page.buildMilliseconds = performance.now() - start;
  return page;
}

// Half height of the strip band over page x from `from` to `to`.
function envelopeOver(page: Page, from: number, to: number): number {
  let widest = 0;
  const first = Math.max(0, Math.floor(from) - page.envelopeStart);
  const last = Math.min(page.envelope.length - 1, Math.ceil(to) - page.envelopeStart);
  for (let b = first; b <= last; b++) {
    widest = Math.max(widest, page.envelope[b]);
  }
  return widest;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function islandBox(island: Island): Box {
  return {
    minX: island.minX + island.offsetX,
    minY: island.minY + island.offsetY,
    maxX: island.maxX + island.offsetX,
    maxY: island.maxY + island.offsetY,
  };
}

function layOut(page: Page): void {
  const islands = page.islands;
  const profile = page.strip.profile;
  // The strip band's half height (strip and repeat band) at its widest:
  // the rows of islands run straight along above and below it.
  let bandHalf = 0;
  for (let b = 0; b < page.envelope.length; b++) {
    bandHalf = Math.max(bandHalf, page.envelope[b]);
  }
  const rowEdge = bandHalf + islandGap;
  // Side islands, grouped by part and by row: the sides of one fin go
  // together, side by side.
  const blocks: Block[] = [];
  const ends: number[] = [];
  for (let i = 0; i < islands.length; i++) {
    const island = islands[i];
    const arc = arcAt(profile, island.station);
    if (island.kind === 'end') {
      // Beyond the end it faces: aft-facing to the right of its station.
      const facesAft = dot(island.normal, AFT_DIRECTION) > 0;
      if (facesAft) {
        island.offsetX = arc + islandGap - island.minX;
      } else {
        island.offsetX = arc - islandGap - island.maxX;
      }
      ends.push(i);
      continue;
    }
    // Side islands: above the strip if they face the top half.
    const row = island.roll >= 0 ? 1 : -1;
    let block: Block | null = null;
    for (let k = 0; k < blocks.length; k++) {
      if (blocks[k].piece === island.piece && blocks[k].row === row) {
        block = blocks[k];
      }
    }
    if (block === null) {
      block = { piece: island.piece, row: row, members: [], preferred: Infinity, width: 0, roll: island.roll };
      blocks.push(block);
    }
    block.members.push(i);
    // Where the island's left edge would be with its middle at its station.
    block.preferred = Math.min(block.preferred, arc + island.minX);
  }
  for (let k = 0; k < blocks.length; k++) {
    const block = blocks[k];
    // Left side first, then right (as seen from the tail), then by face.
    block.members.sort(function bySide(a, b) {
      const sideA = islands[a].side === 'right' ? 1 : 0;
      const sideB = islands[b].side === 'right' ? 1 : 0;
      if (sideA !== sideB) {
        return sideA - sideB;
      }
      return islands[a].face - islands[b].face;
    });
    let width = 0;
    for (let m = 0; m < block.members.length; m++) {
      const island = islands[block.members[m]];
      if (m > 0) {
        width = width + islandGap;
      }
      width = width + island.maxX - island.minX;
    }
    block.width = width;
  }
  // Nearest the side view first: they get their own station.
  blocks.sort(function nearestFirst(a, b) {
    if (a.row !== b.row) {
      return b.row - a.row;
    }
    return Math.abs(a.roll) - Math.abs(b.roll);
  });
  const rows: Record<string, Array<[number, number]>> = { '1': [], '-1': [] };
  const stripStart = 0;
  const stripEnd = page.strip.length;
  for (let k = 0; k < blocks.length; k++) {
    const block = blocks[k];
    const taken = rows[String(block.row)];
    const left = freeSpot(taken, block.preferred, block.width, stripStart, stripEnd);
    taken.push([left, left + block.width]);
    let x = left;
    for (let m = 0; m < block.members.length; m++) {
      const island = islands[block.members[m]];
      island.offsetX = x - island.minX;
      if (block.row > 0) {
        island.offsetY = rowEdge - island.minY;
      } else {
        island.offsetY = -rowEdge - island.maxY;
      }
      island.labelSide = block.row;
      x = x + island.maxX - island.minX + islandGap;
    }
  }
  const placed: Box[] = [];
  for (let i = 0; i < islands.length; i++) {
    if (islands[i].kind === 'side') {
      placed.push(islandBox(islands[i]));
    }
  }
  // End faces: beyond the end of the strip they face, on its middle line
  // if that is free; else in the row above.
  for (let k = 0; k < ends.length; k++) {
    const island = islands[ends[k]];
    island.offsetY = -(island.minY + island.maxY) / 2;
    island.labelSide = -1;
    const box = islandBox(island);
    let clear = envelopeOver(page, box.minX - islandGap, box.maxX + islandGap) === 0;
    for (let q = 0; q < placed.length && clear; q++) {
      const other = placed[q];
      const apart = box.minX >= other.maxX + islandGap || box.maxX <= other.minX - islandGap || box.minY >= other.maxY + islandGap || box.maxY <= other.minY - islandGap;
      if (!apart) {
        clear = false;
      }
    }
    if (!clear) {
      const taken = rows['1'];
      const width = island.maxX - island.minX;
      const left = freeSpot(taken, island.offsetX + island.minX, width, stripStart, stripEnd);
      taken.push([left, left + width]);
      island.offsetX = left - island.minX;
      island.offsetY = rowEdge - island.minY;
      island.labelSide = 1;
    }
    placed.push(islandBox(island));
  }
  // Bounds: the strip band and every island.
  let minX = 0;
  let maxX = page.strip.length;
  let maxY = bandHalf;
  let minY = -bandHalf;
  for (let q = 0; q < placed.length; q++) {
    minX = Math.min(minX, placed[q].minX);
    maxX = Math.max(maxX, placed[q].maxX);
    minY = Math.min(minY, placed[q].minY);
    maxY = Math.max(maxY, placed[q].maxY);
  }
  page.minX = minX;
  page.minY = minY;
  page.maxX = maxX;
  page.maxY = maxY;
}

// The islands of one part in one row, laid side by side.
interface Block {
  piece: number;
  row: number;
  members: number[];
  // Left edge it would have at its own station, and its width (mm).
  preferred: number;
  width: number;
  roll: number;
}

// Where in a row a block of this width goes: the free place nearest its
// own station, an even gap from the blocks already there. Going past the
// ends of the strip counts double, so a block moves along over the strip
// rather than off its end when both are as near.
function freeSpot(taken: Array<[number, number]>, preferred: number, width: number, stripStart: number, stripEnd: number): number {
  const candidates: number[] = [preferred];
  for (let i = 0; i < taken.length; i++) {
    candidates.push(taken[i][1] + islandGap);
    candidates.push(taken[i][0] - islandGap - width);
  }
  let best = preferred;
  let bestCost = Infinity;
  for (let c = 0; c < candidates.length; c++) {
    const left = candidates[c];
    const right = left + width;
    let free = true;
    for (let i = 0; i < taken.length; i++) {
      // Touching at exactly the gap is allowed (a hair of rounding aside).
      if (left < taken[i][1] + islandGap - 1e-9 && right > taken[i][0] - islandGap + 1e-9) {
        free = false;
        break;
      }
    }
    if (!free) {
      continue;
    }
    const overhang = Math.max(0, stripStart - left) + Math.max(0, right - stripEnd);
    const cost = Math.abs(left - preferred) + overhang;
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = left;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The page at a centre roll.

// Which drawing a page point belongs to: the strip in one of its bands
// (-1, 0, 1), or island i (islandChart(i)).
export function islandChart(island: number): number {
  return 10 + island;
}

// A polygon of the page that is part of one mesh triangle, with the affine
// map from that triangle: corner k of the triangle goes to (corners[2k],
// corners[2k+1]).
export interface PageFace {
  piece: number;
  triangle: number;
  chart: number;
  corners: [number, number, number, number, number, number];
  // Outline on the page, counterclockwise: x, y pairs.
  polygon: number[];
}

export interface PageView {
  page: Page;
  roll: number;
  faces: PageFace[];
  // Strip faces first (stripFaceCount of them), then island faces.
  stripFaceCount: number;
  pieces: StripPiece[];
  // Lines to draw: strip edges (outline), joints between parts (faint), the
  // seam lines (the strip's top and bottom edges) and the outer edges of the
  // repeat band: x1, y1, x2, y2 each.
  outline: number[];
  joints: number[];
  seams: number[];
  repeatEdges: number[];
  // Spatial index of `faces` for page -> surface: cells of indexCell mm.
  indexMinX: number;
  indexMinY: number;
  indexColumns: number;
  indexRows: number;
  cells: number[][];
}

const indexCell = 4;

export function viewPage(page: Page, roll: number): PageView {
  const pieces = stripPieces(page.strip, roll);
  const faces: PageFace[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const s = page.strip.triangles[piece.strip];
    const polygon: number[] = [];
    for (let q = 0; q < piece.outline.length; q++) {
      const w = piece.outline[q];
      // Affine in the corners: the same as stripPagePoint, without recomputing them.
      const x = w[0] * piece.corners[0][0] + w[1] * piece.corners[1][0] + w[2] * piece.corners[2][0];
      const y = w[0] * piece.corners[0][1] + w[1] * piece.corners[1][1] + w[2] * piece.corners[2][1];
      polygon.push(x, y);
    }
    faces.push({
      piece: s.piece,
      triangle: s.triangle,
      chart: piece.band,
      corners: [piece.corners[0][0], piece.corners[0][1], piece.corners[1][0], piece.corners[1][1], piece.corners[2][0], piece.corners[2][1]],
      polygon: polygon,
    });
  }
  const stripFaceCount = faces.length;
  for (let i = 0; i < page.islands.length; i++) {
    const island = page.islands[i];
    for (let k = 0; k < island.triangles.length; k++) {
      const c = island.corners;
      const corners: [number, number, number, number, number, number] = [
        c[6 * k] + island.offsetX,
        c[6 * k + 1] + island.offsetY,
        c[6 * k + 2] + island.offsetX,
        c[6 * k + 3] + island.offsetY,
        c[6 * k + 4] + island.offsetX,
        c[6 * k + 5] + island.offsetY,
      ];
      let polygon = [corners[0], corners[1], corners[2], corners[3], corners[4], corners[5]];
      const area = (corners[2] - corners[0]) * (corners[5] - corners[1]) - (corners[4] - corners[0]) * (corners[3] - corners[1]);
      if (area < 0) {
        polygon = [corners[0], corners[1], corners[4], corners[5], corners[2], corners[3]];
      }
      faces.push({ piece: island.piece, triangle: island.triangles[k], chart: islandChart(i), corners: corners, polygon: polygon });
    }
  }
  const view: PageView = {
    page: page,
    roll: roll,
    faces: faces,
    stripFaceCount: stripFaceCount,
    pieces: pieces,
    outline: [],
    joints: [],
    seams: [],
    repeatEdges: [],
    indexMinX: 0,
    indexMinY: 0,
    indexColumns: 0,
    indexRows: 0,
    cells: [],
  };
  buildIndex(view);
  findLines(view);
  return view;
}

function buildIndex(view: PageView): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let f = 0; f < view.faces.length; f++) {
    const polygon = view.faces[f].polygon;
    for (let q = 0; q < polygon.length; q = q + 2) {
      minX = Math.min(minX, polygon[q]);
      maxX = Math.max(maxX, polygon[q]);
      minY = Math.min(minY, polygon[q + 1]);
      maxY = Math.max(maxY, polygon[q + 1]);
    }
  }
  if (!Number.isFinite(minX)) {
    return;
  }
  const columns = Math.max(1, Math.ceil((maxX - minX) / indexCell) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / indexCell) + 1);
  const cells: number[][] = [];
  for (let i = 0; i < columns * rows; i++) {
    cells.push([]);
  }
  for (let f = 0; f < view.faces.length; f++) {
    const polygon = view.faces[f].polygon;
    let fMinX = Infinity;
    let fMinY = Infinity;
    let fMaxX = -Infinity;
    let fMaxY = -Infinity;
    for (let q = 0; q < polygon.length; q = q + 2) {
      fMinX = Math.min(fMinX, polygon[q]);
      fMaxX = Math.max(fMaxX, polygon[q]);
      fMinY = Math.min(fMinY, polygon[q + 1]);
      fMaxY = Math.max(fMaxY, polygon[q + 1]);
    }
    const c0 = Math.floor((fMinX - minX) / indexCell);
    const c1 = Math.floor((fMaxX - minX) / indexCell);
    const r0 = Math.floor((fMinY - minY) / indexCell);
    const r1 = Math.floor((fMaxY - minY) / indexCell);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        cells[r * columns + c].push(f);
      }
    }
  }
  view.indexMinX = minX;
  view.indexMinY = minY;
  view.indexColumns = columns;
  view.indexRows = rows;
  view.cells = cells;
}

// Barycentric weights of page point (x, y) in a face's affine map.
function pageBarycentric(face: PageFace, x: number, y: number): Vec3 | null {
  const c = face.corners;
  const ax = c[2] - c[0];
  const ay = c[3] - c[1];
  const bx = c[4] - c[0];
  const by = c[5] - c[1];
  const determinant = ax * by - ay * bx;
  if (Math.abs(determinant) < 1e-14) {
    return null;
  }
  const px = x - c[0];
  const py = y - c[1];
  const wb = (px * by - py * bx) / determinant;
  const wc = (ax * py - ay * px) / determinant;
  return [1 - wb - wc, wb, wc];
}

// Is (x, y) inside a convex counterclockwise polygon (with a small margin)?
function insideConvex(polygon: number[], x: number, y: number, margin: number): boolean {
  const n = polygon.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = polygon[2 * i];
    const ay = polygon[2 * i + 1];
    const bx = polygon[2 * j];
    const by = polygon[2 * j + 1];
    const edgeLength = Math.hypot(bx - ax, by - ay);
    if (edgeLength < 1e-12) {
      continue;
    }
    const side = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / edgeLength;
    if (side < -margin) {
      return false;
    }
  }
  return true;
}

// A point of the surface as the page knows it.
export interface PageSurfacePoint {
  piece: number;
  placedId: string;
  triangle: number;
  barycentric: Vec3;
  chart: number;
}

// Page -> surface: the surface point under a page point, or null where the
// page is empty.
export function pageToSurface(view: PageView, x: number, y: number): PageSurfacePoint | null {
  if (view.cells.length === 0) {
    return null;
  }
  const column = Math.floor((x - view.indexMinX) / indexCell);
  const row = Math.floor((y - view.indexMinY) / indexCell);
  if (column < 0 || row < 0 || column >= view.indexColumns || row >= view.indexRows) {
    return null;
  }
  const candidates = view.cells[row * view.indexColumns + column];
  let fallback: PageSurfacePoint | null = null;
  for (let k = 0; k < candidates.length; k++) {
    const face = view.faces[candidates[k]];
    if (!insideConvex(face.polygon, x, y, 1e-9)) {
      continue;
    }
    const w = pageBarycentric(face, x, y);
    if (w === null) {
      continue;
    }
    const result: PageSurfacePoint = { piece: face.piece, placedId: view.page.placedIds[face.piece], triangle: face.triangle, barycentric: w, chart: face.chart };
    // Prefer a face the point is inside of in its own triangle too (on a
    // shared edge either is right).
    if (w[0] >= -1e-9 && w[1] >= -1e-9 && w[2] >= -1e-9) {
      return result;
    }
    if (fallback === null) {
      fallback = result;
    }
  }
  return fallback;
}

export interface PageImage {
  x: number;
  y: number;
  chart: number;
}

// Surface -> page: every place a surface point shows on the page (none if
// that surface is not on the page; two near the seam).
export function surfaceToPage(view: PageView, piece: number, triangle: number, barycentric: Vec3): PageImage[] {
  const page = view.page;
  const key = triangleKey(piece, triangle);
  const result: PageImage[] = [];
  const stripIndex = page.strip.index.get(key);
  if (stripIndex !== undefined) {
    const images = stripImages(page.strip, stripIndex, barycentric, view.roll);
    for (let i = 0; i < images.length; i++) {
      result.push({ x: images[i].x, y: images[i].y, chart: images[i].band });
    }
    return result;
  }
  const onIsland = page.islandTriangles.get(key);
  if (onIsland !== undefined) {
    const island = page.islands[onIsland[0]];
    const c = island.corners;
    const k = onIsland[1];
    const x = barycentric[0] * c[6 * k] + barycentric[1] * c[6 * k + 2] + barycentric[2] * c[6 * k + 4];
    const y = barycentric[0] * c[6 * k + 1] + barycentric[1] * c[6 * k + 3] + barycentric[2] * c[6 * k + 5];
    result.push({ x: x + island.offsetX, y: y + island.offsetY, chart: islandChart(onIsland[0]) });
  }
  return result;
}

// Surface piece number of a placed part on the page, or -1.
export function pagePieceOf(page: Page, placedId: string): number {
  return page.placedIds.indexOf(placedId);
}

// ---------------------------------------------------------------------------
// Lines: outline, joints, seams.

// What each edge of each strip triangle is on the page (edge k runs from
// corner k to corner k + 1): inside the strip (the triangle across it is on
// the strip too), a joint (the strip of another part lies within a
// millimetre of it), or an edge of the strip (a hole, the nose or the tail).
// Found once per page, from the mesh: it does not change with the roll.
export const edgeInside = 0;
export const edgeOutline = 1;
export const edgeJoint = 2;

function classifyEdges(surface: Surface, strip: Strip): Uint8Array {
  const kinds = new Uint8Array(strip.triangles.length * 3);
  for (let i = 0; i < strip.triangles.length; i++) {
    const s = strip.triangles[i];
    const piece = surface.pieces[s.piece];
    const mesh = piece.mesh;
    for (let k = 0; k < 3; k++) {
      const across = mesh.neighbours[3 * s.triangle + k];
      if (across >= 0 && strip.index.has(triangleKey(s.piece, across))) {
        kinds[3 * i + k] = edgeInside;
        continue;
      }
      const a = meshVertex(mesh, s.triangle, k);
      const b = meshVertex(mesh, s.triangle, (k + 1) % 3);
      const middle = applyToPoint(piece.transform, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      let joint = false;
      for (let p = 0; p < surface.pieces.length && !joint; p++) {
        if (p === s.piece) {
          continue;
        }
        const other = surface.pieces[p];
        const local = applyToPoint(other.inverse, middle);
        const near = trianglesNear(other.bvh, local, jointDistance);
        for (let q = 0; q < near.length; q++) {
          if (!strip.index.has(triangleKey(p, near[q]))) {
            continue;
          }
          const closest = closestPointOnTriangle(local, meshVertex(other.mesh, near[q], 0), meshVertex(other.mesh, near[q], 1), meshVertex(other.mesh, near[q], 2));
          if (length(sub(closest, local)) <= jointDistance) {
            joint = true;
            break;
          }
        }
      }
      kinds[3 * i + k] = joint ? edgeJoint : edgeOutline;
    }
  }
  return kinds;
}

// Which edge of its triangle a piece outline edge lies on (both ends have
// the opposite corner's weight zero), or -1.
function triangleEdgeOf(a: Vec3, b: Vec3): number {
  for (let k = 0; k < 3; k++) {
    const opposite = (k + 2) % 3;
    if (Math.abs(a[opposite]) < 1e-9 && Math.abs(b[opposite]) < 1e-9) {
      return k;
    }
  }
  return -1;
}

// The lines of the strip on the page at this roll. Cut edges are the seam
// (between the strip and its repeat, drawn once from the strip side) or the
// outer edge of the repeat band.
function findLines(view: PageView): void {
  const outline: number[] = [];
  const joints: number[] = [];
  const seams: number[] = [];
  const repeatEdges: number[] = [];
  for (let f = 0; f < view.stripFaceCount; f++) {
    const face = view.faces[f];
    const stripPiece = view.pieces[f];
    const polygon = face.polygon;
    const n = polygon.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const line = stripPiece.cutEdges[i];
      let target: number[] | null = null;
      if (line >= 0) {
        const onSeam = cutLines[line] === 'seam-low' || cutLines[line] === 'seam-high';
        if (onSeam && face.chart === 0) {
          target = seams;
        } else if (!onSeam) {
          target = repeatEdges;
        }
      } else {
        const edge = triangleEdgeOf(stripPiece.outline[i], stripPiece.outline[j]);
        if (edge >= 0) {
          const kind = view.page.edgeKinds[3 * stripPiece.strip + edge];
          if (kind === edgeOutline) {
            target = outline;
          } else if (kind === edgeJoint) {
            target = joints;
          }
        }
      }
      if (target !== null) {
        target.push(polygon[2 * i], polygon[2 * i + 1], polygon[2 * j], polygon[2 * j + 1]);
      }
    }
  }
  view.outline = outline;
  view.joints = joints;
  view.seams = seams;
  view.repeatEdges = repeatEdges;
}

// ---------------------------------------------------------------------------
// Decals on the page.

// One triangle of a decal on the page: its page corners and the same
// corners in the decal's own frame (mm from its centre, x right, y up).
export interface DecalPageTriangle {
  page: [number, number, number, number, number, number];
  decal: [number, number, number, number, number, number];
  // Which drawing of the decal it belongs to: one per whole turn on the
  // strip (a decal near the seam is drawn twice), one per island.
  copy: number;
}

interface GridPointOnPage {
  // Strip triangle index, or -1.
  strip: number;
  // Island chart and the island image, or -1.
  island: number;
  islandX: number;
  islandY: number;
  barycentric: Vec3;
  // Roll angle of the point (strip only).
  angle: number;
}

// The decal's mapped grid pushed through the surface -> page map, cell by
// cell. A cell whose corners are all on the strip is drawn wherever it
// falls in the strip's bands: on both sides of the seam if it is near it
// (it is one continuous piece of surface, unwrapped). A cell whose corners
// are all on one island is drawn there. Cells across the edge of the strip
// onto an island (or off the page) are not drawn.
export function decalPageTriangles(view: PageView, grid: DecalGrid): DecalPageTriangle[] {
  const page = view.page;
  const count = grid.columns * grid.rows;
  const points: Array<GridPointOnPage | null> = [];
  const pieceOfGrid = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    if (grid.present[k] === 0) {
      points.push(null);
      continue;
    }
    const surfacePiece = grid.pieces[k];
    let pagePiece = pieceOfGrid.get(surfacePiece);
    if (pagePiece === undefined) {
      pagePiece = pagePieceOf(page, grid.placedIds[surfacePiece]);
      pieceOfGrid.set(surfacePiece, pagePiece);
    }
    if (pagePiece < 0) {
      points.push(null);
      continue;
    }
    const triangle = grid.triangles[k];
    const mesh = page.surface.pieces[pagePiece].mesh;
    if (triangle >= mesh.triangles.length / 3) {
      // The page is of an older assembly (a part was replaced since).
      points.push(null);
      continue;
    }
    const local: Vec3 = [grid.locals[3 * k], grid.locals[3 * k + 1], grid.locals[3 * k + 2]];
    const w = barycentricOf(mesh, triangle, local);
    const key = triangleKey(pagePiece, triangle);
    const stripIndex = page.strip.index.get(key);
    if (stripIndex !== undefined) {
      const angle = stripPointRoll(page.strip.triangles[stripIndex], w);
      points.push({ strip: stripIndex, island: -1, islandX: 0, islandY: 0, barycentric: w, angle: angle });
      continue;
    }
    const onIsland = page.islandTriangles.get(key);
    if (onIsland !== undefined) {
      const images = surfaceToPage(view, pagePiece, triangle, w);
      points.push({ strip: -1, island: images[0].chart, islandX: images[0].x, islandY: images[0].y, barycentric: w, angle: 0 });
      continue;
    }
    points.push(null);
  }

  const result: DecalPageTriangle[] = [];
  const low = view.roll - Math.PI - repeatAngle;
  const high = view.roll + Math.PI + repeatAngle;
  for (let j = 0; j + 1 < grid.rows; j++) {
    for (let i = 0; i + 1 < grid.columns; i++) {
      const ids = [j * grid.columns + i, j * grid.columns + i + 1, (j + 1) * grid.columns + i + 1, (j + 1) * grid.columns + i];
      const corners: Array<GridPointOnPage | null> = [points[ids[0]], points[ids[1]], points[ids[2]], points[ids[3]]];
      const decalXY: Array<[number, number]> = [
        [grid.xs[i], grid.ys[j]],
        [grid.xs[i + 1], grid.ys[j]],
        [grid.xs[i + 1], grid.ys[j + 1]],
        [grid.xs[i], grid.ys[j + 1]],
      ];
      // The triangles of the cell, as DecalVisual makes them.
      const present = [corners[0] !== null, corners[1] !== null, corners[2] !== null, corners[3] !== null];
      const triangles: number[][] = [];
      if (present[0] && present[1] && present[2] && present[3]) {
        triangles.push([0, 1, 2], [0, 2, 3]);
      } else if (present[0] && present[1] && present[2]) {
        triangles.push([0, 1, 2]);
      } else if (present[0] && present[2] && present[3]) {
        triangles.push([0, 2, 3]);
      } else if (present[0] && present[1] && present[3]) {
        triangles.push([0, 1, 3]);
      } else if (present[1] && present[2] && present[3]) {
        triangles.push([1, 2, 3]);
      }
      for (let t = 0; t < triangles.length; t++) {
        const a = corners[triangles[t][0]] as GridPointOnPage;
        const b = corners[triangles[t][1]] as GridPointOnPage;
        const c = corners[triangles[t][2]] as GridPointOnPage;
        const decal: [number, number, number, number, number, number] = [
          decalXY[triangles[t][0]][0],
          decalXY[triangles[t][0]][1],
          decalXY[triangles[t][1]][0],
          decalXY[triangles[t][1]][1],
          decalXY[triangles[t][2]][0],
          decalXY[triangles[t][2]][1],
        ];
        if (a.strip >= 0 && b.strip >= 0 && c.strip >= 0) {
          // Unwrap the three angles together, then draw at every whole
          // turn that brings any corner into the bands.
          const angleA = a.angle;
          const angleB = nearestTurn(b.angle, angleA);
          const angleC = nearestTurn(c.angle, angleA);
          const lowest = Math.min(angleA, angleB, angleC);
          const highest = Math.max(angleA, angleB, angleC);
          const firstTurn = Math.ceil((low - highest) / (2 * Math.PI));
          const lastTurn = Math.floor((high - lowest) / (2 * Math.PI));
          for (let k = firstTurn; k <= lastTurn; k++) {
            const turn = k * 2 * Math.PI;
            const pa = stripPointNear(page.strip, a.strip, a.barycentric, angleA + turn, view.roll);
            const pb = stripPointNear(page.strip, b.strip, b.barycentric, angleB + turn, view.roll);
            const pc = stripPointNear(page.strip, c.strip, c.barycentric, angleC + turn, view.roll);
            result.push({ page: [pa.x, pa.y, pb.x, pb.y, pc.x, pc.y], decal: decal, copy: k });
          }
          continue;
        }
        if (a.island >= 0 && a.island === b.island && b.island === c.island) {
          result.push({ page: [a.islandX, a.islandY, b.islandX, b.islandY, c.islandX, c.islandY], decal: decal, copy: 1000 + a.island });
        }
      }
    }
  }
  return result;
}

// The decal-frame point under a page point, from a decal's page triangles
// (the last one drawn wins, as on screen), or null.
export function decalPointAt(triangles: DecalPageTriangle[], x: number, y: number): { x: number; y: number } | null {
  for (let t = triangles.length - 1; t >= 0; t--) {
    const p = triangles[t].page;
    const ax = p[2] - p[0];
    const ay = p[3] - p[1];
    const bx = p[4] - p[0];
    const by = p[5] - p[1];
    const determinant = ax * by - ay * bx;
    if (Math.abs(determinant) < 1e-14) {
      continue;
    }
    const px = x - p[0];
    const py = y - p[1];
    const wb = (px * by - py * bx) / determinant;
    const wc = (ax * py - ay * px) / determinant;
    const wa = 1 - wb - wc;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) {
      continue;
    }
    const d = triangles[t].decal;
    return { x: wa * d[0] + wb * d[2] + wc * d[4], y: wa * d[1] + wb * d[3] + wc * d[5] };
  }
  return null;
}

// The page position of a point given in a decal's own frame, in one copy
// of it, from the triangle of that copy it falls in; with the affine map of
// that triangle (decal mm -> page mm) so directions can be carried too.
export function decalToPage(triangles: DecalPageTriangle[], copy: number, x: number, y: number): { x: number; y: number; map: [number, number, number, number] } | null {
  let best: DecalPageTriangle | null = null;
  let bestOutside = Infinity;
  for (let t = 0; t < triangles.length; t++) {
    const triangle = triangles[t];
    if (triangle.copy !== copy) {
      continue;
    }
    const d = triangle.decal;
    const ax = d[2] - d[0];
    const ay = d[3] - d[1];
    const bx = d[4] - d[0];
    const by = d[5] - d[1];
    const determinant = ax * by - ay * bx;
    if (Math.abs(determinant) < 1e-14) {
      continue;
    }
    const px = x - d[0];
    const py = y - d[1];
    const wb = (px * by - py * bx) / determinant;
    const wc = (ax * py - ay * px) / determinant;
    const wa = 1 - wb - wc;
    // How far outside the triangle the point is (0 inside): the nearest
    // triangle serves for points on the decal's edge.
    const outside = Math.max(0, -wa) + Math.max(0, -wb) + Math.max(0, -wc);
    if (outside < bestOutside) {
      bestOutside = outside;
      best = triangle;
    }
    if (outside === 0) {
      break;
    }
  }
  if (best === null || bestOutside > 1e-6) {
    return null;
  }
  const d = best.decal;
  const p = best.page;
  // Affine map: page = p0 + M (decal - d0), from the two edge vectors.
  const ax = d[2] - d[0];
  const ay = d[3] - d[1];
  const bx = d[4] - d[0];
  const by = d[5] - d[1];
  const determinant = ax * by - ay * bx;
  const ux = p[2] - p[0];
  const uy = p[3] - p[1];
  const vx = p[4] - p[0];
  const vy = p[5] - p[1];
  // M [a b] = [u v]  =>  M = [u v] [a b]^-1
  const m00 = (ux * by - vx * ay) / determinant;
  const m01 = (vx * ax - ux * bx) / determinant;
  const m10 = (uy * by - vy * ay) / determinant;
  const m11 = (vy * ax - uy * bx) / determinant;
  const dx = x - d[0];
  const dy = y - d[1];
  return { x: p[0] + m00 * dx + m01 * dy, y: p[1] + m10 * dx + m11 * dy, map: [m00, m01, m10, m11] };
}

// Re-export for the app: the band type.
export type { Band };
