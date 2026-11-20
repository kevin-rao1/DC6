// The forward geodesic map on the generated test parts: true size on a
// cylinder, a cone, a plane and a doubly curved nose; no stretch on the
// developable ones; continuous sliding across CAD face boundaries and part
// joints; wrapping past a full turn.

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/geometry/vec3.ts';
import { identityTransform } from '../src/geometry/transform.ts';
import type { Surface } from '../src/geometry/geodesic.ts';
import { nearestOnPiece, raycastSurface, worldNormal } from '../src/geometry/geodesic.ts';
import { barycentricOf } from '../src/geometry/surface-mesh.ts';
import type { DecalFrame, DecalGrid } from '../src/geometry/decal-map.ts';
import { angleInPlane, defaultRight, followCursor, frameAt, gridPoint, mapDecal, rotateInPlane, anchorOf, frameOf } from '../src/geometry/decal-map.ts';
import { circularFace, rootPart, surfaceOf, tubeAndNose, unfoldMesh, worldFace } from './surfaces.ts';
import { loadPart } from './models.ts';

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Sum of 3D segment lengths along the centre row and the centre column.
function centreLengths(grid: DecalGrid): { row: number; column: number } {
  const middleRow = (grid.rows - 1) / 2;
  const middleColumn = (grid.columns - 1) / 2;
  let row = 0;
  for (let i = 0; i + 1 < grid.columns; i++) {
    const a = gridPoint(grid, i, middleRow);
    const b = gridPoint(grid, i + 1, middleRow);
    if (a === null || b === null) {
      throw new Error('centre row has a gap at column ' + String(i));
    }
    row = row + distance(a, b);
  }
  let column = 0;
  for (let j = 0; j + 1 < grid.rows; j++) {
    const a = gridPoint(grid, middleColumn, j);
    const b = gridPoint(grid, middleColumn, j + 1);
    if (a === null || b === null) {
      throw new Error('centre column has a gap at row ' + String(j));
    }
    column = column + distance(a, b);
  }
  return { row: row, column: column };
}

// A decal frame where a ray from `origin` along `direction` meets the
// surface, in the default orientation turned by `rotation`.
function frameUnder(surface: Surface, origin: Vec3, direction: Vec3, rotation: number): DecalFrame {
  const hit = raycastSurface(surface, origin, direction);
  if (hit === null) {
    throw new Error('the ray misses the surface');
  }
  const normal = worldNormal(surface, hit.at);
  const frame = frameAt(surface, hit.at, rotateInPlane(defaultRight(normal), normal, rotation));
  if (frame === null) {
    throw new Error('no frame');
  }
  return frame;
}

// Grid edge lengths against the flat cell length, three ways:
//   mesh:  in the tessellated surface itself, laid out flat by an
//          independent unfolding (unfoldMesh): what the map controls;
//   true:  on the true cylinder or cone, rolled out analytically (includes
//          the tessellation's own deviation from the true surface);
//   chord: as straight 3D distances (shorter where an edge crosses a facet crease).
function stretches(surface: Surface, grid: DecalGrid, develop: (p: Vec3) => [number, number]): { mesh: number; truth: number; chord: number } {
  const piece = surface.pieces[0];
  // Lay the mesh out from the triangle under the decal's centre.
  const centreIndex = ((grid.rows - 1) / 2) * grid.columns + (grid.columns - 1) / 2;
  const centre: Vec3 = [grid.positions[3 * centreIndex], grid.positions[3 * centreIndex + 1], grid.positions[3 * centreIndex + 2]];
  const centreOn = nearestOnPiece(surface, 0, centre, 0.01);
  if (centreOn === null) {
    throw new Error('centre not on the mesh');
  }
  const layout = unfoldMesh(piece.mesh, centreOn.triangle, 60);
  function flatOf(p: Vec3): [number, number] | null {
    const on = nearestOnPiece(surface, 0, p, 0.01);
    if (on === null) {
      return null;
    }
    const corners = layout.get(on.triangle);
    if (corners === undefined) {
      return null;
    }
    const w = barycentricOf(piece.mesh, on.triangle, on.point);
    return [w[0] * corners[0][0] + w[1] * corners[1][0] + w[2] * corners[2][0], w[0] * corners[0][1] + w[1] * corners[1][1] + w[2] * corners[2][1]];
  }
  let mesh = 0;
  let truth = 0;
  let chord = 0;
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.columns; i++) {
      const p = gridPoint(grid, i, j);
      if (p === null) {
        continue;
      }
      const neighbours: Array<[number, number]> = [
        [i + 1, j],
        [i, j + 1],
      ];
      for (let k = 0; k < neighbours.length; k++) {
        const ni = neighbours[k][0];
        const nj = neighbours[k][1];
        if (ni >= grid.columns || nj >= grid.rows) {
          continue;
        }
        const q = gridPoint(grid, ni, nj);
        if (q === null) {
          continue;
        }
        const flat = Math.hypot(grid.xs[ni] - grid.xs[i], grid.ys[nj] - grid.ys[j]);
        const a = develop(p);
        const b = develop(q);
        truth = Math.max(truth, Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - flat) / flat);
        chord = Math.max(chord, Math.abs(distance(p, q) - flat) / flat);
        const fa = flatOf(p);
        const fb = flatOf(q);
        if (fa === null || fb === null) {
          throw new Error('grid point outside the unfolded mesh');
        }
        mesh = Math.max(mesh, Math.abs(Math.hypot(fb[0] - fa[0], fb[1] - fa[1]) - flat) / flat);
      }
    }
  }
  return { mesh: mesh, truth: truth, chord: chord };
}

