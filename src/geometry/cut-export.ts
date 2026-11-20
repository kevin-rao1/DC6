// The cut file: each decal's artwork at its set size, 1:1 in millimetres,
// one closed outline per piece of vinyl.
//
// Nothing is flattened here: a decal is applied to the rocket as the flat
// piece it is (decal-map.ts lays exactly that piece onto the surface), so
// the cut outline is the artwork at its set size, flipped if the decal is
// flipped. Curves stay curves.
//
// The file is as plain as SVG gets, for an outside cutting service with
// unknown software: width and height in mm with a matching viewBox,
// absolute path data, no transforms, no CSS, no clip paths, no <use>, no
// fill, a hairline stroke. Colours are either one file each, or one file
// with a plain <g id> per colour (with Inkscape layer attributes, which
// other programs ignore).
//
// Labels are plain <text>, not paths: a label drawn as paths would be cut
// into the vinyl along with the piece; cutter software shows text for the
// operator and does not cut it (and if it drops text, nothing is lost but
// the label).

import type { Artwork, Matrix2, Point2, Segment, Shape, Subpath } from './artwork.ts';
import { flattenSubpath, multiplyMatrix, sizeMatrix, transformSubpath } from './artwork.ts';
import type { Region, Ring } from './polygon-boolean.ts';
import { booleanRings } from './polygon-boolean.ts';

export interface CutPiece {
  name: string;
  artwork: Artwork;
  width: number;
  height: number;
  flipX: boolean;
  flipY: boolean;
  // Artwork colour -> vinyl colour; colours not listed are cut as they are.
  colourMap: Record<string, string>;
  // How many of this piece to cut (linked copies of one decal are one
  // outline, cut that many times). The label says so when more than one.
  quantity: number;
}

// The label under a piece: its name, and the quantity when more than one.
export function pieceLabel(piece: CutPiece): string {
  if (piece.quantity > 1) {
    return piece.name + ' ×' + String(piece.quantity);
  }
  return piece.name;
}

export interface CutOptions {
  files: 'per-colour' | 'layers';
  overlaps: 'layered' | 'knockout';
}

export interface CutFile {
  fileName: string;
  text: string;
}

// Layout of the sheet, mm.
const margin = 10;
const gap = 10;
const labelGap = 2;
const labelSize = 3;
const rowWidthLimit = 600;
// A hairline: thin enough that the cutting software takes it as a cut line.
const hairline = 0.025;
// How closely curves are followed when they have to be flattened (knockout).
const flattenTolerance = 0.01;

const vinylNames: Record<string, string> = {
  '#e64097': 'cerise',
  '#000000': 'black',
};

export function vinylName(colour: string): string {
  const known = vinylNames[colour];
  if (known !== undefined) {
    return known;
  }
  return colour.replace('#', '');
}

export function vinylOf(piece: CutPiece, artworkColour: string): string {
  const mapped = piece.colourMap[artworkColour];
  if (mapped === undefined) {
    return artworkColour;
  }
  return mapped;
}

// Numbers with at most three decimals (a micrometre), no trailing zeros.
export function formatNumber(value: number): string {
  let text = value.toFixed(3);
  if (text.indexOf('.') >= 0) {
    text = text.replace(/0+$/, '').replace(/\.$/, '');
  }
  if (text === '-0') {
    text = '0';
  }
  return text;
}

function formatPoint(p: Point2): string {
  return formatNumber(p[0]) + ' ' + formatNumber(p[1]);
}

// Absolute path data: M, L, C, Z only.
export function subpathData(subpath: Subpath): string {
  const parts: string[] = ['M' + formatPoint(subpath.start)];
  // The last segment returns to the start; a closing straight line is
  // written as Z alone.
  const segments: Segment[] = subpath.segments;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment.kind === 'line') {
      if (last) {
        continue;
      }
      parts.push('L' + formatPoint(segment.to));
    } else {
      parts.push('C' + formatPoint(segment.c1) + ' ' + formatPoint(segment.c2) + ' ' + formatPoint(segment.to));
    }
  }
  parts.push('Z');
  return parts.join(' ');
}

