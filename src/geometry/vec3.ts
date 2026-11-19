// Small 3D vector helpers on plain [x, y, z] arrays.
//
// The geometry layer does not use three.js, so that it can run in the import
// worker and under Node, and so that its maths can be read on its own.

export type Vec3 = [number, number, number];

export function vec(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  return [x, y, z];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l === 0) {
    throw new Error('normalize: zero-length vector');
  }
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Any unit vector perpendicular to the unit vector a.
export function anyPerpendicular(a: Vec3): Vec3 {
  let helper: Vec3 = [1, 0, 0];
  if (Math.abs(a[0]) > 0.6) {
    helper = [0, 1, 0];
  }
  return normalize(cross(a, helper));
}

// Read point number i from a flat xyz array.
export function pointAt(array: ArrayLike<number>, i: number): Vec3 {
  return [array[3 * i], array[3 * i + 1], array[3 * i + 2]];
}