function describeStretch(s: { mesh: number; truth: number; chord: number }): string {
  return 'worst grid edge error: in the mesh ' + (s.mesh * 100).toExponential(2) + '%, on the true surface ' + (s.truth * 100).toFixed(4) + '%, as 3D chords ' + (s.chord * 100).toFixed(4) + '%';
}

const report: string[] = [];

describe('forward geodesic map: true size', () => {
  it('a 20 mm circle is 20 mm both ways on the tube (cylinder)', async () => {
    const tube = await rootPart('tube', null);
    const surface = surfaceOf([tube]);
    for (let r = 0; r < 3; r++) {
      const rotation = (r * 35 * Math.PI) / 180;
      const grid = mapDecal(surface, frameUnder(surface, [-130, 10, 200], [0, 0, -1], rotation), 20, 20, 1);
      const lengths = centreLengths(grid);
      report.push('tube, rotated ' + String(r * 35) + ' deg: row ' + lengths.row.toFixed(4) + ' mm, column ' + lengths.column.toFixed(4) + ' mm');
      expect(Math.abs(lengths.row - 20)).toBeLessThan(0.2);
      expect(Math.abs(lengths.column - 20)).toBeLessThan(0.2);
      // No stretch: develop the cylinder (x along, R theta around).
      const stretch = stretches(surface, grid, function develop(p: Vec3): [number, number] {
        return [p[0], 33 * Math.atan2(p[1], p[2])];
      });
      report.push('tube, rotated ' + String(r * 35) + ' deg: ' + describeStretch(stretch));
      expect(stretch.mesh).toBeLessThan(0.001);
      // Against the true analytic surface the tessellation itself (facets
      // 0.1 rad wide) bends lengths locally by up to a few tenths of a percent.
      expect(stretch.truth).toBeLessThan(0.005);
    }
  });

  it('a 20 mm circle is 20 mm both ways on the boattail (cone), without stretch', async () => {
    const boattail = await rootPart('boattail', null);
    const surface = surfaceOf([boattail]);
    const big = worldFace(boattail, circularFace(boattail.part, 33, -1)).centre;
    const small = worldFace(boattail, circularFace(boattail.part, 24, -1)).centre;
    // Radius is linear in x: r(x) = 33 + (x - big.x) * slope.
    const slope = (24 - 33) / (small[0] - big[0]);
    const apexX = big[0] - 33 / slope;
    const halfAngle = Math.atan(Math.abs(slope));
    const middle = (big[0] + small[0]) / 2;
    for (let r = 0; r < 2; r++) {
      const rotation = (r * 40 * Math.PI) / 180;
      const grid = mapDecal(surface, frameUnder(surface, [middle, 5, 200], [0, 0, -1], rotation), 20, 20, 1);
      const lengths = centreLengths(grid);
      report.push('boattail, rotated ' + String(r * 40) + ' deg: row ' + lengths.row.toFixed(4) + ' mm, column ' + lengths.column.toFixed(4) + ' mm');
      expect(Math.abs(lengths.row - 20)).toBeLessThan(0.2);
      expect(Math.abs(lengths.column - 20)).toBeLessThan(0.2);
      // Develop the cone: slant distance from the apex, angle scaled by sin(half angle).
      const stretch = stretches(surface, grid, function develop(p: Vec3): [number, number] {
          const slant = Math.abs(p[0] - apexX) / Math.cos(halfAngle);
          const angle = Math.atan2(p[1], p[2]) * Math.sin(halfAngle);
          return [slant * Math.cos(angle), slant * Math.sin(angle)];
      });
      report.push('boattail, rotated ' + String(r * 40) + ' deg: ' + describeStretch(stretch));
      expect(stretch.mesh).toBeLessThan(0.001);
      // Against the true analytic surface the tessellation itself (facets
      // 0.1 rad wide) bends lengths locally by up to a few tenths of a percent.
      expect(stretch.truth).toBeLessThan(0.005);
    }
  });

  it('a 20 mm circle is 20 mm both ways on a fin (plane)', async () => {
    const fin = await loadPart('fin');
    const surface = surfaceOf([{ id: 'fin', part: fin, transform: identityTransform() }]);
    // The fin's biggest attach face is one of its flat sides.
    let side = 0;
    for (let f = 1; f < fin.attachFaces.length; f++) {
      if (fin.attachFaces[f].area > fin.attachFaces[side].area) {
        side = f;
      }
    }
    const face = fin.attachFaces[side];
    const origin: Vec3 = [face.centre[0] + face.normal[0] * 30, face.centre[1] + face.normal[1] * 30, face.centre[2] + face.normal[2] * 30];
    const grid = mapDecal(surface, frameUnder(surface, origin, [-face.normal[0], -face.normal[1], -face.normal[2]], 0.3), 20, 20, 1);
    const lengths = centreLengths(grid);
    report.push('fin: row ' + lengths.row.toFixed(4) + ' mm, column ' + lengths.column.toFixed(4) + ' mm');
    expect(Math.abs(lengths.row - 20)).toBeLessThan(0.2);
    expect(Math.abs(lengths.column - 20)).toBeLessThan(0.2);
  });

  it('a 20 mm circle is 20 mm both ways on the nose (doubly curved)', async () => {
    const both = await tubeAndNose();
    const surface = surfaceOf([both.tube, both.nose]);
    // The nose spans x from -260 to -376.5; its middle is strongly curved both ways.
    for (let k = 0; k < 2; k++) {
      const x = k === 0 ? -300 : -340;
      const grid = mapDecal(surface, frameUnder(surface, [x, 5, 200], [0, 0, -1], 0.2), 20, 20, 1);
      const lengths = centreLengths(grid);
      report.push('nose at x = ' + String(x) + ': row ' + lengths.row.toFixed(4) + ' mm, column ' + lengths.column.toFixed(4) + ' mm');
      expect(Math.abs(lengths.row - 20)).toBeLessThan(0.2);
      expect(Math.abs(lengths.column - 20)).toBeLessThan(0.2);
    }
  });
});

