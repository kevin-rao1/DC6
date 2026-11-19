// 3D convex hull of a point set (quickhull, triangles only).
//
// The hull is the "outer wrapping" place on face works with: its flat sides
// are what the user is offered, so threads, grooves and small bosses offer
// nothing (see attach-faces.ts).
//
// The algorithm: start from a tetrahedron of extreme points; give every point
// outside it to the face it is farthest above; then repeatedly take the
// farthest point above some face, remove every face that point can see, and
// close the hole with a fan of new faces from the point to the hole's rim
// (the horizon). Points within `tolerance` of a face count as on it.
//
// Unlike textbook quickhull, coplanar faces are not merged here; the result is
// a triangulated hull, and attach-faces.ts groups coplanar triangles itself.
// Doubt: without merging, rounding can leave a new face very slightly
// non-convex against its neighbour. The tolerance (a millionth of the part's
// size) keeps that far below anything that matters for joining parts.

export interface Hull {
  // The points that are hull vertices are not renumbered: triangles index the
  // input point array.
  triangles: Uint32Array;
}

interface HullFace {
  a: number;
  b: number;
  c: number;
  nx: number;
  ny: number;
  nz: number;
  offset: number; // plane: n . p = offset
  outside: number[]; // indices of points above this face
  alive: boolean;
}

function makeFace(points: ArrayLike<number>, a: number, b: number, c: number): HullFace {
  const ax = points[3 * a];
  const ay = points[3 * a + 1];
  const az = points[3 * a + 2];
  const abx = points[3 * b] - ax;
  const aby = points[3 * b + 1] - ay;
  const abz = points[3 * b + 2] - az;
  const acx = points[3 * c] - ax;
  const acy = points[3 * c + 1] - ay;
  const acz = points[3 * c + 2] - az;
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l > 0) {
    nx = nx / l;
    ny = ny / l;
    nz = nz / l;
  }
  const offset = nx * ax + ny * ay + nz * az;
  return { a: a, b: b, c: c, nx: nx, ny: ny, nz: nz, offset: offset, outside: [], alive: true };
}

function distanceAbove(points: ArrayLike<number>, face: HullFace, i: number): number {
  const d = face.nx * points[3 * i] + face.ny * points[3 * i + 1] + face.nz * points[3 * i + 2];
  return d - face.offset;
}

function squaredDistance(points: ArrayLike<number>, i: number, j: number): number {
  const dx = points[3 * i] - points[3 * j];
  const dy = points[3 * i + 1] - points[3 * j + 1];
  const dz = points[3 * i + 2] - points[3 * j + 2];
  return dx * dx + dy * dy + dz * dz;
}

// Distance of point p from the line through a and b.
function distanceFromLine(points: ArrayLike<number>, a: number, b: number, p: number): number {
  const abx = points[3 * b] - points[3 * a];
  const aby = points[3 * b + 1] - points[3 * a + 1];
  const abz = points[3 * b + 2] - points[3 * a + 2];
  const apx = points[3 * p] - points[3 * a];
  const apy = points[3 * p + 1] - points[3 * a + 1];
  const apz = points[3 * p + 2] - points[3 * a + 2];
  const cx = aby * apz - abz * apy;
  const cy = abz * apx - abx * apz;
  const cz = abx * apy - aby * apx;
  const lengthAb = Math.sqrt(abx * abx + aby * aby + abz * abz);
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / lengthAb;
}

