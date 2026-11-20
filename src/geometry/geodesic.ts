// Walking straight across the surface of the placed parts: the geodesic
// tracer the decal map is built from.
//
// A walk starts at a point in a triangle with a direction in that
// triangle's plane and goes straight. At an edge it unfolds into the
// neighbouring triangle (the two triangles are laid flat into one plane, so
// the path stays straight in the surface), which is what a strip of vinyl
// does when it is laid along a surface.
//
// Where the walk meets an edge it must not follow: the part's surface turns
// sharply there (more than creaseAngle: a tube's end face, a fin's square
// root edge, the rim of a nose), or the mesh is open. There the walk looks
// for another visible part whose surface is within partGap and continues on
// whichever of those surfaces turns least, carrying the direction over by
// projecting it into the new triangle. If there is none, the walk ends: the
// decal has an edge there.
//
// Why sharp edges and not only open edges: every part from a STEP file is a
// closed solid, so its mesh has no open edges at all. A nose sitting on a
// tube ends, as far as its mesh knows, in a sharp turn onto its own rim. The
// sharp turn is where the next part takes over.

import type { Bvh } from './part.ts';
import type { RigidTransform } from './transform.ts';
import { applyToDirection, applyToPoint, invert } from './transform.ts';
import type { Vec3 } from './vec3.ts';
import { add, cross, dot, length, normalize, scale, sub } from './vec3.ts';
import type { SurfaceMesh } from './surface-mesh.ts';
import { meshVertex, triangleNormal } from './surface-mesh.ts';
import { raycast, trianglesNear } from './bvh.ts';

// A surface turning by more than this at an edge is a sharp edge. Fin edges
// rounded with a small radius are tessellated in steps of a few degrees and
// are followed round; square edges (90 degrees) are not.
export const creaseAngle = (50 * Math.PI) / 180;

// How far apart two parts' surfaces may be for a decal to continue from one
// onto the other.
export const partGap = 1.0;

// A walk gives up after this many triangle steps (a guard against loops on
// a broken mesh; a 500 mm walk over 1 mm triangles is 500 steps).
const maxStepsPerWalk = 20000;

export interface SurfacePiece {
  placedId: string;
  mesh: SurfaceMesh;
  bvh: Bvh;
  // The part's own vertex array and indices, which the BVH refers to.
  partPositions: Float32Array;
  partIndices: Uint32Array;
  transform: RigidTransform;
  inverse: RigidTransform;
}

export interface Surface {
  pieces: SurfacePiece[];
}

export function makePiece(placedId: string, mesh: SurfaceMesh, bvh: Bvh, partPositions: Float32Array, partIndices: Uint32Array, transform: RigidTransform): SurfacePiece {
  return {
    placedId: placedId,
    mesh: mesh,
    bvh: bvh,
    partPositions: partPositions,
    partIndices: partIndices,
    transform: transform,
    inverse: invert(transform),
  };
}

export function pieceIndex(surface: Surface, placedId: string): number {
  for (let i = 0; i < surface.pieces.length; i++) {
    if (surface.pieces[i].placedId === placedId) {
      return i;
    }
  }
  return -1;
}

// A point on the surface: which piece, which triangle, where (part frame).
export interface SurfacePoint {
  piece: number;
  triangle: number;
  point: Vec3;
}

export interface Walker extends SurfacePoint {
  // Unit direction of travel, in the triangle's plane, part frame.
  direction: Vec3;
  // The edge (0..2) the walk came in through, or -1.
  entryEdge: number;
  alive: boolean;
  // The piece the walk last hopped from, and how far it has gone since:
  // it may not hop straight back (that would bounce between two parts).
  hopFrom: number;
  sinceHop: number;
}

export function cloneWalker(w: Walker): Walker {
  return {
    piece: w.piece,
    triangle: w.triangle,
    point: [w.point[0], w.point[1], w.point[2]],
    direction: [w.direction[0], w.direction[1], w.direction[2]],
    entryEdge: w.entryEdge,
    alive: w.alive,
    hopFrom: w.hopFrom,
    sinceHop: w.sinceHop,
  };
}

// Remove the normal component of v (part frame) and make it unit length.
function intoPlane(v: Vec3, normal: Vec3): Vec3 | null {
  const inPlane = sub(v, scale(normal, dot(v, normal)));
  const l = length(inPlane);
  if (l < 1e-9) {
    return null;
  }
  return scale(inPlane, 1 / l);
}

