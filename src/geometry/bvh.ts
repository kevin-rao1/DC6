// A bounding volume hierarchy over triangles, for ray casting (exterior
// detection) and closest-point queries (contacts, instance matching).
//
// Plain binary tree with axis-aligned boxes, split at the median of triangle
// centroids along the box's longest side, stored in flat typed arrays.

export interface Bvh {
  positions: Float64Array;
  triangles: Uint32Array;
  // Triangle ids in leaf order. Leaves refer to a run of this array.
  order: Int32Array;
  // Per node: min x, y, z, max x, y, z.
  boxes: Float64Array;
  // Per node: for an inner node, left child index (right child is stored
  // right after the whole left subtree, in `right`); for a leaf, -1.
  left: Int32Array;
  right: Int32Array;
  // Per node: first index into `order` and number of triangles (leaves only).
  start: Int32Array;
  count: Int32Array;
  nodeCount: number;
}

const leafSize = 4;

// Build over the given triangle ids (all triangles if `ids` is null).
export function buildBvh(positions: Float64Array, triangles: Uint32Array, ids: Int32Array | null): Bvh {
  let order: Int32Array;
  if (ids === null) {
    const triangleCount = triangles.length / 3;
    order = new Int32Array(triangleCount);
    for (let i = 0; i < triangleCount; i++) {
      order[i] = i;
    }
  } else {
    order = ids.slice();
  }
  const n = order.length;
  // Centroids, indexed by triangle id.
  const totalTriangles = triangles.length / 3;
  const centroids = new Float64Array(totalTriangles * 3);
  for (let k = 0; k < n; k++) {
    const t = order[k];
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    for (let axis = 0; axis < 3; axis++) {
      const sum = positions[3 * a + axis] + positions[3 * b + axis] + positions[3 * c + axis];
      centroids[3 * t + axis] = sum / 3;
    }
  }
  // A binary tree with leaves of up to leafSize triangles has fewer than
  // 2n / leafSize * 2 + 1 nodes; allocate generously.
  const maxNodes = Math.max(1, 2 * Math.ceil(n / 2) + 1);
  const boxes = new Float64Array(maxNodes * 6);
  const left = new Int32Array(maxNodes);
  const right = new Int32Array(maxNodes);
  const start = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  let nodeCount = 0;

  // Iterative build with an explicit stack of (node, from, to).
  const stackNode: number[] = [];
  const stackFrom: number[] = [];
  const stackTo: number[] = [];
  nodeCount = 1;
  stackNode.push(0);
  stackFrom.push(0);
  stackTo.push(n);
  while (stackNode.length > 0) {
    const node = stackNode.pop() as number;
    const from = stackFrom.pop() as number;
    const to = stackTo.pop() as number;
    // Box of the triangles in [from, to).
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let k = from; k < to; k++) {
      const t = order[k];
      for (let corner = 0; corner < 3; corner++) {
        const v = triangles[3 * t + corner];
        const x = positions[3 * v];
        const y = positions[3 * v + 1];
        const z = positions[3 * v + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    boxes[6 * node] = minX;
    boxes[6 * node + 1] = minY;
    boxes[6 * node + 2] = minZ;
    boxes[6 * node + 3] = maxX;
    boxes[6 * node + 4] = maxY;
    boxes[6 * node + 5] = maxZ;
    const size = to - from;
    if (size <= leafSize) {
      left[node] = -1;
      right[node] = -1;
      start[node] = from;
      count[node] = size;
      continue;
    }
    // Split along the longest side of the centroid spread.
    let cMinX = Infinity;
    let cMinY = Infinity;
    let cMinZ = Infinity;
    let cMaxX = -Infinity;
    let cMaxY = -Infinity;
    let cMaxZ = -Infinity;
    for (let k = from; k < to; k++) {
      const t = order[k];
      const x = centroids[3 * t];
      const y = centroids[3 * t + 1];
      const z = centroids[3 * t + 2];
      if (x < cMinX) cMinX = x;
      if (y < cMinY) cMinY = y;
      if (z < cMinZ) cMinZ = z;
      if (x > cMaxX) cMaxX = x;
      if (y > cMaxY) cMaxY = y;
      if (z > cMaxZ) cMaxZ = z;
    }
    let axis = 0;
    let extent = cMaxX - cMinX;
    if (cMaxY - cMinY > extent) {
      axis = 1;
      extent = cMaxY - cMinY;
    }
    if (cMaxZ - cMinZ > extent) {
      axis = 2;
      extent = cMaxZ - cMinZ;
    }
    const middle = from + Math.floor(size / 2);
    partialSortByCentroid(order, centroids, axis, from, to, middle);
    const leftChild = nodeCount;
    const rightChild = nodeCount + 1;
    nodeCount = nodeCount + 2;
    left[node] = leftChild;
    right[node] = rightChild;
    start[node] = from;
    count[node] = 0;
    stackNode.push(leftChild);
    stackFrom.push(from);
    stackTo.push(middle);
    stackNode.push(rightChild);
    stackFrom.push(middle);
    stackTo.push(to);
  }
  return {
    positions: positions,
    triangles: triangles,
    order: order,
    boxes: boxes,
    left: left,
    right: right,
    start: start,
    count: count,
    nodeCount: nodeCount,
  };
}

// Rearrange order[from..to) so that the element at `kth` is the one a full
// sort by centroid coordinate would put there, smaller ones before it and
// larger after (quickselect).
function partialSortByCentroid(
  order: Int32Array,
  centroids: Float64Array,
  axis: number,
  from: number,
  to: number,
  kth: number,
): void {
  let lo = from;
  let hi = to - 1;
  while (lo < hi) {
    const pivotIndex = (lo + hi) >> 1;
    const pivot = centroids[3 * order[pivotIndex] + axis];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (centroids[3 * order[i] + axis] < pivot) {
        i = i + 1;
      }
      while (centroids[3 * order[j] + axis] > pivot) {
        j = j - 1;
      }
      if (i <= j) {
        const swap = order[i];
        order[i] = order[j];
        order[j] = swap;
        i = i + 1;
        j = j - 1;
      }
    }
    if (kth <= j) {
      hi = j;
    } else if (kth >= i) {
      lo = i;
    } else {
      return;
    }
  }
}

// Does the ray hit the box before distance tMax? Returns the entry distance or Infinity.
function rayBox(
  boxes: Float64Array,
  node: number,
  ox: number,
  oy: number,
  oz: number,
  invX: number,
  invY: number,
  invZ: number,
  tMax: number,
): number {
  const base = 6 * node;
  let t1 = (boxes[base] - ox) * invX;
  let t2 = (boxes[base + 3] - ox) * invX;
  let tNear = Math.min(t1, t2);
  let tFar = Math.max(t1, t2);
  t1 = (boxes[base + 1] - oy) * invY;
  t2 = (boxes[base + 4] - oy) * invY;
  tNear = Math.max(tNear, Math.min(t1, t2));
  tFar = Math.min(tFar, Math.max(t1, t2));
  t1 = (boxes[base + 2] - oz) * invZ;
  t2 = (boxes[base + 5] - oz) * invZ;
  tNear = Math.max(tNear, Math.min(t1, t2));
  tFar = Math.min(tFar, Math.max(t1, t2));
  if (tFar < 0 || tNear > tFar || tNear > tMax) {
    return Infinity;
  }
  return tNear;
}

// Möller-Trumbore ray-triangle intersection. Returns the ray distance or -1.
function rayTriangle(
  positions: Float64Array,
  triangles: Uint32Array,
  t: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const a = triangles[3 * t];
  const b = triangles[3 * t + 1];
  const c = triangles[3 * t + 2];
  const ax = positions[3 * a];
  const ay = positions[3 * a + 1];
  const az = positions[3 * a + 2];
  const e1x = positions[3 * b] - ax;
  const e1y = positions[3 * b + 1] - ay;
  const e1z = positions[3 * b + 2] - az;
  const e2x = positions[3 * c] - ax;
  const e2y = positions[3 * c + 1] - ay;
  const e2z = positions[3 * c + 2] - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) {
    return -1;
  }
  const invDet = 1 / det;
  const sx = ox - ax;
  const sy = oy - ay;
  const sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * invDet;
  if (u < 0 || u > 1) {
    return -1;
  }
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) {
    return -1;
  }
  const distance = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return distance;
}

