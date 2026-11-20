// The flat page as vector drawing: the parts laid flat, and each decal's
// artwork carried onto the page through its mapped grid, as outlines. Used
// by the page export (1:1 mm) and the placement sheet (scaled down).
//
// A decal is drawn on the page by its grid: each grid cell's triangles go
// to the page affinely (page.ts, decalPageTriangles). An artwork outline is
// flattened to short straight steps (shorter than a grid cell, so it bends
// with the map), and each step's end is carried through the triangle of
// the grid it falls in. Where an outline runs off the page (off the edge of
// the strip onto a fin, or past the repeat band) it is cut there and goes
// on where it comes back; such a broken outline is drawn as a line, not
// filled.

import type { Artwork, FillRule } from './artwork.ts';
import { flattenSubpath, sizeMatrix, transformSubpath } from './artwork.ts';
import type { DecalGrid } from './decal-map.ts';
import type { DecalPageTriangle, PageView } from './page.ts';
import { formatNumber } from './cut-export.ts';

// How closely curves are followed (mm), and the longest straight step.
const flattenTolerance = 0.05;

export interface PageOutline {
  // x, y pairs on the page (mm, y up).
  points: number[];
  closed: boolean;
}

export interface DecalPageShape {
  colour: string;
  fillRule: FillRule;
  outlines: PageOutline[];
}

interface CellIndex {
  grid: DecalGrid;
  // "copy|i|j" -> triangles of that cell in that drawing.
  cells: Map<string, DecalPageTriangle[]>;
  copies: number[];
}

// The grid cell a decal-frame coordinate falls in (index of the line
// below it), clamped to the grid.
function cellOf(lines: number[], value: number): number {
  let low = 0;
  let high = lines.length - 2;
  if (high < 0) {
    return 0;
  }
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (lines[middle] <= value) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function indexTriangles(grid: DecalGrid, triangles: DecalPageTriangle[]): CellIndex {
  const cells = new Map<string, DecalPageTriangle[]>();
  const copies: number[] = [];
  for (let t = 0; t < triangles.length; t++) {
    const triangle = triangles[t];
    const d = triangle.decal;
    const middleX = (d[0] + d[2] + d[4]) / 3;
    const middleY = (d[1] + d[3] + d[5]) / 3;
    const i = cellOf(grid.xs, middleX);
    const j = cellOf(grid.ys, middleY);
    const key = String(triangle.copy) + '|' + String(i) + '|' + String(j);
    let list = cells.get(key);
    if (list === undefined) {
      list = [];
      cells.set(key, list);
    }
    list.push(triangle);
    if (copies.indexOf(triangle.copy) < 0) {
      copies.push(triangle.copy);
    }
  }
  return { grid: grid, cells: cells, copies: copies };
}

// A decal-frame point carried to the page in one drawing, or null.
function carry(index: CellIndex, copy: number, x: number, y: number): [number, number] | null {
  const i = cellOf(index.grid.xs, x);
  const j = cellOf(index.grid.ys, y);
  const list = index.cells.get(String(copy) + '|' + String(i) + '|' + String(j));
  if (list === undefined) {
    return null;
  }
  let best: DecalPageTriangle | null = null;
  let bestOutside = Infinity;
  let weights: [number, number, number] = [0, 0, 0];
  for (let t = 0; t < list.length; t++) {
    const d = list[t].decal;
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
    const outside = Math.max(0, -wa) + Math.max(0, -wb) + Math.max(0, -wc);
    if (outside < bestOutside) {
      bestOutside = outside;
      best = list[t];
      weights = [wa, wb, wc];
    }
  }
  // A point in a cell whose other triangle is missing (the edge of a hole)
  // is left out, unless it is only a hair outside the one there.
  if (best === null || bestOutside > 1e-3) {
    return null;
  }
  const p = best.page;
  return [weights[0] * p[0] + weights[1] * p[2] + weights[2] * p[4], weights[0] * p[1] + weights[1] * p[3] + weights[2] * p[5]];
}

// The decal's artwork as outlines on the page, shape by shape in painting
// order, every drawing of it (both sides of the seam).
export function decalOutlines(
  grid: DecalGrid,
  triangles: DecalPageTriangle[],
  artwork: Artwork,
  decal: { width: number; height: number; flipX: boolean; flipY: boolean; colourMap: Record<string, string> },
): DecalPageShape[] {
  const index = indexTriangles(grid, triangles);
  const sized = sizeMatrix(artwork, decal.width, decal.height, decal.flipX, decal.flipY);
  // Steps no longer than half a grid cell, so outlines bend with the map.
  let cell = Infinity;
  for (let i = 0; i + 1 < grid.xs.length; i++) {
    cell = Math.min(cell, grid.xs[i + 1] - grid.xs[i]);
  }
  for (let j = 0; j + 1 < grid.ys.length; j++) {
    cell = Math.min(cell, grid.ys[j + 1] - grid.ys[j]);
  }
  const step = Number.isFinite(cell) ? cell / 2 : 1;
  const shapes: DecalPageShape[] = [];
  for (let s = 0; s < artwork.shapes.length; s++) {
    const shape = artwork.shapes[s];
    const mapped = decal.colourMap[shape.colour];
    const outlines: PageOutline[] = [];
    for (let k = 0; k < shape.subpaths.length; k++) {
      const ring = flattenSubpath(transformSubpath(sized, shape.subpaths[k]), flattenTolerance);
      if (ring.length < 2) {
        continue;
      }
      // Decal frame: origin at the centre, y up.
      const frame: Array<[number, number]> = [];
      for (let q = 0; q < ring.length; q++) {
        const a = ring[q];
        const b = ring[(q + 1) % ring.length];
        const ax = a[0] - decal.width / 2;
        const ay = decal.height / 2 - a[1];
        const bx = b[0] - decal.width / 2;
        const by = decal.height / 2 - b[1];
        const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let n = 0; n < pieces; n++) {
          const f = n / pieces;
          frame.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
        }
      }
      for (let c = 0; c < index.copies.length; c++) {
        const copy = index.copies[c];
        const runs: number[][] = [];
        let run: number[] = [];
        let first = -1;
        for (let q = 0; q < frame.length; q++) {
          const p = carry(index, copy, frame[q][0], frame[q][1]);
          if (p === null) {
            if (run.length > 0) {
              runs.push(run);
              run = [];
            }
            continue;
          }
          if (first < 0) {
            first = q;
          }
          run.push(p[0], p[1]);
        }
        if (run.length > 0) {
          runs.push(run);
        }
        if (runs.length === 0) {
          continue;
        }
        if (runs.length === 1 && first === 0 && runs[0].length === frame.length * 2) {
          outlines.push({ points: runs[0], closed: true });
          continue;
        }
        // Broken: the last run carries on into the first if the outline
        // was whole across its start.
        if (runs.length > 1 && first === 0 && carry(index, copy, frame[frame.length - 1][0], frame[frame.length - 1][1]) !== null) {
          const last = runs.pop() as number[];
          runs[0] = last.concat(runs[0]);
        }
        for (let r = 0; r < runs.length; r++) {
          if (runs[r].length >= 4) {
            outlines.push({ points: runs[r], closed: false });
          }
        }
      }
    }
    shapes.push({ colour: mapped === undefined ? shape.colour : mapped, fillRule: shape.fillRule, outlines: outlines });
  }
  return shapes;
}