export function convexHull(points: ArrayLike<number>): Hull {
  const count = points.length / 3;
  if (count < 4) {
    throw new Error('convexHull: need at least 4 points, got ' + String(count));
  }

  // Extreme points along each axis, and the size of the set.
  const minIndex = [0, 0, 0];
  const maxIndex = [0, 0, 0];
  for (let i = 1; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      if (points[3 * i + axis] < points[3 * minIndex[axis] + axis]) {
        minIndex[axis] = i;
      }
      if (points[3 * i + axis] > points[3 * maxIndex[axis] + axis]) {
        maxIndex[axis] = i;
      }
    }
  }
  let size = 0;
  for (let axis = 0; axis < 3; axis++) {
    size = Math.max(size, points[3 * maxIndex[axis] + axis] - points[3 * minIndex[axis] + axis]);
  }
  const tolerance = size * 1e-6;

  // Initial tetrahedron: the farthest pair of extremes, the point farthest
  // from their line, the point farthest from their plane.
  let p0 = minIndex[0];
  let p1 = maxIndex[0];
  let bestPair = -1;
  for (let axis = 0; axis < 3; axis++) {
    const d = squaredDistance(points, minIndex[axis], maxIndex[axis]);
    if (d > bestPair) {
      bestPair = d;
      p0 = minIndex[axis];
      p1 = maxIndex[axis];
    }
  }
  let p2 = -1;
  let bestLine = 0;
  for (let i = 0; i < count; i++) {
    const d = distanceFromLine(points, p0, p1, i);
    if (d > bestLine) {
      bestLine = d;
      p2 = i;
    }
  }
  if (p2 < 0 || bestLine < tolerance) {
    throw new Error('convexHull: the points all lie on one line');
  }
  const base = makeFace(points, p0, p1, p2);
  let p3 = -1;
  let bestPlane = 0;
  for (let i = 0; i < count; i++) {
    const d = Math.abs(distanceAbove(points, base, i));
    if (d > bestPlane) {
      bestPlane = d;
      p3 = i;
    }
  }
  if (p3 < 0 || bestPlane < tolerance) {
    throw new Error('convexHull: the points all lie in one plane');
  }

  const faces: HullFace[] = [];
  // Directed edge a->b -> the face that has it. Key a * count + b.
  const edgeOwner = new Map<number, number>();

  function addFace(a: number, b: number, c: number): number {
    const face = makeFace(points, a, b, c);
    const index = faces.length;
    faces.push(face);
    edgeOwner.set(a * count + b, index);
    edgeOwner.set(b * count + c, index);
    edgeOwner.set(c * count + a, index);
    return index;
  }

  function removeFace(index: number): void {
    const face = faces[index];
    face.alive = false;
    edgeOwner.delete(face.a * count + face.b);
    edgeOwner.delete(face.b * count + face.c);
    edgeOwner.delete(face.c * count + face.a);
  }

  // Wind the tetrahedron so its faces point outward (p3 is below the base when
  // the base is wound p0, p1, p2 and p3 is under it).
  const newFaces: number[] = [];
  if (distanceAbove(points, base, p3) < 0) {
    newFaces.push(addFace(p0, p1, p2));
    newFaces.push(addFace(p0, p3, p1));
    newFaces.push(addFace(p1, p3, p2));
    newFaces.push(addFace(p2, p3, p0));
  } else {
    newFaces.push(addFace(p0, p2, p1));
    newFaces.push(addFace(p0, p1, p3));
    newFaces.push(addFace(p1, p2, p3));
    newFaces.push(addFace(p2, p0, p3));
  }

  // Give each point to the face it is farthest above.
  function assign(candidates: number[], targetFaces: number[]): void {
    for (let k = 0; k < candidates.length; k++) {
      const i = candidates[k];
      let bestFace = -1;
      let bestDistance = tolerance;
      for (let f = 0; f < targetFaces.length; f++) {
        const d = distanceAbove(points, faces[targetFaces[f]], i);
        if (d > bestDistance) {
          bestDistance = d;
          bestFace = targetFaces[f];
        }
      }
      if (bestFace >= 0) {
        faces[bestFace].outside.push(i);
      }
    }
  }
  const allPoints: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i !== p0 && i !== p1 && i !== p2 && i !== p3) {
      allPoints.push(i);
    }
  }
  assign(allPoints, newFaces);

  // Faces that may still have outside points, as a work stack.
  const pending: number[] = newFaces.slice();
  while (pending.length > 0) {
    const faceIndex = pending.pop() as number;
    const face = faces[faceIndex];
    if (!face.alive || face.outside.length === 0) {
      continue;
    }
    // The eye point: farthest above this face.
    let eye = face.outside[0];
    let eyeDistance = distanceAbove(points, face, eye);
    for (let k = 1; k < face.outside.length; k++) {
      const d = distanceAbove(points, face, face.outside[k]);
      if (d > eyeDistance) {
        eyeDistance = d;
        eye = face.outside[k];
      }
    }

    // Faces the eye can see, found by walking across edges from this face.
    const visible: number[] = [faceIndex];
    const isVisible = new Set<number>([faceIndex]);
    const horizon: Array<[number, number]> = [];
    let cursor = 0;
    while (cursor < visible.length) {
      const current = faces[visible[cursor]];
      cursor = cursor + 1;
      const edges: Array<[number, number]> = [
        [current.a, current.b],
        [current.b, current.c],
        [current.c, current.a],
      ];
      for (let e = 0; e < 3; e++) {
        const from = edges[e][0];
        const to = edges[e][1];
        const neighbour = edgeOwner.get(to * count + from);
        if (neighbour === undefined) {
          throw new Error('convexHull: hull is not closed (internal error)');
        }
        if (isVisible.has(neighbour)) {
          continue;
        }
        if (distanceAbove(points, faces[neighbour], eye) > tolerance) {
          isVisible.add(neighbour);
          visible.push(neighbour);
        }
      }
    }
    // The horizon: edges of visible faces whose neighbour is not visible.
    for (let v = 0; v < visible.length; v++) {
      const current = faces[visible[v]];
      const edges: Array<[number, number]> = [
        [current.a, current.b],
        [current.b, current.c],
        [current.c, current.a],
      ];
      for (let e = 0; e < 3; e++) {
        const neighbour = edgeOwner.get(edges[e][1] * count + edges[e][0]);
        if (neighbour !== undefined && !isVisible.has(neighbour)) {
          horizon.push(edges[e]);
        }
      }
    }

    // Collect the points that belonged to the visible faces, then replace
    // those faces by a fan from the eye to the horizon.
    const orphans: number[] = [];
    for (let v = 0; v < visible.length; v++) {
      const outside = faces[visible[v]].outside;
      for (let k = 0; k < outside.length; k++) {
        if (outside[k] !== eye) {
          orphans.push(outside[k]);
        }
      }
      faces[visible[v]].outside = [];
      removeFace(visible[v]);
    }
    const fan: number[] = [];
    for (let h = 0; h < horizon.length; h++) {
      // The visible face had edge from->to; the new face keeps that direction
      // so the winding (and outward normal) stays consistent.
      const created = addFace(horizon[h][0], horizon[h][1], eye);
      fan.push(created);
    }
    assign(orphans, fan);
    for (let f = 0; f < fan.length; f++) {
      pending.push(fan[f]);
    }
  }

  const result: number[] = [];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    if (face.alive) {
      result.push(face.a, face.b, face.c);
    }
  }
  // Every directed edge must have its twin: the hull is a closed surface.
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    if (!face.alive) {
      continue;
    }
    const twinAb = edgeOwner.has(face.b * count + face.a);
    const twinBc = edgeOwner.has(face.c * count + face.b);
    const twinCa = edgeOwner.has(face.a * count + face.c);
    if (!twinAb || !twinBc || !twinCa) {
      throw new Error('convexHull: result is not a closed surface');
    }
  }
  return { triangles: new Uint32Array(result) };
}
