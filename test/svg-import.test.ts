import { describe, expect, it } from 'vitest';
import { importSvg } from '../src/geometry/svg-import.ts';
import type { Artwork, Shape } from '../src/geometry/artwork.ts';
import { flattenSubpath, polygonArea } from '../src/geometry/artwork.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function artworkOf(svg: string): Artwork {
  const result = importSvg(svg, 'test', 'a1');
  if (result.artwork === null) {
    throw new Error('expected artwork, notices: ' + result.notices.join(' / '));
  }
  return result.artwork;
}

// Filled area of one shape: rings by fill rule are not needed for these
// simple shapes; the absolute sum of ring areas with signs works for
// non-overlapping holes.
function shapeArea(shape: Shape): number {
  let total = 0;
  for (let i = 0; i < shape.subpaths.length; i++) {
    total = total + polygonArea(flattenSubpath(shape.subpaths[i], 0.001));
  }
  return Math.abs(total);
}

describe('SVG import: size and units', () => {
  it('takes the size from width and height in mm with a viewBox', () => {
    const art = artworkOf('<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 400 200"><rect width="400" height="200" fill="#e64097"/></svg>');
    expect(art.width).toBeCloseTo(40, 9);
    expect(art.height).toBeCloseTo(20, 9);
  });

  it('reads inches, centimetres and points', () => {
    expect(artworkOf('<svg width="1in" height="1in" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').width).toBeCloseTo(25.4, 9);
    expect(artworkOf('<svg width="2cm" height="1cm" viewBox="0 0 2 1"><rect width="2" height="1"/></svg>').width).toBeCloseTo(20, 9);
    expect(artworkOf('<svg width="72pt" height="72pt" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>').width).toBeCloseTo(25.4, 9);
  });

  it('takes a user unit as a CSS pixel (1/96 in) when there are no physical units', () => {
    const art = artworkOf('<svg viewBox="0 0 96 48"><rect width="96" height="48"/></svg>');
    expect(art.width).toBeCloseTo(25.4, 9);
    expect(art.height).toBeCloseTo(12.7, 9);
    const noViewBox = artworkOf('<svg width="200" height="100"><rect x="10" y="10" width="96" height="96"/></svg>');
    expect(noViewBox.width).toBeCloseTo(25.4, 9);
  });

  it('honours preserveAspectRatio (meet, centred) when the viewBox does not fit', () => {
    // viewBox 2:1 into a square 100 mm: scale 0.5 mm per unit.
    const art = artworkOf('<svg width="100mm" height="100mm" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>');
    expect(art.width).toBeCloseTo(100, 9);
    expect(art.height).toBeCloseTo(50, 9);
  });
});

