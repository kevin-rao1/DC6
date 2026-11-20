// The flat page: strip and islands built from assembled rockets, the two
// maps between surface and page, and decals drawn on the page.

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/geometry/vec3.ts';
import { dot, length, sub } from '../src/geometry/vec3.ts';
import { applyToPoint } from '../src/geometry/transform.ts';
import { meshVertex, pointFromBarycentric } from '../src/geometry/surface-mesh.ts';
import { raycastSurface, worldNormal } from '../src/geometry/geodesic.ts';
import type { Surface } from '../src/geometry/geodesic.ts';
import { defaultRight, frameAt, mapDecal, rotateInPlane } from '../src/geometry/decal-map.ts';
import type { Page, PageView } from '../src/geometry/page.ts';
import { buildPage, decalPageTriangles, edgeJoint, islandGap, pageToSurface, surfaceToPage, viewPage } from '../src/geometry/page.ts';
import { AFT_DIRECTION } from '../src/geometry/rocket-axis.ts';
import { assembledRocket, fusedRocket, infoOf } from './rocket.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artwork } from '../src/geometry/artwork.ts';
import { shapesBox } from '../src/geometry/artwork.ts';
import { importSvg } from '../src/geometry/svg-import.ts';
import { decalOutlines } from '../src/geometry/page-svg.ts';
import { rootPart, surfaceOf } from './surfaces.ts';
import type { Placed } from './surfaces.ts';
import { loadPart } from './models.ts';
import { identityTransform } from '../src/geometry/transform.ts';
import { placeRoot } from '../src/geometry/mating.ts';
import { body, tube as tubeSize } from '../tools/test-model-dimensions.ts';

const report: string[] = [];

function page1(page: Page, piece: number): string {
  return page.placedIds[piece];
}

function pageOf(placed: Placed[]): Page {
  const symmetry: Array<number | null> = [];
  for (let i = 0; i < placed.length; i++) {
    symmetry.push(null);
  }
  return buildPage(surfaceOf(placed), infoOf(placed, symmetry));
}

// World corners of a mesh triangle of a surface piece.
function worldCorner(surface: Surface, piece: number, triangle: number, corner: number): Vec3 {
  return applyToPoint(surface.pieces[piece].transform, meshVertex(surface.pieces[piece].mesh, triangle, corner));
}

// Largest relative difference between the page and 3D lengths of the
// edges of strip triangles no cut runs through.
function stripEdgeError(view: PageView): number {
  const page = view.page;
  let worst = 0;
  for (let f = 0; f < view.stripFaceCount; f++) {
    const piece = view.pieces[f];
    if (piece.cutEdges[0] >= 0 || piece.cutEdges[1] >= 0 || piece.cutEdges[2] >= 0 || piece.outline.length !== 3) {
      continue;
    }
    const s = page.strip.triangles[piece.strip];
    for (let k = 0; k < 3; k++) {
      const kk = (k + 1) % 3;
      const a = worldCorner(page.surface, s.piece, s.triangle, k);
      const b = worldCorner(page.surface, s.piece, s.triangle, kk);
      const real = length(sub(a, b));
      const flat = Math.hypot(piece.corners[k][0] - piece.corners[kk][0], piece.corners[k][1] - piece.corners[kk][1]);
      if (real < 1e-6) {
        continue;
      }
      worst = Math.max(worst, Math.abs(flat - real) / real);
    }
  }
  return worst;
}