// Slide a decal as the editor does: the anchor follows ray hits, the frame
// carried along the surface (followCursor).
function slide(surface: Surface, rays: Array<{ origin: Vec3; direction: Vec3 }>, width: number, height: number): { centreJump: number; cornerJump: number; frameTurn: number; gaps: number } {
  let frame: DecalFrame | null = null;
  let previous: DecalGrid | null = null;
  let centreJump = 0;
  let cornerJump = 0;
  let frameTurn = 0;
  let gaps = 0;
  for (let i = 0; i < rays.length; i++) {
    const hit = raycastSurface(surface, rays[i].origin, rays[i].direction);
    if (hit === null) {
      throw new Error('ray ' + String(i) + ' misses');
    }
    let next: DecalFrame | null = null;
    if (frame === null) {
      const normal = worldNormal(surface, hit.at);
      next = frameAt(surface, hit.at, defaultRight(normal));
    } else {
      next = followCursor(surface, frame, hit.at);
    }
    if (next === null) {
      throw new Error('no frame at step ' + String(i));
    }
    // Store and restore through the document's anchor form, as the editor does.
    const stored = anchorOf(surface, next);
    const restored = frameOf(surface, stored.anchor, stored.rotation);
    if (restored === null) {
      throw new Error('anchor does not restore');
    }
    if (frame !== null) {
      const turn = Math.abs(angleInPlane(frame.right, restored.right, worldNormal(surface, restored.at)));
      frameTurn = Math.max(frameTurn, turn);
    }
    frame = restored;
    const grid = mapDecal(surface, frame, width, height, 2);
    if (previous !== null) {
      for (let j = 0; j < grid.rows; j++) {
        for (let c = 0; c < grid.columns; c++) {
          const a = gridPoint(previous, c, j);
          const b = gridPoint(grid, c, j);
          if (a === null || b === null) {
            if (a !== b) {
              gaps = gaps + 1;
            }
            continue;
          }
          const jump = distance(a, b);
          const isCentre = c === (grid.columns - 1) / 2 && j === (grid.rows - 1) / 2;
          const isCorner = (c === 0 || c === grid.columns - 1) && (j === 0 || j === grid.rows - 1);
          if (isCentre) {
            centreJump = Math.max(centreJump, jump);
          }
          if (isCorner) {
            cornerJump = Math.max(cornerJump, jump);
          }
        }
      }
    }
    previous = grid;
  }
  return { centreJump: centreJump, cornerJump: cornerJump, frameTurn: (frameTurn * 180) / Math.PI, gaps: gaps };
}