describe('SVG import: geometry', () => {
  it('applies nested transforms', () => {
    // A 10 x 10 unit square, scaled 2, rotated 90 degrees, translated:
    // still 20 x 20 mm at 1 unit = 1 mm.
    const svg =
      '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<g transform="translate(50 50)"><g transform="rotate(90) scale(2)"><rect x="0" y="0" width="10" height="5"/></g></g></svg>';
    const art = artworkOf(svg);
    // Rotated by 90: width and height swap; scale 2.
    expect(art.width).toBeCloseTo(10, 9);
    expect(art.height).toBeCloseTo(20, 9);
    expect(shapeArea(art.shapes[0])).toBeCloseTo(200, 6);
  });

  it('converts arcs exactly enough: a circle by arcs has area pi r^2', () => {
    const svg = '<svg width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M60 50 A10 10 0 0 1 40 50 A10 10 0 0 1 60 50 Z"/></svg>';
    const art = artworkOf(svg);
    expect(art.width).toBeCloseTo(20, 6);
    expect(art.height).toBeCloseTo(20, 6);
    // Four-cubic circle error is 2.7e-4 r: area within 0.1%.
    expect(Math.abs(shapeArea(art.shapes[0]) - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(1e-3);
    // Kept as curves, not polygonised.
    for (let i = 0; i < art.shapes[0].subpaths[0].segments.length; i++) {
      expect(art.shapes[0].subpaths[0].segments[i].kind).toBe('cubic');
    }
  });

  it('reads relative commands, implicit repeats, S, Q, T, H, V and packed arc flags', () => {
    const svg =
      '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<path d="m10 10h20v20h-20z M40 10 q10 0 10 10 t10 10 l-20 0z M70 10 c0 5 10 5 10 0 s10-5 10 0 v10h-20z M10 50a5 5 0 1010 0 5 5 0 10-10 0z"/></svg>';
    const art = artworkOf(svg);
    expect(art.shapes[0].subpaths.length).toBe(4);
    // The first square: 20 x 20.
    expect(Math.abs(polygonArea(flattenSubpath(art.shapes[0].subpaths[0], 0.001)))).toBeCloseTo(400, 6);
    // The packed-flag circle of radius 5.
    const circle = Math.abs(polygonArea(flattenSubpath(art.shapes[0].subpaths[3], 0.0001)));
    expect(Math.abs(circle - Math.PI * 25) / (Math.PI * 25)).toBeLessThan(1e-3);
  });

  it('reads rect (rounded), circle, ellipse, polygon and polyline (closed)', () => {
    const svg =
      '<svg width="200mm" height="100mm" viewBox="0 0 200 100">' +
      '<rect x="0" y="0" width="20" height="10" rx="2"/>' +
      '<circle cx="40" cy="5" r="5"/>' +
      '<ellipse cx="60" cy="5" rx="8" ry="4"/>' +
      '<polygon points="80,0 90,0 90,10"/>' +
      '<polyline points="100,0 110,0 110,10"/>' +
      '</svg>';
    const art = artworkOf(svg);
    expect(art.shapes.length).toBe(5);
    const roundedArea = 200 - (4 - Math.PI) * 4;
    expect(shapeArea(art.shapes[0])).toBeCloseTo(roundedArea, 2);
    expect(shapeArea(art.shapes[1])).toBeCloseTo(Math.PI * 25, 1);
    expect(shapeArea(art.shapes[2])).toBeCloseTo(Math.PI * 32, 1);
    expect(shapeArea(art.shapes[3])).toBeCloseTo(50, 9);
    expect(shapeArea(art.shapes[4])).toBeCloseTo(50, 9);
    // Every subpath is closed: it ends where it starts.
    for (let s = 0; s < art.shapes.length; s++) {
      const sub = art.shapes[s].subpaths[0];
      const end = sub.segments[sub.segments.length - 1].to;
      expect(end[0]).toBeCloseTo(sub.start[0], 9);
      expect(end[1]).toBeCloseTo(sub.start[1], 9);
    }
  });

  it('keeps the fill rule', () => {
    const svg = '<svg width="10mm" height="10mm" viewBox="0 0 10 10"><path fill-rule="evenodd" d="M0 0H10V10H0Z M2 2H8V8H2Z"/><path style="fill-rule:nonzero" d="M0 0H1V1H0Z"/></svg>';
    const art = artworkOf(svg);
    expect(art.shapes[0].fillRule).toBe('evenodd');
    expect(art.shapes[1].fillRule).toBe('nonzero');
  });
});

describe('SVG import: colours', () => {
  it('groups shapes by fill colour from attributes, style, CSS classes and names', () => {
    const svg =
      '<svg width="10mm" height="10mm" viewBox="0 0 10 10">' +
      '<style>.st0{fill:#E64097;} .st1 { fill: black }</style>' +
      '<rect class="st0" width="1" height="1"/>' +
      '<rect class="st1" x="2" width="1" height="1"/>' +
      '<rect style="fill:rgb(230,64,151)" x="4" width="1" height="1"/>' +
      '<g fill="#abc"><rect x="6" width="1" height="1"/></g>' +
      '<rect fill="white" x="8" width="1" height="1"/>' +
      '</svg>';
    const art = artworkOf(svg);
    expect(art.colours).toEqual(['#e64097', '#000000', '#aabbcc', '#ffffff']);
    expect(art.shapes.length).toBe(5);
  });

  it('defaults to black, skips fill none and invisible shapes', () => {
    const svg =
      '<svg width="10mm" height="10mm" viewBox="0 0 10 10">' +
      '<rect width="1" height="1"/>' +
      '<rect fill="none" stroke="red" x="2" width="1" height="1"/>' +
      '<rect display="none" x="4" width="1" height="1"/>' +
      '<rect opacity="0" x="6" width="1" height="1"/>' +
      '</svg>';
    const result = importSvg(svg, 'x', 'x');
    expect(result.artwork?.shapes.length).toBe(1);
    expect(result.artwork?.colours).toEqual(['#000000']);
    expect(result.notices).toEqual([]);
  });
});

describe('SVG import: what cannot be cut', () => {
  it('notices live text and imports the rest', () => {
    const svg = '<svg width="10mm" height="10mm" viewBox="0 0 10 10"><text x="0" y="5">DC6</text><rect width="5" height="5" fill="#e64097"/></svg>';
    const result = importSvg(svg, 'logo.svg', 'x');
    expect(result.artwork?.shapes.length).toBe(1);
    expect(result.notices.length).toBe(1);
    expect(result.notices[0]).toMatch(/live text/);
    expect(result.notices[0]).toMatch(/paths/);
  });

  it('notices a file with only strokes', () => {
    const svg = '<svg width="10mm" height="10mm" viewBox="0 0 10 10"><path d="M0 0L10 10" fill="none" stroke="black"/></svg>';
    const result = importSvg(svg, 'lines.svg', 'x');
    expect(result.artwork).toBeNull();
    expect(result.notices[0]).toMatch(/only strokes/);
  });

  it('notices gradients and raster images and leaves them out', () => {
    const svg =
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="10mm" height="10mm" viewBox="0 0 10 10">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>' +
      '<rect width="5" height="5" fill="url(#g)"/><image xlink:href="a.png" width="5" height="5"/>' +
      '<rect x="6" width="2" height="2"/></svg>';
    const result = importSvg(svg, 'mixed.svg', 'x');
    expect(result.artwork?.shapes.length).toBe(1);
    expect(result.notices.length).toBe(2);
  });

  it('reads Illustrator-style files (DOCTYPE with entities, namespaced attributes)', () => {
    const svg =
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]>' +
      '<!-- comment --><svg version="1.1" xmlns="&ns_svg;" x="0px" y="0px" width="30px" height="30px" viewBox="0 0 30 30" xml:space="preserve">' +
      '<g><path fill="#E64097" d="M0,0h30v30H0V0z"/></g></svg>';
    const art = artworkOf(svg);
    expect(art.width).toBeCloseTo((30 * 25.4) / 96, 9);
    expect(art.colours).toEqual(['#e64097']);
  });

  it('imports the bundled test art', () => {
    const logo = importSvg(readFileSync(join(here, '..', 'test-models', 'art', 'logo.svg'), 'utf8'), 'logo', 'l');
    expect(logo.notices).toEqual([]);
    expect(logo.artwork?.colours.length).toBe(2);
    const lettering = importSvg(readFileSync(join(here, '..', 'test-models', 'art', 'lettering.svg'), 'utf8'), 'lettering', 'w');
    expect(lettering.notices).toEqual([]);
    expect(lettering.artwork?.width).toBeCloseTo(60, 6);
  });
});