// Does a ray from `origin` along unit `direction` hit any triangle at a
// distance between tMin and tMax? Stops at the first hit found.
// `stack` is scratch space, reused between calls to avoid allocation.
export function rayHitsAny(
  bvh: Bvh,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMin: number,
  tMax: number,
  stack: Int32Array,
): boolean {
  const invX = 1 / dx;
  const invY = 1 / dy;
  const invZ = 1 / dz;
  let top = 0;
  stack[top] = 0;
  top = top + 1;
  while (top > 0) {
    top = top - 1;
    const node = stack[top];
    const entry = rayBox(bvh.boxes, node, ox, oy, oz, invX, invY, invZ, tMax);
    if (entry === Infinity) {
      continue;
    }
    if (bvh.left[node] < 0) {
      const from = bvh.start[node];
      const to = from + bvh.count[node];
      for (let k = from; k < to; k++) {
        const t = bvh.order[k];
        const distance = rayTriangle(bvh.positions, bvh.triangles, t, ox, oy, oz, dx, dy, dz);
        if (distance > tMin && distance < tMax) {
          return true;
        }
      }
    } else {
      stack[top] = bvh.left[node];
      top = top + 1;
      stack[top] = bvh.right[node];
      top = top + 1;
    }
  }
  return false;
}

export function makeTraversalStack(bvh: Bvh): Int32Array {
  // Depth is at most about log2(n) * 2 for a median split; 128 is ample, but
  // size it from the node count to be safe.
  const size = Math.max(64, Math.ceil(Math.log2(bvh.nodeCount + 1)) * 4);
  return new Int32Array(size);
}