// Start a walk at a surface point heading in a world direction (projected
// into the triangle's plane). Null if the direction is along the normal.
export function startWalk(surface: Surface, at: SurfacePoint, worldDirection: Vec3): Walker | null {
  const piece = surface.pieces[at.piece];
  const local = applyToDirection(piece.inverse, worldDirection);
  const normal = triangleNormal(piece.mesh, at.triangle);
  const direction = intoPlane(local, normal);
  if (direction === null) {
    return null;
  }
  return {
    piece: at.piece,
    triangle: at.triangle,
    point: [at.point[0], at.point[1], at.point[2]],
    direction: direction,
    entryEdge: -1,
    alive: true,
    hopFrom: -1,
    sinceHop: Infinity,
  };
}

export function worldPoint(surface: Surface, at: SurfacePoint): Vec3 {
  return applyToPoint(surface.pieces[at.piece].transform, at.point);
}

export function worldNormal(surface: Surface, at: SurfacePoint): Vec3 {
  const piece = surface.pieces[at.piece];
  return applyToDirection(piece.transform, triangleNormal(piece.mesh, at.triangle));
}

export function worldDirection(surface: Surface, w: Walker): Vec3 {
  return applyToDirection(surface.pieces[w.piece].transform, w.direction);
}

interface Exit {
  edge: number;
  distance: number;
  point: Vec3;
}

// Where the straight path from p along d leaves triangle t. The edge it came
// in through is skipped. Done in the triangle's own 2D frame.
function findExit(mesh: SurfaceMesh, triangle: number, p: Vec3, d: Vec3, entryEdge: number, allowEntry: boolean): Exit | null {
  const corners: Vec3[] = [meshVertex(mesh, triangle, 0), meshVertex(mesh, triangle, 1), meshVertex(mesh, triangle, 2)];
  const origin = corners[0];
  const xAxis = normalize(sub(corners[1], origin));
  const normal = triangleNormal(mesh, triangle);
  const yAxis = cross(normal, xAxis);
  const flat: Array<[number, number]> = [];
  for (let k = 0; k < 3; k++) {
    const relative = sub(corners[k], origin);
    flat.push([dot(relative, xAxis), dot(relative, yAxis)]);
  }
  const pr = sub(p, origin);
  const px = dot(pr, xAxis);
  const py = dot(pr, yAxis);
  const dx = dot(d, xAxis);
  const dy = dot(d, yAxis);
  let best: Exit | null = null;
  for (let k = 0; k < 3; k++) {
    if (k === entryEdge && !allowEntry) {
      continue;
    }
    const a = flat[k];
    const b = flat[(k + 1) % 3];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    // Only an edge the direction leaves through counts: the direction must
    // point away from the third corner's side of it. (A point lying on an
    // edge and heading inwards would otherwise "leave" there at once.)
    const c = flat[(k + 2) % 3];
    let inwardX = -ey;
    let inwardY = ex;
    if (inwardX * (c[0] - a[0]) + inwardY * (c[1] - a[1]) < 0) {
      inwardX = -inwardX;
      inwardY = -inwardY;
    }
    // A direction running along the edge (within rounding) does not leave
    // through it; it reaches the edge's end corner instead.
    const inwardLength = Math.hypot(inwardX, inwardY);
    if ((dx * inwardX + dy * inwardY) / inwardLength > -1e-9) {
      continue;
    }
    // Solve p + t d = a + s e.
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-14) {
      continue; // parallel to this edge
    }
    const wx = a[0] - px;
    const wy = a[1] - py;
    const t = (wx * ey - wy * ex) / denominator;
    const s = (wx * dy - wy * dx) / denominator;
    if (s < -1e-7 || s > 1 + 1e-7) {
      continue;
    }
    const minimumT = allowEntry ? 1e-9 : -1e-7;
    if (t < minimumT) {
      continue;
    }
    if (best === null || t < best.distance) {
      const along = Math.min(1, Math.max(0, s));
      // The exit point is put exactly on the edge, so the walk does not
      // drift off the surface over many steps.
      const point = add(corners[k], scale(sub(corners[(k + 1) % 3], corners[k]), along));
      best = { edge: k, distance: Math.max(0, t), point: point };
    }
  }
  return best;
}

