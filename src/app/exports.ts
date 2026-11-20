// The exports besides the cut file (brief v1 4.6): the placement sheet, a
// picture of the 3D view, the whole flat page as SVG, and the rocket with
// its livery as a glTF model.

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Artwork, Matrix2 } from '../geometry/artwork.ts';
import { sizeMatrix, transformSubpath } from '../geometry/artwork.ts';
import { formatNumber, subpathData, vinylName, vinylOf } from '../geometry/cut-export.ts';
import type { PageView } from '../geometry/page.ts';
import { decalPageTriangles, pagePieceOf, surfaceToPage } from '../geometry/page.ts';
import { rollOf, stationOf, surfaceExtent, triangleKey } from '../geometry/page-strip.ts';
import type { DecalPageShape, PageToSheet } from '../geometry/page-svg.ts';
import { decalOutlines, decalSvg, escapeXml, islandLabelsSvg, pagePartsSvg } from '../geometry/page-svg.ts';
import type { Surface } from '../geometry/geodesic.ts';
import { pieceIndex } from '../geometry/geodesic.ts';
import type { AssemblyDocument } from '../model/document.ts';
import { findPlaced, subtreeIds } from '../model/document.ts';
import type { Decal } from '../model/decals.ts';
import { cutPieceSources } from '../model/cut-pieces.ts';
import type { Editor } from './editor.ts';
import type { PagePane } from './page-pane.ts';

const partGrey = '#c9c9ce';

// The page and the decals on it, as the exports need them.
interface PageDecal {
  decal: Decal;
  shapes: DecalPageShape[];
}

function colourOf(doc: AssemblyDocument, placedId: string): string {
  const colour = doc.partColours[placedId];
  if (colour === undefined) {
    return partGrey;
  }
  return colour;
}

function pageDecals(editor: Editor, view: PageView): PageDecal[] {
  const doc = editor.document;
  const result: PageDecal[] = [];
  for (let i = 0; i < doc.decals.length; i++) {
    const decal = doc.decals[i];
    if (decal.hidden) {
      continue;
    }
    const grid = editor.decals.gridOf(decal.id);
    const artwork = editor.decals.artworks.get(decal.artworkId);
    if (grid === null || artwork === undefined) {
      continue;
    }
    const triangles = decalPageTriangles(view, grid);
    result.push({ decal: decal, shapes: decalOutlines(grid, triangles, artwork, decal) });
  }
  return result;
}

function svgOpen(width: number, height: number): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + formatNumber(width) + 'mm" height="' + formatNumber(height) + 'mm" viewBox="0 0 ' + formatNumber(width) + ' ' + formatNumber(height) + '">\n';
}

// ---------------------------------------------------------------------------
// The whole flat page, 1:1 in mm.

export function pageSvg(editor: Editor, pane: PagePane): string | null {
  const view = pane.view;
  if (view === null) {
    return null;
  }
  const page = view.page;
  const margin = 10;
  const width = page.maxX - page.minX + 2 * margin;
  const height = page.maxY - page.minY + 2 * margin;
  const map: PageToSheet = { scale: 1, minX: page.minX, maxY: page.maxY, left: margin, top: margin };
  const doc = editor.document;
  const lines: string[] = [svgOpen(width, height)];
  lines.push('<rect x="0" y="0" width="' + formatNumber(width) + '" height="' + formatNumber(height) + '" fill="#ffffff"/>');
  lines.push(
    pagePartsSvg(
      view,
      map,
      function colour(placedId: string) {
        return colourOf(doc, placedId);
      },
      0.2,
    ),
  );
  const decals = pageDecals(editor, view);
  for (let i = 0; i < decals.length; i++) {
    lines.push('<g id="' + escapeXml(decals[i].decal.id) + '">');
    lines.push(decalSvg(decals[i].shapes, map, 0.05));
    lines.push('</g>');
  }
  lines.push(islandLabelsSvg(view, map, 4));
  lines.push('</svg>\n');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The placement sheet.

export type Paper = 'A4' | 'A3';
export type Datum = 'aft' | 'nose';

const paperSizes: Record<Paper, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
};
// Scales the drawing may be at (1:n).
const scales = [1, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];

export interface PlacementRow {
  number: number;
  name: string;
  width: number;
  height: number;
  // Station of the centre from the datum (mm), one per distinct value.
  stations: number[];
  // Where round the rocket: roll angles from the seam, or fin and side.
  place: string;
  quantity: number;
  vinyl: string[];
  artwork: Artwork;
  decal: Decal;
  members: Decal[];
}

