import { describe, expect, it } from 'vitest';
import type { RigidTransform } from '../src/geometry/transform.ts';
import { applyToDirection, applyToPoint, quatFromAxisAngle } from '../src/geometry/transform.ts';
import { attachToSurface, distanceFromAxis, mateFaces, placeRoot, symmetryTransforms } from '../src/geometry/mating.ts';
import { AFT_DIRECTION, NOSE_DIRECTION } from '../src/geometry/rocket-axis.ts';
import { cross, dot, distance, length, normalize, sub } from '../src/geometry/vec3.ts';
import type { Vec3 } from '../src/geometry/vec3.ts';

const someOrientation: RigidTransform = {
  position: [12, -7, 30],
  rotation: quatFromAxisAngle([0.3, 1, -0.2], 1.1),
};

describe('mating', () => {
  it('two discs mated are coaxial and touching with opposed normals', () => {
    const face = { centre: [3, 4, 5] as Vec3, normal: normalize([1, 2, -0.5]) };
    const targetCentre: Vec3 = [-40, 10, 2];
    const targetNormal = normalize([0.2, -1, 0.4]);
    const result = mateFaces(face, someOrientation, targetCentre, targetNormal, 0.3);
    const centre = applyToPoint(result, face.centre);
    const normal = applyToDirection(result, face.normal);
    expect(distance(centre, targetCentre)).toBeLessThan(1e-6);
    expect(dot(normal, targetNormal)).toBeCloseTo(-1, 6);
    // Coaxial: a point on the moving disc's axis lies on the target's axis.
    const onAxis = applyToPoint(result, [face.centre[0] + 10 * face.normal[0], face.centre[1] + 10 * face.normal[1], face.centre[2] + 10 * face.normal[2]]);
    const offset = sub(onAxis, targetCentre);
    expect(length(cross(offset, targetNormal))).toBeLessThan(1e-6);
  });

  it('puts the root face aft-facing at the origin', () => {
    const face = { centre: [1, 2, 3] as Vec3, normal: normalize([0, 0, 1]) };
    const result = placeRoot(face, someOrientation, 0);
    expect(length(applyToPoint(result, face.centre))).toBeLessThan(1e-9);
    expect(dot(applyToDirection(result, face.normal), AFT_DIRECTION)).toBeCloseTo(1, 9);
  });

  it('stands a fin on a tube along the axis, trailing aft', () => {
    // A fin root along local z, centre of the fin out along +x and aft (-z... arbitrary).
    const face = { centre: [0, 0, 50] as Vec3, normal: [-1, 0, 0] as Vec3, longDirection: [0, 0, 1] as Vec3 };
    const partCentre: Vec3 = [20, 0, 30];
    const point: Vec3 = [-100, 0, 33];
    const surfaceNormal: Vec3 = [0, 0, 1];
    const result = attachToSurface(face, partCentre, someOrientation, point, surfaceNormal, 0);
    expect(distance(applyToPoint(result, face.centre), point)).toBeLessThan(1e-9);
    expect(dot(applyToDirection(result, face.normal), surfaceNormal)).toBeCloseTo(-1, 9);
    expect(Math.abs(dot(applyToDirection(result, face.longDirection), NOSE_DIRECTION))).toBeCloseTo(1, 9);
    const centre = applyToPoint(result, partCentre);
    expect(dot(sub(centre, point), AFT_DIRECTION)).toBeGreaterThan(0);
  });
});

describe('symmetry', () => {
  it('spaces copies evenly around the rocket axis', () => {
    const first: RigidTransform = { position: [-50, 33, 0], rotation: quatFromAxisAngle([0, 1, 0], 0.4) };
    const copies = symmetryTransforms(first, 4);
    expect(copies.length).toBe(4);
    const probe: Vec3 = [1, 2, 3];
    const points = copies.map((c) => applyToPoint(c, probe));
    const radius = distanceFromAxis(points[0]);
    for (let k = 0; k < 4; k++) {
      expect(distanceFromAxis(points[k])).toBeCloseTo(radius, 9);
      // Same station along the axis.
      expect(dot(points[k], NOSE_DIRECTION)).toBeCloseTo(dot(points[0], NOSE_DIRECTION), 9);
    }
    // Neighbours are 90 degrees apart about the axis.
    const radial = points.map((p) => sub(p, [dot(p, NOSE_DIRECTION) * NOSE_DIRECTION[0], dot(p, NOSE_DIRECTION) * NOSE_DIRECTION[1], dot(p, NOSE_DIRECTION) * NOSE_DIRECTION[2]]));
    for (let k = 0; k < 4; k++) {
      const a = normalize(radial[k]);
      const b = normalize(radial[(k + 1) % 4]);
      expect(dot(a, b)).toBeCloseTo(0, 9);
    }
  });
});
