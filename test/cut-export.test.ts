import { describe, expect, it } from 'vitest';
import { booleanRings, ringsArea, insideRegion } from '../src/geometry/polygon-boolean.ts';
import type { Region } from '../src/geometry/polygon-boolean.ts';
import { cutFiles, colourPaths } from '../src/geometry/cut-export.ts';
import type { CutPiece } from '../src/geometry/cut-export.ts';
import { importSvg } from '../src/geometry/svg-import.ts';
import { parsePathData } from '../src/geometry/svg-path.ts';
import { flattenSubpath, polygonArea, sizeMatrix, transformSubpath, multiplyMatrix } from '../src/geometry/artwork.ts';
import type { Artwork, Subpath } from '../src/geometry/artwork.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function square(x: number, y: number, size: number): [number, number][] {
  return [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
}

function testArt(name: string): Artwork {
  const result = importSvg(readFileSync(join(here, '..', 'test-models', 'art', name + '.svg'), 'utf8'), name, name);
  if (result.artwork === null) {
    throw new Error('no artwork in ' + name);
  }
  return result.artwork;
}

describe('polygon boolean', () => {
  it('subtracts an overlapping square', () => {
    const a: Region = { rings: [square(0, 0, 10)], rule: 'nonzero' };
    const b: Region = { rings: [square(5, 5, 10)], rule: 'nonzero' };
    const rings = booleanRings([a, b], function aNotB(inside) {
      return inside[0] && !inside[1];
    });
    expect(Math.abs(ringsArea(rings))).toBeCloseTo(75, 9);
    expect(rings.length).toBe(1);
  });

  it('makes a hole when the cover is inside, and respects evenodd', () => {
    const a: Region = { rings: [square(0, 0, 10)], rule: 'nonzero' };
    const b: Region = { rings: [square(2, 2, 4)], rule: 'nonzero' };
    const rings = booleanRings([a, b], function aNotB(inside) {
      return inside[0] && !inside[1];
    });
    expect(Math.abs(ringsArea(rings))).toBeCloseTo(84, 9);
    expect(rings.length).toBe(2);
    // Even-odd ring inside ring: a frame of area 100 - 36.
    const frame: Region = { rings: [square(0, 0, 10), square(2, 2, 6)], rule: 'evenodd' };
    expect(insideRegion(frame, [5, 5])).toBe(false);
    expect(insideRegion(frame, [1, 1])).toBe(true);
    const frameRings = booleanRings([frame], function own(inside) {
      return inside[0];
    });
    expect(Math.abs(ringsArea(frameRings))).toBeCloseTo(64, 9);
  });

  it('handles shared edges and touching corners', () => {
    const a: Region = { rings: [square(0, 0, 10)], rule: 'nonzero' };
    const b: Region = { rings: [square(10, 0, 10), square(0, 10, 5)], rule: 'nonzero' };
    const union = booleanRings([a, b], function either(inside) {
      return inside[0] || inside[1];
    });
    expect(Math.abs(ringsArea(union))).toBeCloseTo(225, 9);
    const difference = booleanRings([a, b], function aNotB(inside) {
      return inside[0] && !inside[1];
    });
    expect(Math.abs(ringsArea(difference))).toBeCloseTo(100, 9);
  });
});

// Every path's d, in order.
function pathData(svg: string): string[] {
  const result: string[] = [];
  const pattern = /<path d="([^"]*)"/g;
  let match = pattern.exec(svg);
  while (match !== null) {
    result.push(match[1]);
    match = pattern.exec(svg);
  }
  return result;
}

// The plain-SVG rules the cutting service needs.
function checkPlain(svg: string): void {
  expect(svg).not.toMatch(/transform=/);
  expect(svg).not.toMatch(/style=|<style/);
  expect(svg).not.toMatch(/<use|clip-path|clipPath|<mask/);
  const size = /<svg[^>]* width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  expect(size).not.toBeNull();
  if (size !== null) {
    expect(size[1]).toBe(size[3]);
    expect(size[2]).toBe(size[4]);
  }
  const paths = pathData(svg);
  expect(paths.length).toBeGreaterThan(0);
  for (let i = 0; i < paths.length; i++) {
    // Absolute commands only, every subpath closed.
    expect(paths[i]).toMatch(/^[MLCZ0-9 .\-]+$/);
    const subpaths = paths[i].split('M').filter(function nonEmpty(s) {
      return s.trim() !== '';
    });
    for (let k = 0; k < subpaths.length; k++) {
      expect(subpaths[k].trim().endsWith('Z')).toBe(true);
    }
  }
  expect(svg).toMatch(/fill="none"/);
  expect(svg).not.toMatch(/<path[^>]*fill="#/);
}

function sameSubpaths(actual: Subpath[], expected: Subpath[]): number {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    worst = Math.max(worst, Math.abs(a.start[0] - e.start[0]), Math.abs(a.start[1] - e.start[1]));
    expect(a.segments.length).toBe(e.segments.length);
    for (let k = 0; k < e.segments.length; k++) {
      const sa = a.segments[k];
      const se = e.segments[k];
      expect(sa.kind).toBe(se.kind);
      worst = Math.max(worst, Math.abs(sa.to[0] - se.to[0]), Math.abs(sa.to[1] - se.to[1]));
      if (sa.kind === 'cubic' && se.kind === 'cubic') {
        worst = Math.max(worst, Math.abs(sa.c1[0] - se.c1[0]), Math.abs(sa.c2[1] - se.c2[1]));
      }
    }
  }
  return worst;
}