describe('forward geodesic map: sliding', () => {
  it('slides round the tube across its CAD face boundaries without a jump', async () => {
    const tube = await rootPart('tube', null);
    const surface = surfaceOf([tube]);
    const rays: Array<{ origin: Vec3; direction: Vec3 }> = [];
    // A full turn in 1 degree steps (0.58 mm on the surface): crosses the
    // seams between the tube's half faces.
    for (let k = 0; k <= 360; k++) {
      const angle = (k * Math.PI) / 180;
      const out: Vec3 = [0, Math.sin(angle), Math.cos(angle)];
      rays.push({ origin: [-130, 200 * out[1], 200 * out[2]], direction: [0, -out[1], -out[2]] });
    }
    const result = slide(surface, rays, 30, 12);
    report.push('round the tube, 0.58 mm steps: centre jump ' + result.centreJump.toFixed(3) + ' mm, corner jump ' + result.cornerJump.toFixed(3) + ' mm, frame turn ' + result.frameTurn.toFixed(3) + ' deg, points appearing or vanishing ' + String(result.gaps));
    expect(result.centreJump).toBeLessThan(0.7);
    expect(result.cornerJump).toBeLessThan(0.8);
    expect(result.frameTurn).toBeLessThan(0.5);
    expect(result.gaps).toBe(0);
  });

  it('slides from the tube over the joint onto the nose without a jump', async () => {
    const both = await tubeAndNose();
    const surface = surfaceOf([both.tube, both.nose]);
    const rays: Array<{ origin: Vec3; direction: Vec3 }> = [];
    // The joint is at x = -260; go from -230 to -290 in 0.5 mm steps.
    for (let k = 0; k <= 120; k++) {
      const x = -230 - k * 0.5;
      rays.push({ origin: [x, 12, 200], direction: [0, 0, -1] });
    }
    const result = slide(surface, rays, 30, 12);
    report.push('tube to nose, 0.5 mm steps: centre jump ' + result.centreJump.toFixed(3) + ' mm, corner jump ' + result.cornerJump.toFixed(3) + ' mm, frame turn ' + result.frameTurn.toFixed(3) + ' deg, points appearing or vanishing ' + String(result.gaps));
    expect(result.centreJump).toBeLessThan(0.7);
    expect(result.cornerJump).toBeLessThan(1.0);
    expect(result.frameTurn).toBeLessThan(1.0);
    expect(result.gaps).toBe(0);
  });
});

describe('forward geodesic map: wrapping', () => {
  it('a band longer than the circumference goes round more than once and overlaps', async () => {
    const tube = await rootPart('tube', null);
    const surface = surfaceOf([tube]);
    const circumference = 2 * Math.PI * 33;
    const length = 2.6 * circumference;
    // Turned 90 degrees: the band's long axis runs round the tube.
    const grid = mapDecal(surface, frameUnder(surface, [-130, 0, 200], [0, 0, -1], Math.PI / 2), length, 10, 1);
    const middleRow = (grid.rows - 1) / 2;
    let turned = 0;
    let previous: number | null = null;
    let missing = 0;
    for (let i = 0; i < grid.columns; i++) {
      const p = gridPoint(grid, i, middleRow);
      if (p === null) {
        missing = missing + 1;
        continue;
      }
      const angle = Math.atan2(p[1], p[2]);
      if (previous !== null) {
        let step = angle - previous;
        if (step > Math.PI) {
          step = step - 2 * Math.PI;
        } else if (step < -Math.PI) {
          step = step + 2 * Math.PI;
        }
        turned = turned + step;
      }
      previous = angle;
    }
    const degrees = (Math.abs(turned) * 180) / Math.PI;
    report.push('band of ' + length.toFixed(1) + ' mm round the tube: spine turns ' + degrees.toFixed(2) + ' degrees (expected ' + ((length / circumference) * 360).toFixed(2) + '), missing points ' + String(missing));
    expect(missing).toBe(0);
    expect(degrees).toBeGreaterThan(360);
    expect(Math.abs(degrees - (length / circumference) * 360)).toBeLessThan(1);
    // The band stays at its station (no drift along the tube).
    const first = gridPoint(grid, 0, middleRow);
    const last = gridPoint(grid, grid.columns - 1, middleRow);
    if (first === null || last === null) {
      throw new Error('band ends missing');
    }
    report.push('band drift along the axis over ' + length.toFixed(0) + ' mm: ' + Math.abs(first[0] - last[0]).toExponential(2) + ' mm');
    expect(Math.abs(first[0] - last[0])).toBeLessThan(0.05);
  });

  it('prints the measurements', () => {
    console.log(report.join('\n'));
  });
});
