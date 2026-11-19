// The ray casting and closest-point queries used by exterior detection,
// contacts and instance matching.

import { describe, expect, it } from 'vitest';
import { buildBvh, closestTriangle, makeTraversalStack, rayHitsAny } from '../src/geometry/bvh.ts';

// A unit cube from 0 to 1, as 12 triangles.
function cube(): { positions: Float64Array; triangles: Uint32Array } {
  const positions = new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const triangles = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions: positions, triangles: triangles };
}

describe('bvh', () => {
  it('a ray from inside the cube always hits; a ray pointing away from outside never does', () => {
    const shape = cube();
    const bvh = buildBvh(shape.positions, shape.triangles, null);
    const stack = makeTraversalStack(bvh);
    const directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0.6, 0.48, -0.64],
    ];
    for (let i = 0; i < directions.length; i++) {
      const d = directions[i];
      expect(rayHitsAny(bvh, 0.5, 0.5, 0.5, d[0], d[1], d[2], 0, Infinity, stack)).toBe(true);
    }
    expect(rayHitsAny(bvh, 2, 0.5, 0.5, 1, 0, 0, 0, Infinity, stack)).toBe(false);
    expect(rayHitsAny(bvh, 2, 0.5, 0.5, -1, 0, 0, 0, Infinity, stack)).toBe(true);
    // Limited range: the cube is 1 away, so a range of 0.5 misses it.
    expect(rayHitsAny(bvh, 2, 0.5, 0.5, -1, 0, 0, 0, 0.5, stack)).toBe(false);
  });

  it('finds the closest triangle and its distance', () => {
    const shape = cube();
    const bvh = buildBvh(shape.positions, shape.triangles, null);
    const hit = closestTriangle(bvh, 0.5, 0.5, 1.25, 1, null, -1);
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.distance).toBeCloseTo(0.25, 12);
      expect(hit.point[2]).toBeCloseTo(1, 12);
    }
    expect(closestTriangle(bvh, 0.5, 0.5, 3, 1, null, -1)).toBeNull();
  });
});