export function ringData(ring: Ring): string {
  const parts: string[] = ['M' + formatPoint(ring[0])];
  for (let i = 1; i < ring.length; i++) {
    parts.push('L' + formatPoint(ring[i]));
  }
  parts.push('Z');
  return parts.join(' ');
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Placed {
  piece: CutPiece;
  x: number;
  y: number;
}

// Pieces in rows, left to right, wrapping at rowWidthLimit. No nesting.
function layout(pieces: CutPiece[]): { placed: Placed[]; width: number; height: number } {
  const placed: Placed[] = [];
  let x = margin;
  let y = margin;
  let rowHeight = 0;
  let widest = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (x > margin && x + piece.width > rowWidthLimit) {
      x = margin;
      y = y + rowHeight + gap;
      rowHeight = 0;
    }
    placed.push({ piece: piece, x: x, y: y });
    widest = Math.max(widest, x + piece.width);
    // The label sits under the piece, outside its cut line.
    rowHeight = Math.max(rowHeight, piece.height + labelGap + labelSize);
    x = x + piece.width + gap;
  }
  return { placed: placed, width: widest + margin, height: y + rowHeight + margin };
}

// The vinyl colours of a piece, lowest first: ordered by the last shape
// painted in each (a colour painted on top of another is the higher layer).
function colourOrder(piece: CutPiece): string[] {
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < piece.artwork.shapes.length; i++) {
    lastIndex.set(vinylOf(piece, piece.artwork.shapes[i].colour), i);
  }
  const colours = Array.from(lastIndex.keys());
  colours.sort(function byLast(a, b) {
    return (lastIndex.get(a) as number) - (lastIndex.get(b) as number);
  });
  return colours;
}

// The map from artwork coordinates to sheet coordinates for a placed piece.
function sheetMatrix(entry: Placed): Matrix2 {
  const sized = sizeMatrix(entry.piece.artwork, entry.piece.width, entry.piece.height, entry.piece.flipX, entry.piece.flipY);
  const moved: Matrix2 = [1, 0, 0, 1, entry.x, entry.y];
  return multiplyMatrix(moved, sized);
}

function shapeRegion(shape: Shape, matrix: Matrix2): Region {
  const rings: Ring[] = [];
  for (let k = 0; k < shape.subpaths.length; k++) {
    const placed = transformSubpath(matrix, shape.subpaths[k]);
    const ring = flattenSubpath(placed, flattenTolerance);
    if (ring.length >= 3) {
      rings.push(ring);
    }
  }
  return { rings: rings, rule: shape.fillRule };
}

// The path data of one vinyl colour of one placed piece: its shapes' own
// outlines (layered), or with every higher colour's area removed (knockout).
export function colourPaths(entry: Placed, colour: string, overlaps: 'layered' | 'knockout'): string[] {
  const piece = entry.piece;
  const matrix = sheetMatrix(entry);
  const order = colourOrder(piece);
  const position = order.indexOf(colour);
  const result: string[] = [];
  if (position < 0) {
    return result;
  }
  const higher = order.slice(position + 1);
  if (overlaps === 'layered' || higher.length === 0) {
    for (let i = 0; i < piece.artwork.shapes.length; i++) {
      const shape = piece.artwork.shapes[i];
      if (vinylOf(piece, shape.colour) !== colour) {
        continue;
      }
      const data: string[] = [];
      for (let k = 0; k < shape.subpaths.length; k++) {
        data.push(subpathData(transformSubpath(matrix, shape.subpaths[k])));
      }
      result.push(data.join(' '));
    }
    return result;
  }
  // Knockout: (union of this colour) minus (union of the higher colours).
  const regions: Region[] = [];
  const isOwn: boolean[] = [];
  for (let i = 0; i < piece.artwork.shapes.length; i++) {
    const shape = piece.artwork.shapes[i];
    const vinyl = vinylOf(piece, shape.colour);
    if (vinyl === colour) {
      regions.push(shapeRegion(shape, matrix));
      isOwn.push(true);
    } else if (higher.indexOf(vinyl) >= 0) {
      regions.push(shapeRegion(shape, matrix));
      isOwn.push(false);
    }
  }
  const rings = booleanRings(regions, function ownAndUncovered(inside: boolean[]): boolean {
    let own = false;
    let covered = false;
    for (let r = 0; r < inside.length; r++) {
      if (!inside[r]) {
        continue;
      }
      if (isOwn[r]) {
        own = true;
      } else {
        covered = true;
      }
    }
    return own && !covered;
  });
  for (let r = 0; r < rings.length; r++) {
    result.push(ringData(rings[r]));
  }
  return result;
}