// A small deterministic random number generator (mulberry32).
function random(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function trianglesOverlap(a: number[], b: number[]): boolean {
  // Separating axis test for two 2D triangles (6 numbers each), with a
  // small tolerance so shared edges do not count.
  const shapes = [a, b];
  for (let s = 0; s < 2; s++) {
    const shape = shapes[s];
    for (let k = 0; k < 3; k++) {
      const kk = (k + 1) % 3;
      const nx = -(shape[2 * kk + 1] - shape[2 * k + 1]);
      const ny = shape[2 * kk] - shape[2 * k];
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (let q = 0; q < 3; q++) {
        const pa = a[2 * q] * nx + a[2 * q + 1] * ny;
        const pb = b[2 * q] * nx + b[2 * q + 1] * ny;
        minA = Math.min(minA, pa);
        maxA = Math.max(maxA, pa);
        minB = Math.min(minB, pb);
        maxB = Math.max(maxB, pb);
      }
      const scale = Math.hypot(nx, ny);
      if (maxA <= minB + 1e-6 * scale || maxB <= minA + 1e-6 * scale) {
        return false;
      }
    }
  }
  return true;
}

describe('the strip on single sections', () => {
  it('the tube (a cylinder in two half faces) is one strip with no line down the middle, lengths true to 0.1%', async () => {
    const tube = await rootPart('tube', null);
    const page = pageOf([tube]);
    const view = viewPage(page, 0);
    expect(page.strip.triangles.length).toBeGreaterThan(0);
    // (The tube's vertices are stored as 32-bit floats: a few micrometres.)
    expect(Math.abs(page.strip.length - tubeSize.length)).toBeLessThan(1e-5);
    // The only strip edges are the two ends; no joint, no line inside.
    let inside = 0;
    for (let i = 0; i < view.outline.length; i = i + 4) {
      const atEnd = (Math.abs(view.outline[i]) < 1e-4 && Math.abs(view.outline[i + 2]) < 1e-4) || (Math.abs(view.outline[i] - tubeSize.length) < 1e-4 && Math.abs(view.outline[i + 2] - tubeSize.length) < 1e-4);
      if (!atEnd) {
        inside = inside + 1;
      }
    }
    expect(inside).toBe(0);
    expect(view.joints.length).toBe(0);
    // Every seam line is at the strip's top or bottom edge.
    for (let i = 0; i < view.seams.length; i = i + 2) {
      expect(Math.abs(Math.abs(view.seams[i + 1]) - Math.PI * body.outerRadius)).toBeLessThan(0.05);
    }
    const error = stripEdgeError(view);
    report.push('tube: worst triangle edge length error on the page ' + (error * 100).toFixed(4) + '%');
    expect(error).toBeLessThan(0.001);
  });

  it('the boattail (a cone) on the plain strip: measured shear (gores are not built)', async () => {
    const boattail = await rootPart('boattail', null);
    const page = pageOf([boattail]);
    const view = viewPage(page, 0);
    const error = stripEdgeError(view);
    // The silhouette map shears by (roll angle from the centre line) x
    // (slope of the profile): up to pi x sin(half angle) at the seam.
    const slope = Math.sin(Math.atan((33 - 24) / 70));
    report.push('boattail cone on the plain strip: worst triangle edge length error ' + (error * 100).toFixed(2) + '% (predicted shear at the seam ' + (Math.PI * slope * 100).toFixed(1) + '%); the 0.1% check needs gores, NOT MET');
    expect(error).toBeGreaterThan(0);
  });

  it('a fin side is an island drawn 1:1 (lengths exact)', async () => {
    const fin = await loadPart('fin');
    const page = pageOf([{ id: 'fin', part: fin, transform: identityTransform() }]);
    expect(page.islands.length).toBe(2);
    let worst = 0;
    for (let i = 0; i < page.islands.length; i++) {
      const island = page.islands[i];
      for (let t = 0; t < island.triangles.length; t++) {
        for (let k = 0; k < 3; k++) {
          const kk = (k + 1) % 3;
          const real = length(sub(worldCorner(page.surface, island.piece, island.triangles[t], k), worldCorner(page.surface, island.piece, island.triangles[t], kk)));
          const flat = Math.hypot(island.corners[6 * t + 2 * k] - island.corners[6 * t + 2 * kk], island.corners[6 * t + 2 * k + 1] - island.corners[6 * t + 2 * kk + 1]);
          if (real > 1e-6) {
            worst = Math.max(worst, Math.abs(flat - real) / real);
          }
        }
      }
    }
    report.push('fin sides: worst edge length error ' + worst.toExponential(2));
    expect(worst).toBeLessThan(1e-6);
  });
});

describe('the page of the test rocket', () => {
  it('assembled: exactly one strip and eight fin sides; nothing else; built in under 2 s', async () => {
    const rocket = await assembledRocket('tube');
    const start = performance.now();
    const page = buildPage(rocket.surface, rocket.info);
    const view = viewPage(page, 0);
    const elapsed = performance.now() - start;
    report.push('assembled rocket: page built in ' + elapsed.toFixed(0) + ' ms (' + page.strip.triangles.length + ' strip triangles, ' + page.islands.length + ' islands)');
    expect(elapsed).toBeLessThan(2000);
    // One strip: it runs from the nose tip to the tail without a break.
    expect(page.strip.length).toBeGreaterThan(450);
    const covered = new Uint8Array(Math.ceil(page.strip.length) + 1);
    for (let i = 0; i < page.strip.triangles.length; i++) {
      const s = page.strip.triangles[i];
      const first = Math.floor(Math.min(s.x[0], s.x[1], s.x[2]));
      const last = Math.ceil(Math.max(s.x[0], s.x[1], s.x[2]));
      for (let b = Math.max(0, first); b < Math.min(covered.length, last); b++) {
        covered[b] = 1;
      }
    }
    let gaps = 0;
    for (let b = 0; b < covered.length - 1; b++) {
      if (covered[b] === 0) {
        gaps = gaps + 1;
      }
    }
    expect(gaps).toBe(0);
    // Every part on the axis is on the strip; no fin triangle is.
    const onStrip = new Set<string>();
    for (let i = 0; i < page.strip.triangles.length; i++) {
      onStrip.add(page.placedIds[page.strip.triangles[i].piece]);
    }
    expect(Array.from(onStrip).sort()).toEqual(['boattail', 'can', 'nose', 'tube']);
    const sides = page.islands.filter(function side(i) {
      return i.kind === 'side';
    });
    const ends = page.islands.filter(function end(i) {
      return i.kind === 'end';
    });
    report.push('assembled rocket islands: ' + page.islands.map((i) => i.label).join(', '));
    expect(sides.length).toBe(8);
    for (let i = 0; i < sides.length; i++) {
      expect(page.placedIds[sides[i].piece].startsWith('fin')).toBe(true);
    }
    // The boattail's base ring is 1.5 mm wide: too narrow for vinyl.
    expect(ends.length).toBe(0);
    // Parts meet: joints between nose and can, can and tube, tube and boattail.
    let jointEdges = 0;
    for (let i = 0; i < page.edgeKinds.length; i++) {
      if (page.edgeKinds[i] === edgeJoint) {
        jointEdges = jointEdges + 1;
      }
    }
    expect(jointEdges).toBeGreaterThan(0);
    expect(view.joints.length).toBeGreaterThan(0);
  });

  it('fused into one solid: the same strip and the same eight fin sides, plus its base disc', async () => {
    const rocket = await fusedRocket();
    const page = buildPage(rocket.surface, rocket.info);
    const sides = page.islands.filter((i) => i.kind === 'side');
    const ends = page.islands.filter((i) => i.kind === 'end');
    report.push('fused rocket islands: ' + page.islands.map((i) => i.label + (i.kind === 'end' ? ' (end, ' + (i.maxX - i.minX).toFixed(1) + ' mm)' : '')).join(', '));
    expect(page.strip.triangles.length).toBeGreaterThan(0);
    expect(sides.length).toBe(8);
    // The solid base of the fused boattail is a 48 mm disc.
    expect(ends.length).toBe(1);
    expect(Math.abs(ends[0].maxX - ends[0].minX - 48)).toBeLessThan(0.5);
  });

  it('a sled inside the tube contributes nothing (a hidden one is not even in the surface)', async () => {
    const rocket = await assembledRocket('tube');
    const plain = buildPage(rocket.surface, rocket.info);
    const sledPart = await loadPart('sled');
    const sledFace = sledPart.attachFaces[sledPart.guessedAttachFace];
    // Inside the tube, on the axis: the sled's attach face 40 mm into the tube's aft end.
    const onAxis = placeRoot(sledFace, identityTransform(), 0);
    const inside = { position: [onAxis.position[0] - 40, onAxis.position[1], onAxis.position[2]] as Vec3, rotation: onAxis.rotation };
    const sledPlaced: Placed = { id: 'sled', part: sledPart, transform: inside };
    const withSled = rocket.placed.concat([sledPlaced]);
    const symmetry = rocket.symmetry.concat([null]);
    const page = buildPage(surfaceOf(withSled), infoOf(withSled, symmetry));
    expect(page.strip.triangles.length).toBe(plain.strip.triangles.length);
    expect(page.islands.length).toBe(plain.islands.length);
    for (let i = 0; i < page.strip.triangles.length; i++) {
      expect(page.placedIds[page.strip.triangles[i].piece]).not.toBe('sled');
    }
  });

  it('no island overlaps another or the strip; nose is left on every island and none is mirrored', async () => {
    const rocket = await assembledRocket('tube');
    const page = buildPage(rocket.surface, rocket.info);
    const view = viewPage(page, 0);
    const islandFaces = view.faces.slice(view.stripFaceCount);
    let tested = 0;
    for (let i = 0; i < islandFaces.length; i++) {
      for (let j = i + 1; j < islandFaces.length; j++) {
        if (islandFaces[i].chart === islandFaces[j].chart) {
          continue;
        }
        tested = tested + 1;
        expect(trianglesOverlap(islandFaces[i].corners, islandFaces[j].corners)).toBe(false);
      }
    }
    // Against the strip and its repeat band (bounding boxes first).
    for (let i = 0; i < islandFaces.length; i++) {
      const c = islandFaces[i].corners;
      for (let f = 0; f < view.stripFaceCount; f++) {
        const p = view.faces[f].polygon;
        for (let q = 2; q + 3 < p.length; q = q + 2) {
          const triangle = [p[0], p[1], p[q], p[q + 1], p[q + 2], p[q + 3]];
          expect(trianglesOverlap(c, triangle)).toBe(false);
        }
      }
    }
    report.push('overlap test: ' + String(tested) + ' island triangle pairs, and every island triangle against every strip piece');
    for (let i = 0; i < page.islands.length; i++) {
      const island = page.islands[i];
      // Page right is towards the tail (nose left).
      expect(dot(island.right, AFT_DIRECTION)).toBeGreaterThan(0.99);
      // Not mirrored: right x up is the outward normal (seen from outside).
      const r = island.right;
      const u = island.up;
      const n: Vec3 = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
      expect(dot(n, island.normal)).toBeGreaterThan(0.999999);
    }
  });

  it('compact: the fin sides lie in one row above and one below the strip, each fin\'s two sides side by side', async () => {
    const rocket = await assembledRocket('tube');
    const page = buildPage(rocket.surface, rocket.info);
    let bandHalf = 0;
    for (let b = 0; b < page.envelope.length; b++) {
      bandHalf = Math.max(bandHalf, page.envelope[b]);
    }
    let tallest = 0;
    for (let i = 0; i < page.islands.length; i++) {
      tallest = Math.max(tallest, page.islands[i].maxY - page.islands[i].minY);
    }
    const height = page.maxY - page.minY;
    report.push('compact page: ' + (page.maxX - page.minX).toFixed(0) + ' x ' + height.toFixed(0) + ' mm (strip band ' + (2 * bandHalf).toFixed(0) + ' mm, tallest island ' + tallest.toFixed(0) + ' mm)');
    // About the strip band plus one row of islands on each side.
    expect(height).toBeLessThan(2 * bandHalf + 2 * (tallest + islandGap) + 1e-6);
    // One row each side: the islands above all start at the same height, and so do those below.
    const aboveBottoms = new Set<string>();
    const belowTops = new Set<string>();
    for (let i = 0; i < page.islands.length; i++) {
      const island = page.islands[i];
      if (island.offsetY > 0) {
        aboveBottoms.add((island.minY + island.offsetY).toFixed(6));
        expect(island.labelSide).toBe(1);
      } else {
        belowTops.add((island.maxY + island.offsetY).toFixed(6));
        expect(island.labelSide).toBe(-1);
      }
    }
    expect(aboveBottoms.size).toBe(1);
    expect(belowTops.size).toBe(1);
    // A fin's two sides are neighbours in their row, left then right, one gap apart.
    for (let k = 1; k <= 4; k++) {
      const sides = page.islands.filter((i) => page.placedIds[i.piece] === 'fin' + String(k));
      expect(sides.length).toBe(2);
      sides.sort((a, b) => a.offsetX + a.minX - (b.offsetX + b.minX));
      expect(sides[0].side).toBe('left');
      expect(sides[1].side).toBe('right');
      expect(Math.abs(sides[1].offsetX + sides[1].minX - (sides[0].offsetX + sides[0].maxX) - islandGap)).toBeLessThan(1e-6);
    }
  });

  it('a part floating beside a fin (not on the body) does not hide the fin\'s sides', async () => {
    const rocket = await assembledRocket('tube');
    const plain = buildPage(rocket.surface, rocket.info);
    const fin1Side = plain.islands.filter((i) => page1(plain, i.piece) === 'fin1')[0];
    // A copy of fin 1, 12 mm off its side, not attached to anything.
    const fin1 = rocket.placed.filter((p) => p.id === 'fin1')[0];
    const offset = fin1Side.normal.map((v) => v * 12) as Vec3;
    const floating: Placed = { id: 'floating', part: fin1.part, transform: { position: [fin1.transform.position[0] + offset[0], fin1.transform.position[1] + offset[1], fin1.transform.position[2] + offset[2]], rotation: fin1.transform.rotation } };
    const list = rocket.placed.concat([floating]);
    const symmetry = rocket.symmetry.concat([null]);
    const info = infoOf(list, symmetry);
    info[info.length - 1].onBody = false;
    const page = buildPage(surfaceOf(list), info);
    const finSides = page.islands.filter((i) => /^fin\d$/.test(page.placedIds[i.piece]));
    expect(finSides.length).toBe(8);
    // Were it on the body it would block that side (the test bites).
    info[info.length - 1].onBody = true;
    const blocked = buildPage(surfaceOf(list), info);
    const blockedSides = blocked.islands.filter((i) => /^fin\d$/.test(blocked.placedIds[i.piece]));
    expect(blockedSides.length).toBeLessThan(8);
  });

  it('building the page twice gives the same page', async () => {
    const first = await assembledRocket('tube');
    const second = await assembledRocket('tube');
    const a = viewPage(buildPage(first.surface, first.info), 0.4);
    const b = viewPage(buildPage(second.surface, second.info), 0.4);
    expect(JSON.stringify(a.faces)).toBe(JSON.stringify(b.faces));
    expect(JSON.stringify(a.outline.concat(a.joints, a.seams))).toBe(JSON.stringify(b.outline.concat(b.joints, b.seams)));
    const islandsA = a.page.islands.map((i) => [i.label, i.offsetX, i.offsetY]);
    const islandsB = b.page.islands.map((i) => [i.label, i.offsetX, i.offsetY]);
    expect(islandsA).toEqual(islandsB);
  });

  it('a tube 10 mm longer lengthens the strip by 10 mm, moves what is aft of it by 10 mm and nothing else', async () => {
    const short = buildPage((await assembledRocket('tube')).surface, (await assembledRocket('tube')).info);
    const longer = await assembledRocket('tube-long');
    const long = buildPage(longer.surface, longer.info);
    report.push('strip length ' + short.strip.length.toFixed(6) + ' -> ' + long.strip.length.toFixed(6) + ' mm');
    expect(Math.abs(long.strip.length - short.strip.length - 10)).toBeLessThan(1e-6);
    // Islands (the fins, aft of the extension) move 10 mm along, not up or down.
    expect(long.islands.length).toBe(short.islands.length);
    for (let i = 0; i < short.islands.length; i++) {
      expect(long.islands[i].label).toBe(short.islands[i].label);
      expect(Math.abs(long.islands[i].offsetX - short.islands[i].offsetX - 10)).toBeLessThan(1e-6);
      expect(Math.abs(long.islands[i].offsetY - short.islands[i].offsetY)).toBeLessThan(1e-9);
    }
    // Strip triangles of the nose and can stay put; the boattail's move 10 mm.
    function extent(page: Page, id: string): [number, number] {
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < page.strip.triangles.length; i++) {
        const s = page.strip.triangles[i];
        if (page.placedIds[s.piece] !== id) {
          continue;
        }
        low = Math.min(low, s.x[0], s.x[1], s.x[2]);
        high = Math.max(high, s.x[0], s.x[1], s.x[2]);
      }
      return [low, high];
    }
    for (const id of ['nose', 'can']) {
      expect(Math.abs(extent(long, id)[0] - extent(short, id)[0])).toBeLessThan(1e-6);
      expect(Math.abs(extent(long, id)[1] - extent(short, id)[1])).toBeLessThan(1e-6);
    }
    expect(Math.abs(extent(long, 'tube')[1] - extent(short, 'tube')[1] - 10)).toBeLessThan(1e-6);
    expect(Math.abs(extent(long, 'boattail')[0] - extent(short, 'boattail')[0] - 10)).toBeLessThan(1e-6);
    expect(Math.abs(extent(long, 'boattail')[1] - extent(short, 'boattail')[1] - 10)).toBeLessThan(1e-6);
  });
});