describe('cut export', () => {
  it('writes each piece as its artwork at size: path data equal up to formatting', () => {
    const logo = testArt('logo');
    const lettering = testArt('lettering');
    const pieces: CutPiece[] = [
      { name: 'logo', artwork: logo, width: 30, height: 30, flipX: false, flipY: false, colourMap: {} },
      { name: 'DC6', artwork: lettering, width: 120, height: 40, flipX: true, flipY: false, colourMap: {} },
    ];
    const files = cutFiles(pieces, { files: 'layers', overlaps: 'layered' });
    expect(files.length).toBe(1);
    checkPlain(files[0].text);
    expect(files[0].text).toMatch(/inkscape:groupmode="layer"/);
    expect(files[0].text).toMatch(/<text[^>]*>logo<\/text>/);
    // The pieces are laid out from (10, 10), 10 mm apart.
    const paths = pathData(files[0].text);
    // Cerise first (first appearance), then black: logo disc, logo arrow, then the letters.
    const disc = parsePathData(paths[0]);
    const expectedDisc: Subpath[] = [];
    const logoMatrix = multiplyMatrix([1, 0, 0, 1, 10, 10], sizeMatrix(logo, 30, 30, false, false));
    for (let k = 0; k < logo.shapes[0].subpaths.length; k++) {
      expectedDisc.push(transformSubpath(logoMatrix, logo.shapes[0].subpaths[k]));
    }
    expect(sameSubpaths(disc, expectedDisc)).toBeLessThan(0.0006);
    // The flipped lettering: mirror image, same size.
    const letterMatrix = multiplyMatrix([1, 0, 0, 1, 50, 10], sizeMatrix(lettering, 120, 40, true, false));
    let worst = 0;
    for (let s = 0; s < lettering.shapes.length; s++) {
      const expected: Subpath[] = [];
      for (let k = 0; k < lettering.shapes[s].subpaths.length; k++) {
        expected.push(transformSubpath(letterMatrix, lettering.shapes[s].subpaths[k]));
      }
      worst = Math.max(worst, sameSubpaths(parsePathData(paths[2 + s]), expected));
    }
    expect(worst).toBeLessThan(0.0006);
  });

  it('writes one file per colour, each plain', () => {
    const logo = testArt('logo');
    const pieces: CutPiece[] = [{ name: 'logo', artwork: logo, width: 40, height: 40, flipX: false, flipY: false, colourMap: {} }];
    const files = cutFiles(pieces, { files: 'per-colour', overlaps: 'layered' });
    expect(files.map((f) => f.fileName)).toEqual(['dc6-cut-cerise.svg', 'dc6-cut-black.svg']);
    for (let i = 0; i < files.length; i++) {
      checkPlain(files[i].text);
      expect(files[i].text).not.toMatch(/inkscape/);
    }
  });

  it('knocks out the overlap from the lower colour, with the right area', () => {
    const logo = testArt('logo');
    const piece: CutPiece = { name: 'logo', artwork: logo, width: 40, height: 40, flipX: false, flipY: false, colourMap: {} };
    const entry = { piece: piece, x: 0, y: 0 };
    const cerise = colourPaths(entry, '#e64097', 'knockout');
    let ceriseArea = 0;
    for (let i = 0; i < cerise.length; i++) {
      const subpaths = parsePathData(cerise[i]);
      for (let k = 0; k < subpaths.length; k++) {
        ceriseArea = ceriseArea + polygonArea(flattenSubpath(subpaths[k], 0.001));
      }
    }
    // Disc r = 20 minus the arrowhead (a quadrilateral, shoelace area).
    const arrow: [number, number][] = [
      [20, 5],
      [29, 31],
      [20, 25],
      [11, 31],
    ];
    const arrowArea = Math.abs(polygonArea(arrow));
    const discArea = Math.PI * 400 * (1 - 1e-4); // the flattened circle is a hair smaller
    expect(Math.abs(Math.abs(ceriseArea) - (discArea - arrowArea))).toBeLessThan(0.5);
    // The top colour is unchanged and still curves (here: straight lines of the arrow).
    const black = colourPaths(entry, '#000000', 'knockout');
    expect(black.length).toBe(1);
    // Remapping both artwork colours to one vinyl colour leaves nothing to knock out.
    const merged: CutPiece = { name: 'logo', artwork: logo, width: 40, height: 40, flipX: false, flipY: false, colourMap: { '#000000': '#e64097' } };
    const files = cutFiles([merged], { files: 'per-colour', overlaps: 'knockout' });
    expect(files.length).toBe(1);
    checkPlain(files[0].text);
  });
});