// Angle between two unit normals.
function angleBetween(a: Vec3, b: Vec3): number {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  return Math.acos(c);
}

// The edge number of triangle `other` that joins welded vertices p and q.
function matchingEdge(mesh: SurfaceMesh, other: number, p: number, q: number): number {
  for (let k = 0; k < 3; k++) {
    const a = mesh.triangles[3 * other + k];
    const b = mesh.triangles[3 * other + ((k + 1) % 3)];
    if ((a === p && b === q) || (a === q && b === p)) {
      return k;
    }
  }
  return -1;
}

// Unfold the walk across edge `edge` of its triangle into triangle `next`:
// the direction keeps its component along the edge and its component across
// it, the latter now measured in the next triangle's plane.
function unfold(mesh: SurfaceMesh, w: Walker, edge: number, next: number): boolean {
  const t = w.triangle;
  const p = mesh.triangles[3 * t + edge];
  const q = mesh.triangles[3 * t + ((edge + 1) % 3)];
  const nextEdge = matchingEdge(mesh, next, p, q);
  if (nextEdge < 0) {
    return false;
  }
  const a = meshVertex(mesh, t, edge);
  const b = meshVertex(mesh, t, (edge + 1) % 3);
  const along = normalize(sub(b, a));
  const third = meshVertex(mesh, t, (edge + 2) % 3);
  const nextThird = meshVertex(mesh, next, (nextEdge + 2) % 3);
  // Across the edge, pointing out of the current triangle...
  const towardThird = sub(third, a);
  const outOfCurrent = normalize(scale(sub(towardThird, scale(along, dot(towardThird, along))), -1));
  // ...and into the next one.
  const towardNextThird = sub(nextThird, a);
  const intoNext = normalize(sub(towardNextThird, scale(along, dot(towardNextThird, along))));
  const alongPart = dot(w.direction, along);
  const acrossPart = dot(w.direction, outOfCurrent);
  const direction = add(scale(along, alongPart), scale(intoNext, acrossPart));
  const l = length(direction);
  if (l < 1e-12) {
    return false;
  }
  w.direction = scale(direction, 1 / l);
  w.triangle = next;
  w.entryEdge = nextEdge;
  return true;
}

// Closest point to p on triangle abc (Ericson, Real-Time Collision
// Detection, 5.1.5).
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) {
    return a;
  }
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) {
    return b;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) {
    return c;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, scale(ac, w));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return add(a, add(scale(ab, v), scale(ac, w)));
}

// Continue the walk on another part: the surface within partGap of where it
// stands that turns least from the current triangle (and less than
// creaseAngle). Returns false if there is none.
function hop(surface: Surface, w: Walker): boolean {
  const piece = surface.pieces[w.piece];
  const here = applyToPoint(piece.transform, w.point);
  const normalHere = applyToDirection(piece.transform, triangleNormal(piece.mesh, w.triangle));
  const directionHere = applyToDirection(piece.transform, w.direction);
  let bestPiece = -1;
  let bestTriangle = -1;
  let bestPoint: Vec3 = [0, 0, 0];
  let bestScore = Infinity;
  for (let i = 0; i < surface.pieces.length; i++) {
    if (i === w.piece) {
      continue;
    }
    if (i === w.hopFrom && w.sinceHop < 2 * partGap) {
      continue;
    }
    const other = surface.pieces[i];
    const local = applyToPoint(other.inverse, here);
    const candidates = trianglesNear(other.bvh, local, partGap);
    for (let k = 0; k < candidates.length; k++) {
      const t = candidates[k];
      const normal = triangleNormal(other.mesh, t);
      if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) {
        continue;
      }
      const closest = closestPointOnTriangle(local, meshVertex(other.mesh, t, 0), meshVertex(other.mesh, t, 1), meshVertex(other.mesh, t, 2));
      const gap = length(sub(closest, local));
      if (gap > partGap) {
        continue;
      }
      const turn = angleBetween(normalHere, applyToDirection(other.transform, normal));
      if (turn >= creaseAngle) {
        continue;
      }
      // Least turn first; among equal turns (one flat face in several
      // triangles) the nearest.
      const score = turn + gap * 1e-3;
      if (score < bestScore) {
        bestScore = score;
        bestPiece = i;
        bestTriangle = t;
        bestPoint = closest;
      }
    }
  }
  if (bestPiece < 0) {
    return false;
  }
  const target = surface.pieces[bestPiece];
  const localDirection = applyToDirection(target.inverse, directionHere);
  const direction = intoPlane(localDirection, triangleNormal(target.mesh, bestTriangle));
  if (direction === null) {
    return false;
  }
  w.hopFrom = w.piece;
  w.sinceHop = 0;
  w.piece = bestPiece;
  w.triangle = bestTriangle;
  w.point = bestPoint;
  w.direction = direction;
  w.entryEdge = -1;
  return true;
}

