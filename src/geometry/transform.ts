// Rigid transforms (rotation then translation) as plain data, so they can be
// stored in the assembly document and compared in tests.
//
//   world point = rotate(rotation, local point) + position
//
// Rotations are unit quaternions [x, y, z, w], the same order three.js uses.

import type { Vec3 } from './vec3.ts';
import { add, cross, dot, length, normalize, anyPerpendicular } from './vec3.ts';

export type Quat = [number, number, number, number];

export interface RigidTransform {
  position: Vec3;
  rotation: Quat;
}

export function identityQuat(): Quat {
  return [0, 0, 0, 1];
}

export function identityTransform(): RigidTransform {
  return { position: [0, 0, 0], rotation: identityQuat() };
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const unit = normalize(axis);
  const s = Math.sin(angle / 2);
  return [unit[0] * s, unit[1] * s, unit[2] * s, Math.cos(angle / 2)];
}

// a * b: rotate by b first, then by a.
export function multiplyQuat(a: Quat, b: Quat): Quat {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  return normalizeQuat([x, y, z, w]);
}

export function normalizeQuat(q: Quat): Quat {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (l === 0) {
    throw new Error('normalizeQuat: zero quaternion');
  }
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function conjugateQuat(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function rotateVector(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2 w (u x v) + 2 u x (u x v), with u the vector part of q.
  const u: Vec3 = [q[0], q[1], q[2]];
  const w = q[3];
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  const x = v[0] + 2 * (w * uv[0] + uuv[0]);
  const y = v[1] + 2 * (w * uv[1] + uuv[1]);
  const z = v[2] + 2 * (w * uv[2] + uuv[2]);
  return [x, y, z];
}

// The shortest rotation that turns unit vector `from` onto unit vector `to`.
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = dot(from, to);
  if (d < -0.999999) {
    // Opposite: turn half a turn about any axis perpendicular to `from`.
    const axis = anyPerpendicular(from);
    return quatFromAxisAngle(axis, Math.PI);
  }
  const c = cross(from, to);
  return normalizeQuat([c[0], c[1], c[2], 1 + d]);
}

export function applyToPoint(t: RigidTransform, p: Vec3): Vec3 {
  return add(rotateVector(t.rotation, p), t.position);
}

export function applyToDirection(t: RigidTransform, d: Vec3): Vec3 {
  return rotateVector(t.rotation, d);
}

// a * b: apply b first, then a.
export function compose(a: RigidTransform, b: RigidTransform): RigidTransform {
  const rotation = multiplyQuat(a.rotation, b.rotation);
  const position = applyToPoint(a, b.position);
  return { position: position, rotation: rotation };
}

export function invert(t: RigidTransform): RigidTransform {
  const inverseRotation = conjugateQuat(t.rotation);
  const rotatedPosition = rotateVector(inverseRotation, t.position);
  const position: Vec3 = [-rotatedPosition[0], -rotatedPosition[1], -rotatedPosition[2]];
  return { position: position, rotation: inverseRotation };
}

// A rotation about an axis line (through `point`, along `axis`) as a rigid transform.
export function rotationAboutLine(point: Vec3, axis: Vec3, angle: number): RigidTransform {
  const rotation = quatFromAxisAngle(axis, angle);
  const rotatedPoint = rotateVector(rotation, point);
  const position: Vec3 = [point[0] - rotatedPoint[0], point[1] - rotatedPoint[1], point[2] - rotatedPoint[2]];
  return { position: position, rotation: rotation };
}

export function cloneTransform(t: RigidTransform): RigidTransform {
  return {
    position: [t.position[0], t.position[1], t.position[2]],
    rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
  };
}

// The angle of the rotation q, in radians, 0 to pi.
export function quatAngle(q: Quat): number {
  const w = Math.min(1, Math.abs(q[3]));
  return 2 * Math.acos(w);
}

export function vectorLength(v: Vec3): number {
  return length(v);
}