function svgOpen(width: number, height: number, inkscape: boolean): string {
  let namespaces = 'xmlns="http://www.w3.org/2000/svg"';
  if (inkscape) {
    namespaces = namespaces + ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';
  }
  const w = formatNumber(width);
  const h = formatNumber(height);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg ' + namespaces + ' width="' + w + 'mm" height="' + h + 'mm" viewBox="0 0 ' + w + ' ' + h + '">\n';
}

function colourGroup(placed: Placed[], colour: string, overlaps: 'layered' | 'knockout', inkscape: boolean): string {
  const name = vinylName(colour);
  let attributes = 'id="' + escapeXml(name) + '"';
  if (inkscape) {
    attributes = attributes + ' inkscape:groupmode="layer" inkscape:label="' + escapeXml(name + ' ' + colour) + '"';
  }
  const lines: string[] = ['  <g ' + attributes + '>'];
  for (let i = 0; i < placed.length; i++) {
    const paths = colourPaths(placed[i], colour, overlaps);
    for (let k = 0; k < paths.length; k++) {
      lines.push('    <path d="' + paths[k] + '" fill="none" stroke="' + colour + '" stroke-width="' + String(hairline) + '"/>');
    }
  }
  lines.push('  </g>');
  return lines.join('\n') + '\n';
}

function labelGroup(placed: Placed[], inkscape: boolean): string {
  let attributes = 'id="labels"';
  if (inkscape) {
    attributes = attributes + ' inkscape:groupmode="layer" inkscape:label="labels"';
  }
  const lines: string[] = ['  <g ' + attributes + '>'];
  for (let i = 0; i < placed.length; i++) {
    const entry = placed[i];
    const x = formatNumber(entry.x);
    const y = formatNumber(entry.y + entry.piece.height + labelGap + labelSize * 0.8);
    lines.push('    <text x="' + x + '" y="' + y + '" font-family="sans-serif" font-size="' + String(labelSize) + '" fill="#000000">' + escapeXml(pieceLabel(entry.piece)) + '</text>');
  }
  lines.push('  </g>');
  return lines.join('\n') + '\n';
}

// All vinyl colours in the pieces, in order of first appearance.
export function vinylColours(pieces: CutPiece[]): string[] {
  const colours: string[] = [];
  for (let p = 0; p < pieces.length; p++) {
    const shapes = pieces[p].artwork.shapes;
    for (let i = 0; i < shapes.length; i++) {
      const vinyl = vinylOf(pieces[p], shapes[i].colour);
      if (colours.indexOf(vinyl) < 0) {
        colours.push(vinyl);
      }
    }
  }
  return colours;
}

function usesColour(piece: CutPiece, colour: string): boolean {
  for (let i = 0; i < piece.artwork.shapes.length; i++) {
    if (vinylOf(piece, piece.artwork.shapes[i].colour) === colour) {
      return true;
    }
  }
  return false;
}

export function cutFiles(pieces: CutPiece[], options: CutOptions): CutFile[] {
  const sheet = layout(pieces);
  const colours = vinylColours(pieces);
  const files: CutFile[] = [];
  if (options.files === 'layers') {
    let text = svgOpen(sheet.width, sheet.height, true);
    for (let c = 0; c < colours.length; c++) {
      text = text + colourGroup(sheet.placed, colours[c], options.overlaps, true);
    }
    text = text + labelGroup(sheet.placed, true);
    text = text + '</svg>\n';
    files.push({ fileName: 'dc6-cut.svg', text: text });
    return files;
  }
  // One file per colour: every file has the same sheet layout, so pieces of
  // one decal line up across the files; each file carries only the pieces
  // that use its colour, each with its label.
  for (let c = 0; c < colours.length; c++) {
    const colour = colours[c];
    const using: Placed[] = [];
    for (let i = 0; i < sheet.placed.length; i++) {
      if (usesColour(sheet.placed[i].piece, colour)) {
        using.push(sheet.placed[i]);
      }
    }
    let text = svgOpen(sheet.width, sheet.height, false);
    text = text + colourGroup(using, colour, options.overlaps, false);
    text = text + labelGroup(using, false);
    text = text + '</svg>\n';
    files.push({ fileName: 'dc6-cut-' + vinylName(colour) + '.svg', text: text });
  }
  return files;
}
