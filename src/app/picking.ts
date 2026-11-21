// What is under the cursor: a placed part's surface, or one of the offered
// attach faces. Also the attach faces of placed parts in world coordinates.
// Pure functions over the document and the loaded parts; no three.js.

import type { AttachFace, Part } from '../geometry/part.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import { add, cross, dot, length, normalize, scale, sub } from '../geometry/vec3.ts';
import { applyToDirection, applyToPoint, invert } from '../geometry/transform.ts';
import { raycast } from '../geometry/bvh.ts';
import type { AssemblyDocument, PlacedPart } from '../model/document.ts';
import { requirePlaced } from '../model/document.ts';

export type PartLibrary = Map<string, Part>;

export interface PartHit {
  placedId: string;
  point: Vec3;
  // Smooth surface normal, turned to face the viewer.
  normal: Vec3;
  distance: number;
}

// One attach face of one placed part.
export interface FaceRef {
  placedId: string;
  face: number;
}

export function requirePart(parts: PartLibrary, partId: string): Part {
  const part = parts.get(partId);
  if (part === undefined) {
    throw new Error('expected a loaded part with id ' + partId);
  }
  return part;
}

// Centre of the part's bounding box, in its own frame. Used as the pivot of
// the gizmos and as "the middle of the part".
export function partCentre(part: Part): Vec3 {
  return [
    (part.boundsMin[0] + part.boundsMax[0]) / 2,
    (part.boundsMin[1] + part.boundsMax[1]) / 2,
    (part.boundsMin[2] + part.boundsMax[2]) / 2,
  ];
}

// A placed part's attach face, in world coordinates.
export function worldFace(parts: PartLibrary, placed: PlacedPart, faceIndex: number): AttachFace {
  const part = requirePart(parts, placed.partId);
  const face = part.attachFaces[faceIndex];
  if (face === undefined) {
    throw new Error('expected attach face ' + String(faceIndex) + ' on ' + part.name);
  }
  const outline: Vec3[] = [];
  for (let i = 0; i < face.outline.length; i++) {
    outline.push(applyToPoint(placed.transform, face.outline[i]));
  }
  return {
    normal: applyToDirection(placed.transform, face.normal),
    centre: applyToPoint(placed.transform, face.centre),
    outline: outline,
    area: face.area,
    radius: face.radius,
    longDirection: applyToDirection(placed.transform, face.longDirection),
  };
}

// The nearest visible placed part under a ray, skipping `exclude`.
export function pickPart(doc: AssemblyDocument, parts: PartLibrary, origin: Vec3, direction: Vec3, exclude: Set<string>): PartHit | null {
  let best: PartHit | null = null;
  for (let i = 0; i < doc.placed.length; i++) {
    const placed = doc.placed[i];
    if (placed.hidden || exclude.has(placed.id)) {
      continue;
    }
    const part = requirePart(parts, placed.partId);
    // Into the part's frame; rigid, so distances are unchanged.
    const toLocal = invert(placed.transform);
    const localOrigin = applyToPoint(toLocal, origin);
    const localDirection = applyToDirection(toLocal, direction);
    let limit = Infinity;
    if (best !== null) {
      limit = best.distance;
    }
    const hit = raycast(part.bvh, part.positions, part.indices, localOrigin, localDirection, limit);
    if (hit === null) {
      continue;
    }
    // Smooth normal: the CAD normals at the triangle's corners, blended by
    // where the hit lies in the triangle. On a tessellated cylinder this is
    // exactly radial, so a fin attached there stands square to the tube.
    const localPoint = add(localOrigin, scale(localDirection, hit.distance));
    const normal = interpolatedNormal(part, hit.triangle, localPoint);
    if (length(normal) === 0) {
      continue;
    }
    let worldNormal = normalize(applyToDirection(placed.transform, normal));
    // Facing the viewer: on a thin wall the ray may hit the inside.
    if (dot(worldNormal, direction) > 0) {
      worldNormal = scale(worldNormal, -1);
    }
    const point = add(origin, scale(direction, hit.distance));
    best = { placedId: placed.id, point: point, normal: worldNormal, distance: hit.distance };
  }
  return best;
}

// The nearest of the given attach faces under a ray.
export function pickFace(doc: AssemblyDocument, parts: PartLibrary, origin: Vec3, direction: Vec3, refs: FaceRef[]): FaceRef | null {
  let best: FaceRef | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < refs.length; i++) {
    const placed = requirePlaced(doc, refs[i].placedId);
    const face = worldFace(parts, placed, refs[i].face);
    const along = dot(direction, face.normal);
    if (Math.abs(along) < 1e-6) {
      continue;
    }
    const distance = dot(sub(face.centre, origin), face.normal) / along;
    if (distance <= 0 || distance >= bestDistance) {
      continue;
    }
    const point = add(origin, scale(direction, distance));
    if (insideConvex(face.outline, face.normal, point)) {
      best = refs[i];
      bestDistance = distance;
    }
  }
  return best;
}

function vertexOf(array: Float32Array, vertex: number): Vec3 {
  return [array[3 * vertex], array[3 * vertex + 1], array[3 * vertex + 2]];
}

// The corner normals of triangle t blended with the barycentric weights of
// point p (which lies in the triangle).
function interpolatedNormal(part: Part, t: number, p: Vec3): Vec3 {
  const ia = part.indices[3 * t];
  const ib = part.indices[3 * t + 1];
  const ic = part.indices[3 * t + 2];
  const a = vertexOf(part.positions, ia);
  const b = vertexOf(part.positions, ib);
  const c = vertexOf(part.positions, ic);
  const whole = length(cross(sub(b, a), sub(c, a)));
  if (whole === 0) {
    return [0, 0, 0];
  }
  // Each weight is the area of the sub-triangle opposite its corner.
  const weightA = length(cross(sub(b, p), sub(c, p))) / whole;
  const weightB = length(cross(sub(c, p), sub(a, p))) / whole;
  const weightC = length(cross(sub(a, p), sub(b, p))) / whole;
  const fromA = scale(vertexOf(part.normals, ia), weightA);
  const fromB = scale(vertexOf(part.normals, ib), weightB);
  const fromC = scale(vertexOf(part.normals, ic), weightC);
  return add(add(fromA, fromB), fromC);
}

export function sameFace(a: FaceRef | null, b: FaceRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.placedId === b.placedId && a.face === b.face;
}

// Is a point (in the outline's plane) inside a convex outline? It must be on
// the same side of every edge.
function insideConvex(outline: Vec3[], normal: Vec3, point: Vec3): boolean {
  let sign = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const side = dot(cross(sub(b, a), sub(point, a)), normal);
    if (Math.abs(side) < 1e-12) {
      continue;
    }
    let s = -1;
    if (side > 0) {
      s = 1;
    }
    if (sign === 0) {
      sign = s;
    } else if (s !== sign) {
      return false;
    }
  }
  return true;
}