// ---------------------------------------------------------------------------
// SVG.

// Page mm to drawing units: x' = scale (x - minX) + left, y' = scale (maxY - y) + top.
export interface PageToSheet {
  scale: number;
  minX: number;
  maxY: number;
  left: number;
  top: number;
}

function sheetX(map: PageToSheet, x: number): string {
  return formatNumber(map.left + (x - map.minX) * map.scale);
}

function sheetY(map: PageToSheet, y: number): string {
  return formatNumber(map.top + (map.maxY - y) * map.scale);
}

function polylineData(map: PageToSheet, points: number[], closed: boolean): string {
  const parts: string[] = [];
  for (let q = 0; q < points.length; q = q + 2) {
    parts.push((q === 0 ? 'M' : 'L') + sheetX(map, points[q]) + ' ' + sheetY(map, points[q + 1]));
  }
  if (closed) {
    parts.push('Z');
  }
  return parts.join(' ');
}

function segmentsData(map: PageToSheet, segments: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i = i + 4) {
    parts.push('M' + sheetX(map, segments[i]) + ' ' + sheetY(map, segments[i + 1]) + ' L' + sheetX(map, segments[i + 2]) + ' ' + sheetY(map, segments[i + 3]));
  }
  return parts.join(' ');
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The parts laid flat: each part's faces filled in its colour, then the
// outline, joints and seam. Faces of the faded repeat band are lighter.
export function pagePartsSvg(view: PageView, map: PageToSheet, colourOf: (placedId: string) => string, lineWidth: number): string {
  const page = view.page;
  const byPart = new Map<string, { strip: string[]; repeat: string[] }>();
  for (let f = 0; f < view.faces.length; f++) {
    const face = view.faces[f];
    const placedId = page.placedIds[face.piece];
    let entry = byPart.get(placedId);
    if (entry === undefined) {
      entry = { strip: [], repeat: [] };
      byPart.set(placedId, entry);
    }
    const data = polylineData(map, face.polygon, true);
    if (face.chart === -1 || face.chart === 1) {
      entry.repeat.push(data);
    } else {
      entry.strip.push(data);
    }
  }
  const lines: string[] = [];
  byPart.forEach(function draw(entry, placedId) {
    const colour = colourOf(placedId);
    if (entry.repeat.length > 0) {
      lines.push('<path d="' + entry.repeat.join(' ') + '" fill="' + colour + '" fill-opacity="0.35" stroke="none"/>');
    }
    if (entry.strip.length > 0) {
      // A hairline in the fill colour closes the gaps anti-aliasing leaves between triangles.
      lines.push('<path d="' + entry.strip.join(' ') + '" fill="' + colour + '" stroke="' + colour + '" stroke-width="' + formatNumber(lineWidth * 0.5) + '" stroke-linejoin="round"/>');
    }
  });
  const outline: number[] = view.outline.slice();
  for (let i = 0; i < page.islands.length; i++) {
    const island = page.islands[i];
    for (let q = 0; q < island.boundary.length; q = q + 2) {
      outline.push(island.boundary[q] + island.offsetX, island.boundary[q + 1] + island.offsetY);
    }
  }
  lines.push('<path d="' + segmentsData(map, outline) + ' ' + segmentsData(map, view.seams) + '" fill="none" stroke="#3a3a40" stroke-width="' + formatNumber(lineWidth) + '" stroke-linecap="round"/>');
  if (view.joints.length > 0) {
    lines.push('<path d="' + segmentsData(map, view.joints) + '" fill="none" stroke="#3a3a40" stroke-opacity="0.4" stroke-width="' + formatNumber(lineWidth) + '"/>');
  }
  if (view.repeatEdges.length > 0) {
    lines.push('<path d="' + segmentsData(map, view.repeatEdges) + '" fill="none" stroke="#3a3a40" stroke-opacity="0.5" stroke-dasharray="' + formatNumber(lineWidth * 4) + ' ' + formatNumber(lineWidth * 4) + '" stroke-width="' + formatNumber(lineWidth) + '"/>');
  }
  return lines.join('\n');
}