// Rows of the table: one per piece of vinyl (linked copies together).
export function placementRows(editor: Editor, view: PageView, datum: Datum): PlacementRow[] {
  const doc = editor.document;
  const surface = editor.decals.surfaceFor(doc);
  const sources = cutPieceSources(doc, editor.decals.artworks);
  // The datum: the aft end or the nose tip of the parts on the body.
  const onBody = bodySurface(doc, surface);
  const extent = surfaceExtent(onBody.pieces.length > 0 ? onBody : surface);
  const seamRoll = view.roll + Math.PI;
  const rows: PlacementRow[] = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const stations: number[] = [];
    const rolls: number[] = [];
    const islands: string[] = [];
    for (let k = 0; k < source.decals.length; k++) {
      const decal = source.decals[k];
      const station = stationOf(decal.anchor.position);
      let fromDatum = extent.last - station;
      if (datum === 'nose') {
        fromDatum = station - extent.first;
      }
      const rounded = Math.round(fromDatum * 2) / 2;
      if (stations.indexOf(rounded) < 0) {
        stations.push(rounded);
      }
      const island = islandOf(view, decal);
      if (island !== null) {
        islands.push(island);
        continue;
      }
      let turn = rollOf(decal.anchor.position) - seamRoll;
      turn = ((turn % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      rolls.push(Math.round((turn * 180) / Math.PI) % 360);
    }
    stations.sort(function ascending(a, b) {
      return a - b;
    });
    rolls.sort(function ascending(a, b) {
      return a - b;
    });
    const places: string[] = [];
    for (let k = 0; k < rolls.length; k++) {
      places.push(String(rolls[k]) + '°');
    }
    const finText = compactIslands(islands);
    if (finText !== '') {
      places.push(finText);
    }
    const vinyl: string[] = [];
    const shapes = source.piece.artwork.shapes;
    for (let s = 0; s < shapes.length; s++) {
      const name = vinylName(vinylOf(source.piece, shapes[s].colour));
      if (vinyl.indexOf(name) < 0) {
        vinyl.push(name);
      }
    }
    rows.push({
      number: i + 1,
      name: source.piece.name,
      width: source.piece.width,
      height: source.piece.height,
      stations: stations,
      place: places.join(', '),
      quantity: source.piece.quantity,
      vinyl: vinyl,
      artwork: source.piece.artwork,
      decal: source.decals[0],
      members: source.decals,
    });
  }
  return rows;
}

function bodySurface(doc: AssemblyDocument, surface: Surface): Surface {
  if (doc.rootId === null || findPlaced(doc, doc.rootId) === null) {
    return { pieces: [] };
  }
  const ids = subtreeIds(doc, doc.rootId);
  const pieces = [];
  for (let i = 0; i < surface.pieces.length; i++) {
    if (ids.indexOf(surface.pieces[i].placedId) >= 0) {
      pieces.push(surface.pieces[i]);
    }
  }
  return { pieces: pieces };
}

// The label of the island a decal's anchor is on ("fin 2 · left"), or
// null if it is on the strip.
function islandOf(view: PageView, decal: Decal): string | null {
  const page = view.page;
  const piece = pagePieceOf(page, decal.anchor.placedId);
  if (piece < 0) {
    return null;
  }
  const key = triangleKey(piece, decal.anchor.triangle);
  if (page.strip.index.has(key)) {
    return null;
  }
  const onIsland = page.islandTriangles.get(key);
  if (onIsland === undefined) {
    return null;
  }
  return page.islands[onIsland[0]].label;
}

// "fin 1 · left", "fin 2 · left" -> "fin 1, 2 · left".
function compactIslands(labels: string[]): string {
  const groups: Array<{ prefix: string; suffix: string; numbers: string[] }> = [];
  const others: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const match = /^(.*) (\d+)( · .*)?$/.exec(labels[i]);
    if (match === null) {
      if (others.indexOf(labels[i]) < 0) {
        others.push(labels[i]);
      }
      continue;
    }
    const prefix = match[1];
    const suffix = match[3] === undefined ? '' : match[3];
    let group = null;
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].prefix === prefix && groups[g].suffix === suffix) {
        group = groups[g];
      }
    }
    if (group === null) {
      group = { prefix: prefix, suffix: suffix, numbers: [] };
      groups.push(group);
    }
    if (group.numbers.indexOf(match[2]) < 0) {
      group.numbers.push(match[2]);
    }
  }
  const parts: string[] = [];
  for (let g = 0; g < groups.length; g++) {
    groups[g].numbers.sort(function ascending(a, b) {
      return Number(a) - Number(b);
    });
    parts.push(groups[g].prefix + ' ' + groups[g].numbers.join(', ') + groups[g].suffix);
  }
  for (let i = 0; i < others.length; i++) {
    parts.push(others[i]);
  }
  return parts.join('; ');
}

