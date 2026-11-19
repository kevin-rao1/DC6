// Long axis and nose detection, on every test model.

import { describe, expect, it } from 'vitest';
import { angleBetweenDegrees, dot, sub, scale, cross } from '../src/geometry/vec3.ts';
import type { Vec3 } from '../src/geometry/types.ts';
import { loadModel, manifest } from './models.ts';
import { symmetricEigen3 } from '../src/geometry/axis.ts';

function distancePointToLine(point: Vec3, origin: Vec3, direction: Vec3): number {
  const offset = sub(point, origin);
  const along = dot(offset, direction);
  const perpendicular = sub(offset, scale(direction, along));
  return Math.sqrt(dot(perpendicular, perpendicular));
}

describe('axis detection', () => {
  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i];
    const name = entry.file.replace('.step', '');
    it(name + ': axis within 0.1 degree, through the right line', async () => {
      const model = await loadModel(name);
      const angle = angleBetweenDegrees(model.axis.direction, entry.axis, true);
      expect(angle).toBeLessThan(0.1);
      // The detected line passes through the true axis line.
      expect(distancePointToLine(entry.axisPoint, model.axis.origin, model.axis.direction)).toBeLessThan(0.5);
    });
    if (entry.noseKnown) {
      it(name + ': nose end is found', async () => {
        const model = await loadModel(name);
        expect(dot(model.axis.direction, entry.axis)).toBeGreaterThan(0);
        expect(model.axis.noseConfidence).toBe('clear');
      });
    }
  }

  it('the off-axis spline body (no analytic faces) is found by the normal fit', async () => {
    const model = await loadModel('spline-body');
    expect(model.axis.source).toBe('normal-fit');
  });

  it('a symmetric cylinder is marked nose-uncertain rather than guessed silently', async () => {
    const model = await loadModel('cylinder-two-halves');
    expect(model.axis.noseConfidence).toBe('uncertain');
  });

  it('the lengthened rocket is 10 mm longer', async () => {
    const plain = await loadModel('rocket-assembly');
    const long = await loadModel('rocket-long');
    const plainLength = plain.axis.stationMax - plain.axis.stationMin;
    const longLength = long.axis.stationMax - long.axis.stationMin;
    expect(longLength - plainLength).toBeCloseTo(10, 3);
  });
});

describe('symmetric eigen solver', () => {
  it('recovers a known eigenvector', () => {
    // A matrix with eigenvalues 9, 4, 1 along a rotated frame.
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const u: Vec3 = [c, s, 0];
    const v: Vec3 = [-s, c, 0];
    const w = cross(u, v);
    const values = [9, 4, 1];
    const frames = [u, v, w];
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < 3; k++) {
      for (let r = 0; r < 3; r++) {
        for (let q = 0; q < 3; q++) {
          m[3 * r + q] = m[3 * r + q] + values[k] * frames[k][r] * frames[k][q];
        }
      }
    }
    const eigen = symmetricEigen3(m);
    let largest = 0;
    for (let k = 1; k < 3; k++) {
      if (eigen.values[k] > eigen.values[largest]) {
        largest = k;
      }
    }
    expect(eigen.values[largest]).toBeCloseTo(9, 10);
    const vector: Vec3 = [eigen.vectors[largest], eigen.vectors[3 + largest], eigen.vectors[6 + largest]];
    expect(angleBetweenDegrees(vector, u, true)).toBeLessThan(1e-6);
  });
});