// A decal's outlines, filled in their vinyl colour with the artwork's fill
// rule. An outline broken where it leaves the page (at a seam or the edge
// of an island) is closed with a straight line across the cut, which
// follows that edge closely enough to show the piece filled.
export function decalSvg(shapes: DecalPageShape[], map: PageToSheet, lineWidth: number): string {
  const lines: string[] = [];
  for (let s = 0; s < shapes.length; s++) {
    const shape = shapes[s];
    const closed: string[] = [];
    const open: string[] = [];
    for (let k = 0; k < shape.outlines.length; k++) {
      const outline = shape.outlines[k];
      if (outline.closed) {
        closed.push(polylineData(map, outline.points, true));
      } else {
        open.push(polylineData(map, outline.points, true));
      }
    }
    const all = closed.concat(open);
    if (all.length > 0) {
      lines.push('<path d="' + all.join(' ') + '" fill="' + shape.colour + '" fill-rule="' + shape.fillRule + '" stroke="' + shape.colour + '" stroke-width="' + formatNumber(lineWidth) + '" stroke-linejoin="round"/>');
    }
  }
  return lines.join('\n');
}

// The island labels, beside each island away from the strip.
export function islandLabelsSvg(view: PageView, map: PageToSheet, size: number): string {
  const lines: string[] = [];
  const page = view.page;
  for (let i = 0; i < page.islands.length; i++) {
    const island = page.islands[i];
    const x = (island.minX + island.maxX) / 2 + island.offsetX;
    let y = 0;
    let shift = 0;
    if (island.labelSide > 0) {
      y = island.maxY + island.offsetY;
      shift = -size * 0.5;
    } else {
      y = island.minY + island.offsetY;
      shift = size * 1.2;
    }
    lines.push('<text x="' + sheetX(map, x) + '" y="' + formatNumber(Number(sheetY(map, y)) + shift) + '" font-family="sans-serif" font-size="' + formatNumber(size) + '" fill="#55555b" text-anchor="middle">' + escapeXml(island.label) + '</text>');
  }
  return lines.join('\n');
}