// Where a decal's centre shows on the page (one or two places).
function centresOnPage(editor: Editor, view: PageView, decal: Decal): Array<{ x: number; y: number }> {
  const surface = editor.decals.surfaceFor(editor.document);
  const piece = pieceIndex(surface, decal.anchor.placedId);
  const pagePiece = pagePieceOf(view.page, decal.anchor.placedId);
  if (piece < 0 || pagePiece < 0 || view.page.surface.pieces[pagePiece].mesh !== surface.pieces[piece].mesh) {
    return [];
  }
  const images = surfaceToPage(view, pagePiece, decal.anchor.triangle, decal.anchor.barycentric);
  const result: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < images.length; i++) {
    // Not in the faded band past the seam: the strip proper or an island.
    if (images[i].chart === -1 || images[i].chart === 1) {
      continue;
    }
    result.push({ x: images[i].x, y: images[i].y });
  }
  return result;
}

// A small picture of the artwork in its vinyl colours, fitted in a box.
function thumbnailSvg(artwork: Artwork, decal: Decal, left: number, top: number, size: number): string {
  const fit = Math.min(size / decal.width, size / decal.height);
  const width = decal.width * fit;
  const height = decal.height * fit;
  const sized = sizeMatrix(artwork, width, height, decal.flipX, decal.flipY);
  const moved: Matrix2 = [sized[0], sized[1], sized[2], sized[3], sized[4] + left + (size - width) / 2, sized[5] + top + (size - height) / 2];
  const lines: string[] = ['<rect x="' + formatNumber(left) + '" y="' + formatNumber(top) + '" width="' + formatNumber(size) + '" height="' + formatNumber(size) + '" fill="' + partGrey + '"/>'];
  for (let s = 0; s < artwork.shapes.length; s++) {
    const shape = artwork.shapes[s];
    const data: string[] = [];
    for (let k = 0; k < shape.subpaths.length; k++) {
      data.push(subpathData(transformSubpath(moved, shape.subpaths[k])));
    }
    const mapped = decal.colourMap[shape.colour];
    lines.push('<path d="' + data.join(' ') + '" fill="' + (mapped === undefined ? shape.colour : mapped) + '" fill-rule="' + shape.fillRule + '"/>');
  }
  return lines.join('\n');
}

function text(x: number, y: number, size: number, content: string, extra: string): string {
  return '<text x="' + formatNumber(x) + '" y="' + formatNumber(y) + '" font-family="sans-serif" font-size="' + formatNumber(size) + '"' + extra + '>' + escapeXml(content) + '</text>';
}

export interface PlacementSheet {
  svg: string;
  width: number;
  height: number;
  scale: number;
  rows: PlacementRow[];
}

