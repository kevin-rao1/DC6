// A bounding volume hierarchy over a part's triangles, for ray casts:
// picking under the cursor (60 times a second while a part is held).
//
// Built once per part, top down: split the triangles at the median of their
// centres along the longest axis of their box, until a node holds at most
// leafSize triangles. Stored in flat typed arrays (see Bvh in part.ts) so it
// can be sent from the worker.

import type { Bvh } from './part.ts';
import type { Vec3 } from './vec3.ts';

const leafSize = 8;

export function buildBvh(positions: Float32Array, indices: Uint32Array): Bvh {
  const triangleCount = indices.length / 3;
  const order = new Uint32Array(triangleCount);
  const centres = new Float32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    order[t] = t;
    for (let axis = 0; axis < 3; axis++) {
      const a = positions[3 * indices[3 * t] + axis];
      const b = positions[3 * indices[3 * t + 1] + axis];
      const c = positions[3 * indices[3 * t + 2] + axis];
      centres[3 * t + axis] = (a + b + c) / 3;
    }
  }
  const bounds: number[] = [];
  const nodes: number[] = [];

  function boxOf(first: number, count: number): number[] {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = first; k < first + count; k++) {
      const t = order[k];
      for (let corner = 0; corner < 3; corner++) {
        const vertex = indices[3 * t + corner];
        for (let axis = 0; axis < 3; axis++) {
          const value = positions[3 * vertex + axis];
          if (value < box[axis]) {
            box[axis] = value;
          }
          if (value > box[3 + axis]) {
            box[3 + axis] = value;
          }
        }
      }
    }
    return box;
  }

  // Build the node for order[first .. first + count) and return its index.
  function build(first: number, count: number): number {
    const nodeIndex = nodes.length / 2;
    const box = boxOf(first, count);
    for (let k = 0; k < 6; k++) {
      bounds.push(box[k]);
    }
    if (count <= leafSize) {
      nodes.push(first, count);
      return nodeIndex;
    }
    // Reserve this node; its right child index is written after the left
    // subtree is built.
    nodes.push(0, 0);
    let axis = 0;
    let longest = box[3] - box[0];
    for (let a = 1; a < 3; a++) {
      if (box[3 + a] - box[a] > longest) {
        longest = box[3 + a] - box[a];
        axis = a;
      }
    }
    // Sort this range by centre along the axis and split it in half.
    const range = Array.from(order.subarray(first, first + count));
    range.sort(function byCentre(p, q) {
      return centres[3 * p + axis] - centres[3 * q + axis];
    });
    for (let k = 0; k < count; k++) {
      order[first + k] = range[k];
    }
    const half = Math.floor(count / 2);
    build(first, half);
    const right = build(first + half, count - half);
    // Inner node marker: count 0 never happens for a leaf (leaves hold >= 1).
    nodes[2 * nodeIndex] = right;
    nodes[2 * nodeIndex + 1] = 0;
    return nodeIndex;
  }

  if (triangleCount > 0) {
    build(0, triangleCount);
  }
  return { bounds: new Float32Array(bounds), nodes: new Uint32Array(nodes), order: order };
}

export interface RayHit {
  distance: number;
  triangle: number;
}

// Does the ray hit the box, closer than maxDistance? (slab test)
function rayHitsBox(bounds: Float32Array, node: number, origin: Vec3, inverse: Vec3, maxDistance: number): boolean {
  let near = 0;
  let far = maxDistance;
  for (let axis = 0; axis < 3; axis++) {
    const t1 = (bounds[6 * node + axis] - origin[axis]) * inverse[axis];
    const t2 = (bounds[6 * node + 3 + axis] - origin[axis]) * inverse[axis];
    const tMin = Math.min(t1, t2);
    const tMax = Math.max(t1, t2);
    near = Math.max(near, tMin);
    far = Math.min(far, tMax);
    if (near > far) {
      return false;
    }
  }
  return true;
}

// Moller-Trumbore. Returns the distance along the (unit) ray, or -1. Both
// sides of a triangle count.
function rayTriangle(positions: Float32Array, indices: Uint32Array, t: number, origin: Vec3, direction: Vec3): number {
  const i0 = 3 * indices[3 * t];
  const i1 = 3 * indices[3 * t + 1];
  const i2 = 3 * indices[3 * t + 2];
  const e1x = positions[i1] - positions[i0];
  const e1y = positions[i1 + 1] - positions[i0 + 1];
  const e1z = positions[i1 + 2] - positions[i0 + 2];
  const e2x = positions[i2] - positions[i0];
  const e2y = positions[i2 + 1] - positions[i0 + 1];
  const e2z = positions[i2 + 2] - positions[i0 + 2];
  const px = direction[1] * e2z - direction[2] * e2y;
  const py = direction[2] * e2x - direction[0] * e2z;
  const pz = direction[0] * e2y - direction[1] * e2x;
  const determinant = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(determinant) < 1e-12) {
    return -1;
  }
  const inverse = 1 / determinant;
  const sx = origin[0] - positions[i0];
  const sy = origin[1] - positions[i0 + 1];
  const sz = origin[2] - positions[i0 + 2];
  const u = (sx * px + sy * py + sz * pz) * inverse;
  if (u < 0 || u > 1) {
    return -1;
  }
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inverse;
  if (v < 0 || u + v > 1) {
    return -1;
  }
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  if (distance < 0) {
    return -1;
  }
  return distance;
}

// Every triangle whose bounding box comes within `radius` of `point` (a
// superset of the triangles within that distance; the caller measures).
// Used to find where a decal continues onto a neighbouring part.
export function trianglesNear(bvh: Bvh, point: Vec3, radius: number): number[] {
  const result: number[] = [];
  if (bvh.nodes.length === 0) {
    return result;
  }
  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    let outside = false;
    for (let axis = 0; axis < 3; axis++) {
      if (point[axis] < bvh.bounds[6 * node + axis] - radius || point[axis] > bvh.bounds[6 * node + 3 + axis] + radius) {
        outside = true;
        break;
      }
    }
    if (outside) {
      continue;
    }
    const first = bvh.nodes[2 * node];
    const count = bvh.nodes[2 * node + 1];
    if (count > 0) {
      for (let k = first; k < first + count; k++) {
        result.push(bvh.order[k]);
      }
    } else {
      stack.push(first);
      stack.push(node + 1);
    }
  }
  return result;
}

// The nearest hit of a ray (direction must be unit length), or null.
export function raycast(
  bvh: Bvh,
  positions: Float32Array,
  indices: Uint32Array,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
): RayHit | null {
  if (bvh.nodes.length === 0) {
    return null;
  }
  const inverse: Vec3 = [1 / direction[0], 1 / direction[1], 1 / direction[2]];
  let best: RayHit | null = null;
  let limit = maxDistance;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    if (!rayHitsBox(bvh.bounds, node, origin, inverse, limit)) {
      continue;
    }
    const first = bvh.nodes[2 * node];
    const count = bvh.nodes[2 * node + 1];
    if (count > 0) {
      for (let k = first; k < first + count; k++) {
        const t = bvh.order[k];
        const d = rayTriangle(positions, indices, t, origin, direction);
        if (d >= 0 && d < limit) {
          limit = d;
          best = { distance: d, triangle: t };
        }
      }
    } else {
      // Inner node: left child follows it, `first` holds the right child.
      stack.push(first);
      stack.push(node + 1);
    }
  }
  return best;
}
