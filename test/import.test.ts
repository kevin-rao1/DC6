import { describe, expect, it } from 'vitest';
import { loadModel, loadPart } from './models.ts';
import { body, canard, tube, can, nose } from '../tools/test-model-dimensions.ts';

function extent(min: number[], max: number[]): number[] {
  const sizes = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  sizes.sort(function ascending(a, b) {
    return a - b;
  });
  return sizes;
}

describe('STEP import', () => {
  it('reads the tube in millimetres at its true size', async () => {
    const part = await loadPart('tube');
    expect(part.sourceUnit).toBe('millimetre');
    const sizes = extent(part.boundsMin, part.boundsMax);
    expect(sizes[0]).toBeCloseTo(2 * body.outerRadius, 1);
    expect(sizes[2]).toBeCloseTo(tube.length, 3);
  });

  it('honours a file written in inches', async () => {
    const part = await loadPart('canard');
    expect(part.sourceUnit).toBe('inch');
    // The thickness is the smallest extent; it must come out in mm, not inches.
    const sizes = extent(part.boundsMin, part.boundsMax);
    expect(sizes[0]).toBeCloseTo(canard.thickness, 3);
  });

  it('gives every triangle a CAD face, and every face its triangles', async () => {
    const part = await loadPart('can');
    const triangleCount = part.indices.length / 3;
    expect(part.triangleFace.length).toBe(triangleCount);
    const seen = new Set<number>();
    for (let t = 0; t < triangleCount; t++) {
      expect(part.triangleFace[t]).toBeLessThan(part.faces.length);
      seen.add(part.triangleFace[t]);
    }
    expect(seen.size).toBe(part.faces.length);
  });

  it('knows the surface types and their parameters', async () => {
    const tubePart = await loadPart('tube');
    const cylinders = tubePart.faces.filter((f) => f.surface === 'cylinder');
    const radii = cylinders.map((f) => f.radius).sort();
    expect(radii.length).toBe(2);
    expect(radii[0]).toBeCloseTo(body.outerRadius - body.wall, 6);
    expect(radii[1]).toBeCloseTo(body.outerRadius, 6);
    const planes = tubePart.faces.filter((f) => f.surface === 'plane');
    expect(planes.length).toBe(2);
    for (const plane of planes) {
      expect(plane.flat).toBe(true);
      // The tube file lies along X; the ends face out along X.
      expect(Math.abs(plane.flatNormal![0])).toBeCloseTo(1, 6);
    }
    const boattail = await loadPart('boattail');
    expect(boattail.faces.filter((f) => f.surface === 'cone').length).toBe(2);
    const nose = await loadPart('nose');
    expect(nose.faces.some((f) => f.surface === 'revolution')).toBe(true);
    const canPart = await loadPart('can');
    // The helical thread is swept, so it comes out as freeform faces.
    expect(canPart.faces.some((f) => f.surface === 'freeform')).toBe(true);
  });

  it('reads the threaded nose at its true size, thread and all', async () => {
    const part = await loadPart('nose');
    const sizes = extent(part.boundsMin, part.boundsMax);
    expect(sizes[2]).toBeCloseTo(nose.length, 2);
    expect(sizes[0]).toBeCloseTo(2 * body.outerRadius, 1);
    // The female thread is a swept helix: freeform faces.
    expect(part.faces.some((f) => f.surface === 'freeform')).toBe(true);
  });

  it('keeps CAD edges with circles marked', async () => {
    const part = await loadPart('can');
    const window = part.edges.filter((e) => e.circle !== null && Math.abs(e.circle.radius - can.windowRadius) < 1e-6);
    expect(window.length).toBeGreaterThan(0);
    for (const edge of part.edges) {
      expect(edge.points.length % 3).toBe(0);
    }
  });

  it('makes each solid of an assembly its own part, with its name', async () => {
    const parts = await loadModel('assembly');
    const names = parts.map((p) => p.name);
    expect(names).toEqual(['nose cone', 'body tube', 'boattail', 'avionics sled']);
    const ids = new Set(parts.map((p) => p.id));
    expect(ids.size).toBe(4);
  });

  it('reads a whole fused rocket as one part', async () => {
    const parts = await loadModel('rocket');
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('rocket');
  });

  it('tessellates finely enough that the tube is round', async () => {
    const part = await loadPart('tube');
    // Every vertex on the outer cylinder lies on it; the chord sagitta is
    // under the 0.05 mm deflection, so the polygon has at least ~56 sides.
    const outer = part.faces.findIndex((f) => f.surface === 'cylinder' && Math.abs(f.radius! - body.outerRadius) < 1e-6);
    let triangles = 0;
    for (let t = 0; t < part.triangleFace.length; t++) {
      if (part.triangleFace[t] === outer) {
        triangles = triangles + 1;
      }
    }
    expect(triangles).toBeGreaterThanOrEqual(2 * 56);
  });
});