// One SVG: the page drawn to fit the paper (landscape) at a stated scale,
// each decal numbered on it, and the table below.
export function placementSheet(editor: Editor, pane: PagePane, paper: Paper, datum: Datum): PlacementSheet | null {
  const view = pane.view;
  if (view === null) {
    return null;
  }
  const page = view.page;
  const size = paperSizes[paper];
  const sheetWidth = size[0];
  const sheetHeight = size[1];
  const margin = 10;
  const rows = placementRows(editor, view, datum);
  const rowHeight = 8;
  const headerHeight = 6;
  const titleHeight = 9;
  const tableHeight = headerHeight + rows.length * rowHeight;
  const drawWidth = sheetWidth - 2 * margin;
  const drawHeight = Math.max(30, sheetHeight - 2 * margin - titleHeight - tableHeight - 6);
  const pageWidth = page.maxX - page.minX;
  const pageHeight = page.maxY - page.minY;
  let scale = scales[scales.length - 1];
  for (let i = 0; i < scales.length; i++) {
    if (pageWidth / scales[i] <= drawWidth && pageHeight / scales[i] <= drawHeight) {
      scale = scales[i];
      break;
    }
  }
  const factor = 1 / scale;
  const drawTop = margin + titleHeight;
  const map: PageToSheet = {
    scale: factor,
    minX: page.minX,
    maxY: page.maxY,
    left: margin + (drawWidth - pageWidth * factor) / 2,
    top: drawTop + (drawHeight - pageHeight * factor) / 2,
  };
  const doc = editor.document;
  const lines: string[] = [svgOpen(sheetWidth, sheetHeight)];
  lines.push('<rect x="0" y="0" width="' + formatNumber(sheetWidth) + '" height="' + formatNumber(sheetHeight) + '" fill="#ffffff"/>');
  // Title: what it is, the scale, the datum, the seam.
  const datumText = datum === 'aft' ? 'stations from the aft end' : 'stations from the nose tip';
  lines.push(text(margin, margin + 4, 4.2, 'Placement', ' font-weight="bold" fill="#000000"'));
  lines.push(text(margin + 26, margin + 4, 3, 'Scale 1:' + formatNumber(scale) + ' · ' + datumText + ' · angles round from the seam (the bottom edge of the strip, going up it) · mm', ' fill="#333333"'));
  // A scale bar: 100 mm on the rocket.
  let bar = 100;
  if (bar * factor > 60) {
    bar = 50;
  }
  const barRight = sheetWidth - margin;
  const barLeft = barRight - bar * factor;
  lines.push('<path d="M' + formatNumber(barLeft) + ' ' + formatNumber(margin + 3) + ' L' + formatNumber(barRight) + ' ' + formatNumber(margin + 3) + ' M' + formatNumber(barLeft) + ' ' + formatNumber(margin + 1.5) + ' L' + formatNumber(barLeft) + ' ' + formatNumber(margin + 4.5) + ' M' + formatNumber(barRight) + ' ' + formatNumber(margin + 1.5) + ' L' + formatNumber(barRight) + ' ' + formatNumber(margin + 4.5) + '" stroke="#000000" stroke-width="0.3" fill="none"/>');
  lines.push(text(barLeft - 2, margin + 4, 2.6, String(bar) + ' mm', ' text-anchor="end" fill="#333333"'));
  // The page.
  lines.push(
    pagePartsSvg(
      view,
      map,
      function colour(placedId: string) {
        return colourOf(doc, placedId);
      },
      0.12,
    ),
  );
  const decals = pageDecals(editor, view);
  for (let i = 0; i < decals.length; i++) {
    lines.push(decalSvg(decals[i].shapes, map, 0.04));
  }
  lines.push(islandLabelsSvg(view, map, 2.2));
  // Numbers on every copy of each piece.
  for (let r = 0; r < rows.length; r++) {
    for (let m = 0; m < rows[r].members.length; m++) {
      const centres = centresOnPage(editor, view, rows[r].members[m]);
      for (let c = 0; c < centres.length; c++) {
        const x = map.left + (centres[c].x - map.minX) * factor;
        const y = map.top + (map.maxY - centres[c].y) * factor;
        lines.push('<circle cx="' + formatNumber(x) + '" cy="' + formatNumber(y) + '" r="2.1" fill="#ffffff" stroke="#000000" stroke-width="0.25"/>');
        lines.push(text(x, y + 0.95, 2.6, String(rows[r].number), ' text-anchor="middle" font-weight="bold" fill="#000000"'));
      }
    }
  }
  // The table.
  const tableTop = sheetHeight - margin - tableHeight;
  const columns = [
    { title: 'No.', x: 0 },
    { title: '', x: 9 },
    { title: 'Name', x: 19 },
    { title: 'Size (mm)', x: 74 },
    { title: datum === 'aft' ? 'From aft end (mm)' : 'From nose tip (mm)', x: 104 },
    { title: 'Round from seam / fin', x: 140 },
    { title: 'Qty', x: drawWidth - 52 },
    { title: 'Vinyl', x: drawWidth - 40 },
  ];
  for (let c = 0; c < columns.length; c++) {
    lines.push(text(margin + columns[c].x, tableTop + 4, 2.8, columns[c].title, ' font-weight="bold" fill="#000000"'));
  }
  lines.push('<path d="M' + formatNumber(margin) + ' ' + formatNumber(tableTop + headerHeight) + ' L' + formatNumber(sheetWidth - margin) + ' ' + formatNumber(tableTop + headerHeight) + '" stroke="#000000" stroke-width="0.25"/>');
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const top = tableTop + headerHeight + r * rowHeight;
    const baseline = top + rowHeight / 2 + 1.1;
    lines.push(text(margin + columns[0].x, baseline, 3, String(row.number), ' font-weight="bold" fill="#000000"'));
    lines.push(thumbnailSvg(row.artwork, row.decal, margin + columns[1].x, top + 1, rowHeight - 2));
    lines.push(text(margin + columns[2].x, baseline, 3, row.name, ' fill="#000000"'));
    lines.push(text(margin + columns[3].x, baseline, 3, formatNumber(Math.round(row.width * 10) / 10) + ' × ' + formatNumber(Math.round(row.height * 10) / 10), ' fill="#000000"'));
    const stationTexts: string[] = [];
    for (let k = 0; k < row.stations.length; k++) {
      stationTexts.push(formatNumber(row.stations[k]));
    }
    lines.push(text(margin + columns[4].x, baseline, 3, stationTexts.join(', '), ' fill="#000000"'));
    lines.push(text(margin + columns[5].x, baseline, 3, row.place, ' fill="#000000"'));
    lines.push(text(margin + columns[6].x, baseline, 3, '×' + String(row.quantity), ' fill="#000000"'));
    lines.push(text(margin + columns[7].x, baseline, 3, row.vinyl.join(', '), ' fill="#000000"'));
    lines.push('<path d="M' + formatNumber(margin) + ' ' + formatNumber(top + rowHeight) + ' L' + formatNumber(sheetWidth - margin) + ' ' + formatNumber(top + rowHeight) + '" stroke="#cccccc" stroke-width="0.15"/>');
  }
  lines.push('</svg>\n');
  return { svg: lines.join('\n'), width: sheetWidth, height: sheetHeight, scale: scale, rows: rows };
}