// Closest point on a triangle to p (Ericson, Real-Time Collision Detection 5.1.5).
export function closestPointOnTriangle(
  positions: Float64Array,
  triangles: Uint32Array,
  t: number,
  px: number,
  py: number,
  pz: number,
  out: Float64Array,
): void {
  const ia = triangles[3 * t];
  const ib = triangles[3 * t + 1];
  const ic = triangles[3 * t + 2];
  const ax = positions[3 * ia];
  const ay = positions[3 * ia + 1];
  const az = positions[3 * ia + 2];
  const bx = positions[3 * ib];
  const by = positions[3 * ib + 1];
  const bz = positions[3 * ib + 2];
  const cx = positions[3 * ic];
  const cy = positions[3 * ic + 1];
  const cz = positions[3 * ic + 2];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax;
    out[1] = ay;
    out[2] = az;
    return;
  }
  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx;
    out[1] = by;
    out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + v * abx;
    out[1] = ay + v * aby;
    out[2] = az + v * abz;
    return;
  }
  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx;
    out[1] = cy;
    out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + w * acx;
    out[1] = ay + w * acy;
    out[2] = az + w * acz;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + w * (cx - bx);
    out[1] = by + w * (cy - by);
    out[2] = bz + w * (cz - bz);
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

function boxDistanceSquared(boxes: Float64Array, node: number, px: number, py: number, pz: number): number {
  const base = 6 * node;
  let dx = 0;
  if (px < boxes[base]) {
    dx = boxes[base] - px;
  } else if (px > boxes[base + 3]) {
    dx = px - boxes[base + 3];
  }
  let dy = 0;
  if (py < boxes[base + 1]) {
    dy = boxes[base + 1] - py;
  } else if (py > boxes[base + 4]) {
    dy = py - boxes[base + 4];
  }
  let dz = 0;
  if (pz < boxes[base + 2]) {
    dz = boxes[base + 2] - pz;
  } else if (pz > boxes[base + 5]) {
    dz = pz - boxes[base + 5];
  }
  return dx * dx + dy * dy + dz * dz;
}

export interface ClosestHit {
  triangle: number;
  distance: number;
  point: [number, number, number];
}

// The closest triangle to p within maxDistance, or null.
// If `triangleGroup` is given, triangles whose group equals `skipGroup` are
// ignored (used to find the nearest triangle of a *different* part).
export function closestTriangle(
  bvh: Bvh,
  px: number,
  py: number,
  pz: number,
  maxDistance: number,
  triangleGroup: Int32Array | null,
  skipGroup: number,
): ClosestHit | null {
  let bestSquared = maxDistance * maxDistance;
  let bestTriangle = -1;
  const scratch = new Float64Array(3);
  const best = new Float64Array(3);
  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop() as number;
    if (boxDistanceSquared(bvh.boxes, node, px, py, pz) > bestSquared) {
      continue;
    }
    if (bvh.left[node] < 0) {
      const from = bvh.start[node];
      const to = from + bvh.count[node];
      for (let k = from; k < to; k++) {
        const t = bvh.order[k];
        if (triangleGroup !== null && triangleGroup[t] === skipGroup) {
          continue;
        }
        closestPointOnTriangle(bvh.positions, bvh.triangles, t, px, py, pz, scratch);
        const dx = scratch[0] - px;
        const dy = scratch[1] - py;
        const dz = scratch[2] - pz;
        const squared = dx * dx + dy * dy + dz * dz;
        if (squared <= bestSquared) {
          bestSquared = squared;
          bestTriangle = t;
          best[0] = scratch[0];
          best[1] = scratch[1];
          best[2] = scratch[2];
        }
      }
    } else {
      // Visit the nearer child last so it is popped first.
      const a = bvh.left[node];
      const b = bvh.right[node];
      const da = boxDistanceSquared(bvh.boxes, a, px, py, pz);
      const db = boxDistanceSquared(bvh.boxes, b, px, py, pz);
      if (da < db) {
        stack.push(b);
        stack.push(a);
      } else {
        stack.push(a);
        stack.push(b);
      }
    }
  }
  if (bestTriangle < 0) {
    return null;
  }
  return { triangle: bestTriangle, distance: Math.sqrt(bestSquared), point: [best[0], best[1], best[2]] };
}
