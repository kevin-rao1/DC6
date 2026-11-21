// Where a part goes when it is joined to something. Pure maths on rigid
// transforms; the editor decides when to call which.
//
// A "face" here is an attach face in the part's own frame: a centre, an
// outward normal, and (for side attach) the direction its outline is longest.

import type { Vec3 } from './vec3.ts';
import { cross, dot, length, normalize, scale, sub } from './vec3.ts';
import type { Quat, RigidTransform } from './transform.ts';
import {
  applyToDirection,
  multiplyQuat,
  quatFromAxisAngle,
  quatFromUnitVectors,
  rotateVector,
  rotationAboutLine,
  compose,
} from './transform.ts';
import { AXIS_ORIGIN, NOSE_DIRECTION } from './rocket-axis.ts';

export interface LocalFace {
  centre: Vec3;
  normal: Vec3;
}

// Put rotation `rotation` and then translate so the local point lands on `target`.
function placeWithRotation(rotation: Quat, localPoint: Vec3, target: Vec3): RigidTransform {
  const rotated = rotateVector(rotation, localPoint);
  const position = sub(target, rotated);
  return { position: position, rotation: rotation };
}

// Face to face: the moving part's face centre goes onto the target centre and
// its normal turns to point against the target normal (the two faces touch).
// Of all rotations that do that, the one closest to the part's current
// orientation is used, then `roll` (radians) about the target normal is added.
export function mateFaces(face: LocalFace, current: RigidTransform, targetCentre: Vec3, targetNormal: Vec3, roll: number): RigidTransform {
  const currentNormal = applyToDirection(current, face.normal);
  const wanted = scale(targetNormal, -1);
  const turn = quatFromUnitVectors(normalize(currentNormal), normalize(wanted));
  let rotation = multiplyQuat(turn, current.rotation);
  if (roll !== 0) {
    rotation = multiplyQuat(quatFromAxisAngle(targetNormal, roll), rotation);
  }
  return placeWithRotation(rotation, face.centre, targetCentre);
}

// The root: its chosen face becomes the aft-facing face, centred on the axis.
// That is mating against an imaginary face at the origin pointing at the nose.
export function placeRoot(face: LocalFace, current: RigidTransform, roll: number): RigidTransform {
  return mateFaces(face, current, AXIS_ORIGIN, NOSE_DIRECTION, roll);
}

export interface SideFace extends LocalFace {
  longDirection: Vec3;
}

// Side attach (a fin onto a tube): the face sits at `point` against the
// surface (normal opposed to surfaceNormal), turned so its long direction
// runs along the rocket axis. Of the two ways round, the one that puts the
// part's centre (`partCentre`, local) aft of the attach point is used: a
// swept fin trails backwards. Then `roll` is added about the surface normal.
export function attachToSurface(
  face: SideFace,
  partCentre: Vec3,
  current: RigidTransform,
  point: Vec3,
  surfaceNormal: Vec3,
  roll: number,
): RigidTransform {
  const m = normalize(surfaceNormal);
  const first = mateFaces(face, current, point, m, 0);
  // The axis direction as seen on the surface's tangent plane.
  const along = sub(NOSE_DIRECTION, scale(m, dot(NOSE_DIRECTION, m)));
  let rotation = first.rotation;
  if (length(along) > 1e-6) {
    const axisOnSurface = normalize(along);
    const longNow = applyToDirection(first, face.longDirection);
    // Signed angle from longNow to axisOnSurface about m.
    const sine = dot(cross(longNow, axisOnSurface), m);
    const cosine = dot(longNow, axisOnSurface);
    const angle = Math.atan2(sine, cosine);
    const optionA = multiplyQuat(quatFromAxisAngle(m, angle), first.rotation);
    const optionB = multiplyQuat(quatFromAxisAngle(m, angle + Math.PI), first.rotation);
    const offset = sub(partCentre, face.centre);
    const aftOfA = -dot(rotateVector(optionA, offset), NOSE_DIRECTION);
    const aftOfB = -dot(rotateVector(optionB, offset), NOSE_DIRECTION);
    if (aftOfA >= aftOfB) {
      rotation = optionA;
    } else {
      rotation = optionB;
    }
  }
  if (roll !== 0) {
    rotation = multiplyQuat(quatFromAxisAngle(m, roll), rotation);
  }
  return placeWithRotation(rotation, face.centre, point);
}

// Rotation by angle about the rocket axis, as a rigid transform.
export function aboutAxis(angle: number): RigidTransform {
  return rotationAboutLine(AXIS_ORIGIN, NOSE_DIRECTION, angle);
}

// The transforms of a radial symmetry set: copy k is copy 0 turned by
// k/count of a turn about the rocket axis.
export function symmetryTransforms(first: RigidTransform, count: number): RigidTransform[] {
  if (count < 1) {
    throw new Error('symmetryTransforms: count must be at least 1, got ' + String(count));
  }
  const result: RigidTransform[] = [];
  for (let k = 0; k < count; k++) {
    const turn = aboutAxis((2 * Math.PI * k) / count);
    result.push(compose(turn, first));
  }
  return result;
}

// Distance of a world point from the rocket axis.
export function distanceFromAxis(point: Vec3): number {
  const relative = sub(point, AXIS_ORIGIN);
  const along = dot(relative, NOSE_DIRECTION);
  const radial = sub(relative, scale(NOSE_DIRECTION, along));
  return length(radial);
}