// The sheet in a page of its own, sized for the paper, that prints itself
// (the browser's print dialog saves it as PDF).
export function printablePage(sheet: PlacementSheet, paper: Paper): string {
  return (
    '<!doctype html>\n<html><head><meta charset="utf-8"><title>DC6 placement sheet</title>\n' +
    '<style>@page { size: ' +
    paper +
    ' landscape; margin: 0; } html, body { margin: 0; background: #ffffff; } svg { display: block; width: ' +
    String(sheet.width) +
    'mm; height: ' +
    String(sheet.height) +
    'mm; }</style></head>\n<body>\n' +
    sheet.svg +
    '<script>window.addEventListener("load", function () { window.print(); });</script>\n</body></html>\n'
  );
}

// ---------------------------------------------------------------------------
// The rocket with its livery, for renders: the visible parts and the
// decal meshes with their textures, as they are drawn. glTF is in metres.

export function modelGlb(editor: Editor): Promise<Blob> {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = 'rocket';
  root.scale.set(0.001, 0.001, 0.001);
  scene.add(root);
  const parts = editor.visibleMeshes();
  for (let i = 0; i < parts.length; i++) {
    const colour = parts[i].colour;
    const material = new THREE.MeshStandardMaterial({ color: colour === null ? 0x9b9ba0 : colour, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(parts[i].geometry, material);
    const p = parts[i].transform.position;
    const q = parts[i].transform.rotation;
    mesh.position.set(p[0], p[1], p[2]);
    mesh.quaternion.set(q[0], q[1], q[2], q[3]);
    mesh.name = 'part ' + String(i + 1);
    root.add(mesh);
  }
  const decals = editor.decals.visibleMeshes();
  for (let i = 0; i < decals.length; i++) {
    const material = new THREE.MeshStandardMaterial({ map: decals[i].texture, transparent: true, roughness: 0.45, metalness: 0, alphaTest: 0.01 });
    const mesh = new THREE.Mesh(decals[i].geometry, material);
    mesh.name = 'decal ' + String(i + 1);
    root.add(mesh);
  }
  const exporter = new GLTFExporter();
  return new Promise<Blob>(function run(resolve, reject) {
    exporter.parse(
      scene,
      function done(result) {
        if (result instanceof ArrayBuffer) {
          resolve(new Blob([result], { type: 'model/gltf-binary' }));
        } else {
          resolve(new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }));
        }
      },
      function failed(error) {
        reject(error);
      },
      { binary: true },
    );
  });
}
