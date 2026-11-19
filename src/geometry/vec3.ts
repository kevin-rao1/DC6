// Small 3-vector helpers on [x, y, z] tuples. Hot loops in the other modules
// read typed arrays directly instead of making tuples; these are for the
// places where clarity matters more than speed.

import type { Vec3 } from './types.ts';

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

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (!(l > 0)) {
    throw new Error('normalize: expected a non-zero vector, got ' + a.join(','));
  }
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Angle between two directions in degrees, ignoring sign (0..90) when
// `ignoreSign` is set, so that an axis and its reverse count as the same.
export function angleBetweenDegrees(a: Vec3, b: Vec3, ignoreSign: boolean): number {
  const na = normalize(a);
  const nb = normalize(b);
  let c = dot(na, nb);
  if (ignoreSign) {
    c = Math.abs(c);
  }
  if (c > 1) {
    c = 1;
  }
  if (c < -1) {
    c = -1;
  }
  return (Math.acos(c) * 180) / Math.PI;
}

// Two unit vectors perpendicular to `axis` and to each other, so that
// (u, v, axis) is right-handed. Deterministic: u is built from whichever world
// axis is least parallel to `axis`.
export function perpendicularFrame(axis: Vec3): { u: Vec3; v: Vec3 } {
  const w = normalize(axis);
  let helper: Vec3 = [1, 0, 0];
  if (Math.abs(w[0]) > 0.9) {
    helper = [0, 1, 0];
  }
  const along = dot(helper, w);
  const uRaw = sub(helper, scale(w, along));
  const u = normalize(uRaw);
  const v = cross(w, u);
  return { u: u, v: v };
}

// Read vertex i of a flat position array.
export function readPoint(positions: ArrayLike<number>, i: number): Vec3 {
  const base = 3 * i;
  return [positions[base], positions[base + 1], positions[base + 2]];
}

// Rotation matrix (row-major 4x4) for a rotation by `angle` radians about the
// line through `origin` with unit direction `axis` (right-hand rule).
export function rotationAboutLine(origin: Vec3, axis: Vec3, angle: number): number[] {
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const x = k[0];
  const y = k[1];
  const z = k[2];
  // Rodrigues' rotation formula.
  const r00 = t * x * x + c;
  const r01 = t * x * y - s * z;
  const r02 = t * x * z + s * y;
  const r10 = t * x * y + s * z;
  const r11 = t * y * y + c;
  const r12 = t * y * z - s * x;
  const r20 = t * x * z - s * y;
  const r21 = t * y * z + s * x;
  const r22 = t * z * z + c;
  // Translation so that points on the line stay put: p' = R (p - o) + o.
  const ro0 = r00 * origin[0] + r01 * origin[1] + r02 * origin[2];
  const ro1 = r10 * origin[0] + r11 * origin[1] + r12 * origin[2];
  const ro2 = r20 * origin[0] + r21 * origin[1] + r22 * origin[2];
  const t0 = origin[0] - ro0;
  const t1 = origin[1] - ro1;
  const t2 = origin[2] - ro2;
  return [r00, r01, r02, t0, r10, r11, r12, t1, r20, r21, r22, t2, 0, 0, 0, 1];
}

export function transformPoint(m: number[], p: Vec3): Vec3 {
  const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
  const y = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7];
  const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
  return [x, y, z];
}