describe('the two maps', () => {
  it('surface -> page -> surface returns to the same point (strip near and away from the seam and cuts, and islands)', async () => {
    const rocket = await assembledRocket('tube');
    const page = buildPage(rocket.surface, rocket.info);
    const next = random(7);
    let worst = 0;
    let tried = 0;
    let doubles = 0;
    let nearTip = 0;
    const tipZone = 3;
    const rolls = [0, 0.7, -2.5];
    for (let r = 0; r < rolls.length; r++) {
      const view = viewPage(page, rolls[r]);
      const seam = rolls[r] + Math.PI;
      for (let n = 0; n < 3000; n++) {
        let piece = 0;
        let triangle = 0;
        // Half the samples near the seam (within a few degrees).
        if (n % 2 === 0) {
          const s = page.strip.triangles[Math.floor(next() * page.strip.triangles.length)];
          piece = s.piece;
          triangle = s.triangle;
        } else {
          const fallback = page.strip.triangles[Math.floor(next() * page.strip.triangles.length)];
          piece = fallback.piece;
          triangle = fallback.triangle;
          let found = false;
          for (let attempt = 0; attempt < 200 && !found; attempt++) {
            const s = page.strip.triangles[Math.floor(next() * page.strip.triangles.length)];
            const off = Math.abs(Math.atan2(Math.sin(s.phi[0] - seam), Math.cos(s.phi[0] - seam)));
            if (off < 0.06) {
              piece = s.piece;
              triangle = s.triangle;
              found = true;
            }
          }
        }
        // Within a few millimetres of the nose tip the strip folds over
        // itself (the tip is a point; its triangles are sub-millimetre and
        // their roll angles are all over the place), so the page there is
        // not one to one. Those samples are counted and left out.
        const stripTriangle = page.strip.triangles[page.strip.index.get(String(piece) + ':' + String(triangle)) as number];
        if (Math.min(stripTriangle.x[0], stripTriangle.x[1], stripTriangle.x[2]) < tipZone) {
          nearTip = nearTip + 1;
          continue;
        }
        const a = next();
        const b = next() * (1 - a);
        const w: Vec3 = [a, b, 1 - a - b];
        const point = applyToPoint(page.surface.pieces[piece].transform, pointFromBarycentric(page.surface.pieces[piece].mesh, triangle, w));
        const images = surfaceToPage(view, piece, triangle, w);
        expect(images.length).toBeGreaterThan(0);
        if (images.length > 1) {
          doubles = doubles + 1;
        }
        for (let i = 0; i < images.length; i++) {
          const back = pageToSurface(view, images[i].x, images[i].y);
          expect(back).not.toBeNull();
          if (back === null) {
            continue;
          }
          const again = applyToPoint(page.surface.pieces[back.piece].transform, pointFromBarycentric(page.surface.pieces[back.piece].mesh, back.triangle, back.barycentric));
          worst = Math.max(worst, length(sub(again, point)));
          tried = tried + 1;
        }
      }
      // Island points.
      for (let n = 0; n < 500; n++) {
        const island = page.islands[Math.floor(next() * page.islands.length)];
        const triangle = island.triangles[Math.floor(next() * island.triangles.length)];
        const a = next();
        const b = next() * (1 - a);
        const w: Vec3 = [a, b, 1 - a - b];
        const point = applyToPoint(page.surface.pieces[island.piece].transform, pointFromBarycentric(page.surface.pieces[island.piece].mesh, triangle, w));
        const images = surfaceToPage(view, island.piece, triangle, w);
        expect(images.length).toBe(1);
        const back = pageToSurface(view, images[0].x, images[0].y);
        expect(back).not.toBeNull();
        if (back !== null) {
          const again = applyToPoint(page.surface.pieces[back.piece].transform, pointFromBarycentric(page.surface.pieces[back.piece].mesh, back.triangle, back.barycentric));
          worst = Math.max(worst, length(sub(again, point)));
          tried = tried + 1;
        }
      }
    }
    report.push('round trip: ' + String(tried) + ' page images of random surface points (' + String(doubles) + ' points shown twice, near a seam), worst error ' + worst.toExponential(2) + ' mm; ' + String(nearTip) + ' samples within ' + String(tipZone) + ' mm of the nose tip left out');
    expect(worst).toBeLessThan(1e-6);
    expect(doubles).toBeGreaterThan(0);
  });

  it('a point that is not on the page maps to nothing (a fin edge)', async () => {
    const rocket = await assembledRocket('tube');
    const page = buildPage(rocket.surface, rocket.info);
    const view = viewPage(page, 0);
    // A fin triangle that is neither strip nor island: its rounded edges.
    const fin = page.placedIds.indexOf('fin1');
    const mesh = page.surface.pieces[fin].mesh;
    let found = -1;
    for (let t = 0; t < mesh.triangles.length / 3 && found < 0; t++) {
      if (!page.islandTriangles.has(String(fin) + ':' + String(t)) && !page.strip.index.has(String(fin) + ':' + String(t))) {
        found = t;
      }
    }
    expect(found).toBeGreaterThanOrEqual(0);
    expect(surfaceToPage(view, fin, found, [1 / 3, 1 / 3, 1 / 3]).length).toBe(0);
  });
});

