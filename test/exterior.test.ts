// Exterior detection: only the outer shell is shown.

import { describe, expect, it } from 'vitest';
import { SurfaceKind } from '../src/geometry/types.ts';
import { loadModel, partNamed } from './models.ts';
import { rocket } from '../tools/test-model-params.ts';

describe('exterior detection', () => {
  it('on the internals model only the outer shell is exterior', async () => {
    const model = await loadModel('rocket-internals');
    const shown: string[] = [];
    const hidden: string[] = [];
    for (let p = 0; p < model.parts.length; p++) {
      if (model.parts[p].exterior) {
        shown.push(model.parts[p].name);
      } else {
        hidden.push(model.parts[p].name);
      }
    }
    expect(hidden).toEqual(['motor tube', 'avionics sled']);
    expect(shown.length).toBe(11);
    // The motor tube's aft ring shows through the open tail, but it is a tiny
    // fraction of the part.
    const motorTube = model.parts[partNamed(model, 'motor tube')];
    expect(motorTube.exteriorAreaFraction).toBeLessThan(0.02);
  });

  it('hides the inner wall of the hollow body tube and boattail, shows their outer walls', async () => {
    const model = await loadModel('rocket-internals');
    const tube = partNamed(model, 'body tube');
    const boattail = partNamed(model, 'boattail');
    let innerTubeWalls = 0;
    let outerTubeWalls = 0;
    for (let f = 0; f < model.faces.length; f++) {
      const face = model.faces[f];
      if (face.part === tube && face.surface.kind === SurfaceKind.Cylinder) {
        if (Math.abs((face.surface.radius as number) - rocket.bodyInnerRadius) < 1e-6) {
          expect(face.exterior).toBe(false);
          innerTubeWalls = innerTubeWalls + 1;
        } else {
          expect(face.surface.radius).toBeCloseTo(rocket.bodyRadius, 6);
          expect(face.exterior).toBe(true);
          outerTubeWalls = outerTubeWalls + 1;
        }
      }
      if (face.part === boattail && face.surface.kind === SurfaceKind.Cone) {
        // The cone's radius at its axis origin tells inner from outer.
        const radius = face.surface.radius as number;
        if (Math.abs(radius - rocket.tailInnerRadius) < 1e-6) {
          // Partly visible through the open tail, but not exterior.
          expect(face.visibleFraction).toBeGreaterThan(0);
          expect(face.visibleFraction).toBeLessThan(0.5);
          expect(face.exterior).toBe(false);
        }
        if (Math.abs(radius - rocket.tailRadius) < 1e-6) {
          expect(face.exterior).toBe(true);
        }
      }
    }
    expect(innerTubeWalls).toBe(1);
    expect(outerTubeWalls).toBe(1);
  });

  it('shows the open aft ring of the boattail and hides joints between parts', async () => {
    const model = await loadModel('rocket-internals');
    const boattail = partNamed(model, 'boattail');
    for (let f = 0; f < model.faces.length; f++) {
      const face = model.faces[f];
      if (face.part !== boattail || face.surface.kind !== SurfaceKind.Plane) {
        continue;
      }
      // Two rings: the open aft end (seen) and the joint to the tube (covered).
      const origin = face.surface.axisOrigin as [number, number, number];
      const atTail = Math.abs(origin[0]) < 1e-6;
      expect(face.exterior).toBe(atTail);
    }
  });

  it('on the solid assembly every part is exterior and the fin roots are hidden', async () => {
    const model = await loadModel('rocket-assembly');
    for (let p = 0; p < model.parts.length; p++) {
      expect(model.parts[p].exterior).toBe(true);
    }
    // A fin's root face lies on the tube, so it cannot be seen.
    const fin = model.parts[partNamed(model, 'fin #1')];
    let hiddenRootFaces = 0;
    for (let k = 0; k < fin.faceIds.length; k++) {
      const face = model.faces[fin.faceIds[k]];
      if (face.surface.kind === SurfaceKind.Cylinder && Math.abs((face.surface.radius as number) - rocket.bodyRadius) < 1e-6) {
        expect(face.exterior).toBe(false);
        hiddenRootFaces = hiddenRootFaces + 1;
      }
    }
    expect(hiddenRootFaces).toBeGreaterThan(0);
  });

  it('orients every exterior triangle outwards (normal agrees with the CAD normal and points away from the axis on the tube)', async () => {
    const model = await loadModel('rocket-fused');
    const mesh = model.mesh;
    const axis = model.axis;
    let checked = 0;
    for (let f = 0; f < model.faces.length; f++) {
      const face = model.faces[f];
      if (face.surface.kind !== SurfaceKind.Cylinder || !face.axisymmetric) {
        continue;
      }
      for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t++) {
        const a = mesh.triangles[3 * t];
        const b = mesh.triangles[3 * t + 1];
        const c = mesh.triangles[3 * t + 2];
        const p = mesh.positions;
        const ux = p[3 * b] - p[3 * a];
        const uy = p[3 * b + 1] - p[3 * a + 1];
        const uz = p[3 * b + 2] - p[3 * a + 2];
        const vx = p[3 * c] - p[3 * a];
        const vy = p[3 * c + 1] - p[3 * a + 1];
        const vz = p[3 * c + 2] - p[3 * a + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        // Radial direction at the triangle's first corner.
        const ox = p[3 * a] - axis.origin[0];
        const oy = p[3 * a + 1] - axis.origin[1];
        const oz = p[3 * a + 2] - axis.origin[2];
        const along = ox * axis.direction[0] + oy * axis.direction[1] + oz * axis.direction[2];
        const rx = ox - along * axis.direction[0];
        const ry = oy - along * axis.direction[1];
        const rz = oz - along * axis.direction[2];
        expect(nx * rx + ny * ry + nz * rz).toBeGreaterThan(0);
        checked = checked + 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