// Cross edge `edge` of the walker's triangle: unfold onto the neighbour if
// the surface turns gently there, else hop to another part, else stop.
function crossEdge(surface: Surface, w: Walker, edge: number): boolean {
  const mesh = surface.pieces[w.piece].mesh;
  const next = mesh.neighbours[3 * w.triangle + edge];
  if (next >= 0) {
    const turn = angleBetween(triangleNormal(mesh, w.triangle), triangleNormal(mesh, next));
    if (turn < creaseAngle) {
      return unfold(mesh, w, edge, next);
    }
  }
  return hop(surface, w);
}

// Walk `distance` mm straight on. The walker is updated in place; if the
// surface ends on the way, alive becomes false and it stays where it stopped.
export function walk(surface: Surface, w: Walker, distance: number): void {
  if (!w.alive) {
    return;
  }
  let remaining = distance;
  let steps = 0;
  while (remaining > 1e-9) {
    steps = steps + 1;
    if (steps > maxStepsPerWalk) {
      w.alive = false;
      return;
    }
    const mesh = surface.pieces[w.piece].mesh;
    let exit = findExit(mesh, w.triangle, w.point, w.direction, w.entryEdge, false);
    if (exit === null) {
      // Numerical corner case (the point sits on a corner and the direction
      // runs along an edge): allow leaving through the entry edge.
      exit = findExit(mesh, w.triangle, w.point, w.direction, w.entryEdge, true);
    }
    if (exit === null) {
      w.alive = false;
      return;
    }
    if (exit.distance >= remaining) {
      w.point = add(w.point, scale(w.direction, remaining));
      w.sinceHop = w.sinceHop + remaining;
      return;
    }
    w.point = exit.point;
    remaining = remaining - exit.distance;
    w.sinceHop = w.sinceHop + exit.distance;
    if (!crossEdge(surface, w, exit.edge)) {
      w.alive = false;
      return;
    }
  }
}

// The nearest surface point under a ray, or null.
export function raycastSurface(surface: Surface, origin: Vec3, direction: Vec3): { at: SurfacePoint; distance: number } | null {
  let best: { at: SurfacePoint; distance: number } | null = null;
  for (let i = 0; i < surface.pieces.length; i++) {
    const piece = surface.pieces[i];
    const localOrigin = applyToPoint(piece.inverse, origin);
    const localDirection = applyToDirection(piece.inverse, direction);
    const limit = best === null ? Infinity : best.distance;
    const hit = raycast(piece.bvh, piece.partPositions, piece.partIndices, localOrigin, localDirection, limit);
    if (hit === null) {
      continue;
    }
    const point = add(localOrigin, scale(localDirection, hit.distance));
    best = { at: { piece: i, triangle: hit.triangle, point: point }, distance: hit.distance };
  }
  return best;
}

// The surface point nearest to a world point on one piece (within
// `radius`), or null. Used to put a decal on a part's attach face.
export function nearestOnPiece(surface: Surface, pieceNumber: number, world: Vec3, radius: number): SurfacePoint | null {
  const piece = surface.pieces[pieceNumber];
  const local = applyToPoint(piece.inverse, world);
  const candidates = trianglesNear(piece.bvh, local, radius);
  let best: SurfacePoint | null = null;
  let bestGap = Infinity;
  for (let k = 0; k < candidates.length; k++) {
    const t = candidates[k];
    const normal = triangleNormal(piece.mesh, t);
    if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) {
      continue;
    }
    const closest = closestPointOnTriangle(local, meshVertex(piece.mesh, t, 0), meshVertex(piece.mesh, t, 1), meshVertex(piece.mesh, t, 2));
    const gap = length(sub(closest, local));
    if (gap < bestGap) {
      bestGap = gap;
      best = { piece: pieceNumber, triangle: t, point: closest };
    }
  }
  return best;
}