describe('decals on the page', () => {
  async function decalAt(rocket: { surface: Surface }, origin: Vec3, direction: Vec3, rotation: number, width: number, height: number) {
    const hit = raycastSurface(rocket.surface, origin, direction);
    if (hit === null) {
      throw new Error('ray misses');
    }
    const normal = worldNormal(rocket.surface, hit.at);
    const frame = frameAt(rocket.surface, hit.at, rotateInPlane(defaultRight(normal), normal, rotation));
    if (frame === null) {
      throw new Error('no frame');
    }
    return mapDecal(rocket.surface, frame, width, height, 1);
  }

  it('a decal across the seam is drawn on both sides of it', async () => {
    const rocket = await assembledRocket('tube');
    const page = buildPage(rocket.surface, rocket.info);
    const view = viewPage(page, 0);
    // On the back of the tube, where the seam is.
    const grid = await decalAt(rocket, [-130, 0, -200], [0, 0, 1], 0.3, 30, 12);
    const triangles = decalPageTriangles(view, grid);
    const edge = Math.PI * body.outerRadius;
    let nearTop = 0;
    let nearBottom = 0;
    for (let t = 0; t < triangles.length; t++) {
      const y = (triangles[t].page[1] + triangles[t].page[3] + triangles[t].page[5]) / 3;
      if (y > edge - 20 && y < edge) {
        nearTop = nearTop + 1;
      }
      if (y < -edge + 20 && y > -edge) {
        nearBottom = nearBottom + 1;
      }
    }
    report.push('decal across the seam: ' + String(nearTop) + ' triangles below the top edge of the strip, ' + String(nearBottom) + ' above its bottom edge');
    expect(nearTop).toBeGreaterThan(0);
    expect(nearBottom).toBeGreaterThan(0);
  });

  it('the artwork goes onto the page as outlines: whole and true to size on the side, broken at the seam', async () => {
    const rocket = await assembledRocket('tube');
    const page = buildPage(rocket.surface, rocket.info);
    const view = viewPage(page, 0);
    const logo = importSvg(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'test-models', 'art', 'logo.svg'), 'utf8'), 'logo', 'a1').artwork as Artwork;
    const decal = { width: 40, height: 40, flipX: false, flipY: false, colourMap: {} as Record<string, string> };
    // On the side facing the viewer, away from everything: closed outlines, as wide as the decal.
    const side = await decalAt(rocket, [-130, 0, 200], [0, 0, -1], 0, decal.width, decal.height);
    const shapes = decalOutlines(side, decalPageTriangles(view, side), logo, decal);
    let minX = Infinity;
    let maxX = -Infinity;
    let open = 0;
    let closed = 0;
    for (let s = 0; s < shapes.length; s++) {
      for (let k = 0; k < shapes[s].outlines.length; k++) {
        const outline = shapes[s].outlines[k];
        if (outline.closed) {
          closed = closed + 1;
        } else {
          open = open + 1;
        }
        for (let q = 0; q < outline.points.length; q = q + 2) {
          minX = Math.min(minX, outline.points[q]);
          maxX = Math.max(maxX, outline.points[q]);
        }
      }
    }
    // The logo's outer shape spans its artwork's width.
    const box = shapesBox(logo.shapes);
    const expected = ((box.maxX - box.minX) / logo.width) * decal.width;
    report.push('logo outlines on the page: ' + String(closed) + ' closed, ' + String(open) + ' open; ' + (maxX - minX).toFixed(3) + ' mm across (artwork ' + expected.toFixed(3) + ' mm)');
    expect(open).toBe(0);
    expect(closed).toBeGreaterThan(0);
    expect(Math.abs(maxX - minX - expected)).toBeLessThan(0.1);
    // Across the seam: drawn on both sides, each side broken where it leaves the band.
    const back = await decalAt(rocket, [-130, 0, -200], [0, 0, 1], 0.3, 30, 30);
    const split = decalOutlines(back, decalPageTriangles(view, back), logo, { width: 30, height: 30, flipX: false, flipY: false, colourMap: {} });
    let above = 0;
    let below = 0;
    for (let s = 0; s < split.length; s++) {
      for (let k = 0; k < split[s].outlines.length; k++) {
        const y = split[s].outlines[k].points[1];
        if (y > 0) {
          above = above + 1;
        } else {
          below = below + 1;
        }
      }
    }
    expect(above).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
  });

  it('a band longer than the circumference shows its overlap on the page', async () => {
    const rocket = await assembledRocket('tube');
    const page = buildPage(rocket.surface, rocket.info);
    const view = viewPage(page, 0);
    const circumference = 2 * Math.PI * body.outerRadius;
    const grid = await decalAt(rocket, [-130, 0, 200], [0, 0, -1], Math.PI / 2, 1.3 * circumference, 10);
    const triangles = decalPageTriangles(view, grid);
    // Two triangles of the band a turn apart along it, at the same place on the page.
    let overlaps = 0;
    for (let i = 0; i < triangles.length; i++) {
      const a = triangles[i];
      const ax = (a.decal[0] + a.decal[2] + a.decal[4]) / 3;
      if (ax > -0.5 * circumference + 2) {
        continue;
      }
      for (let j = 0; j < triangles.length; j++) {
        const b = triangles[j];
        const bx = (b.decal[0] + b.decal[2] + b.decal[4]) / 3;
        if (Math.abs(bx - ax - circumference) > 3) {
          continue;
        }
        if (trianglesOverlap(a.page, b.page)) {
          overlaps = overlaps + 1;
          break;
        }
      }
    }
    report.push('band of ' + (1.3 * circumference).toFixed(0) + ' mm round the ' + circumference.toFixed(0) + ' mm tube: ' + String(overlaps) + ' of its triangles lie on the page under the part a turn further along');
    expect(overlaps).toBeGreaterThan(10);
  });

  it('prints the measurements', () => {
    console.log(report.join('\n'));
  });
});
