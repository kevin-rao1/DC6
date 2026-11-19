// STEP import: surface types per face, face ids per triangle, units.

import { describe, expect, it } from 'vitest';
import { SurfaceKind } from '../src/geometry/types.ts';
import type { DcModel } from '../src/geometry/types.ts';
import { loadModel, manifest } from './models.ts';
import { rocket } from '../tools/test-model-params.ts';

function kindCounts(model: DcModel): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let f = 0; f < model.faces.length; f++) {
    const kind = model.faces[f].surface.kind;
    const previous = counts[kind];
    if (previous === undefined) {
      counts[kind] = 1;
    } else {
      counts[kind] = previous + 1;
    }
  }
  return counts;
}

describe('surface types come through per face', () => {
  it('the two-half-face cylinder has two cylinder faces of radius 50 on the Z axis', async () => {
    const model = await loadModel('cylinder-two-halves');
    const counts = kindCounts(model);
    expect(counts[SurfaceKind.Cylinder]).toBe(2);
    expect(counts[SurfaceKind.Plane]).toBe(4);
    for (let f = 0; f < model.faces.length; f++) {
      const surface = model.faces[f].surface;
      if (surface.kind !== SurfaceKind.Cylinder) {
        continue;
      }
      expect(surface.radius).toBeCloseTo(50, 9);
      const direction = surface.axisDirection;
      expect(direction).not.toBeNull();
      if (direction !== null) {
        expect(Math.abs(direction[2])).toBeCloseTo(1, 12);
      }
    }
  });

  it('the cone has a cone face with the right half angle, and is 300 mm long though written in inches', async () => {
    const model = await loadModel('cone');
    expect(model.sourceUnit).toBe('inch');
    const counts = kindCounts(model);
    expect(counts[SurfaceKind.Cone]).toBe(1);
    expect(counts[SurfaceKind.Plane]).toBe(1);
    for (let f = 0; f < model.faces.length; f++) {
      const surface = model.faces[f].surface;
      if (surface.kind === SurfaceKind.Cone) {
        const expected = Math.atan2(50, 300);
        expect(Math.abs(surface.semiAngle as number)).toBeCloseTo(expected, 9);
      }
    }
    expect(model.axis.stationMax - model.axis.stationMin).toBeCloseTo(300, 3);
  });

  it('the ogive side is a surface of revolution', async () => {
    const model = await loadModel('ogive-nose');
    const counts = kindCounts(model);
    expect(counts[SurfaceKind.Revolution]).toBe(1);
    expect(counts[SurfaceKind.Plane]).toBe(1);
  });

  it("the spline body's side face is a B-spline (freeform) face", async () => {
    const model = await loadModel('spline-body');
    const counts = kindCounts(model);
    expect(counts[SurfaceKind.Freeform]).toBe(1);
    expect(counts[SurfaceKind.Plane]).toBe(2);
    for (let f = 0; f < model.faces.length; f++) {
      const surface = model.faces[f].surface;
      if (surface.kind === SurfaceKind.Freeform) {
        expect(surface.occType).toBe('BSplineSurface');
      }
    }
  });

  it('the rocket has a cylinder tube, a cone boattail, a revolution nose and B-spline fillets', async () => {
    const model = await loadModel('rocket-assembly');
    const counts = kindCounts(model);
    expect(counts[SurfaceKind.Cone]).toBe(1);
    expect(counts[SurfaceKind.Revolution]).toBe(1);
    expect(counts[SurfaceKind.Freeform]).toBeGreaterThan(0);
    let tubeFound = false;
    for (let f = 0; f < model.faces.length; f++) {
      const surface = model.faces[f].surface;
      if (surface.kind === SurfaceKind.Cylinder && Math.abs((surface.radius as number) - rocket.bodyRadius) < 1e-9) {
        tubeFound = true;
      }
    }
    expect(tubeFound).toBe(true);
  });
});

describe('every triangle has a face id', () => {
  for (let i = 0; i < manifest.length; i++) {
    const name = manifest[i].file.replace('.step', '');
    it(name + ': faces cover the triangles exactly, in runs', async () => {
      const model = await loadModel(name);
      const triangleCount = model.mesh.triangleFace.length;
      expect(triangleCount).toBeGreaterThan(0);
      expect(model.faces.length).toBe(manifest[i].faceCount);
      let covered = 0;
      for (let f = 0; f < model.faces.length; f++) {
        const face = model.faces[f];
        expect(face.id).toBe(f);
        expect(face.triangleCount).toBeGreaterThan(0);
        expect(face.triangleStart).toBe(covered);
        for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t++) {
          if (model.mesh.triangleFace[t] !== f) {
            throw new Error('triangle ' + t + ' should belong to face ' + f + ' but has ' + model.mesh.triangleFace[t]);
          }
        }
        covered = covered + face.triangleCount;
      }
      expect(covered).toBe(triangleCount);
    });
  }
});
