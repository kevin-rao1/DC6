// The flat islands of the page: every visible planar CAD face that can
// carry vinyl and faces outward, drawn exactly as it is, 1:1, seen from
// outside looking at it.
//
// A face is taken when:
//   - its CAD surface type is "plane";
//   - none of its triangles is on the body strip (a flat on the body is
//     already there);
//   - its area is at least minimumArea and its narrowest width (twice the
//     largest distance from a point of it to its edge) at least minimumWidth;
//   - it faces outward, from at least half the points tried: the point just
//     in front of the face is not inside the body (within the body profile
//     at its station), and a ray from it along the normal escapes the
//     rocket. (Rays from the inner struts of a can hit the can's wall; the
//     bottom of the can's internals, seen up the open tail of a hollow tube,
//     has the tube's inside in front of it; rays from a fin's side get away,
//     except near the root of a fin with close neighbours.)
//
// Orientation, as the brief asks: seen from outside, the nose direction is
// to the left. Then there is no choice left for a rigid, unmirrored
// placement: page up is the face normal crossed with the aft direction. A
// face square to the axis (an end face) has no nose direction in it; there
// page up is world up as seen on the face.

import type { Vec3 } from './vec3.ts';
import { cross, dot, length, normalize, scale, sub } from './vec3.ts';
import type { CadFace } from './part.ts';
import { applyToDirection, applyToPoint } from './transform.ts';
import type { Surface } from './geodesic.ts';
import { raycastSurface } from './geodesic.ts';
import { meshVertex } from './surface-mesh.ts';
import { AFT_DIRECTION, NOSE_DIRECTION, WORLD_UP } from './rocket-axis.ts';
import type { Strip } from './page-strip.ts';
import { profileRadiusAt, radiusOf, radiusTolerance, rollOf, stationOf, triangleKey } from './page-strip.ts';

export const minimumArea = 25;
export const minimumWidth = 3;
// A face this close to square to the axis is an end face (|normal . axis|).
const endFaceAlignment = 0.9;
// A face whose normal has less radial part than this is two-sided (a fin):
// its label says which side.
const sideFaceRadial = 0.5;
// Most points tried for the outward test.
const outwardSamples = 48;

// What the page needs to know about each surface piece's part.
export interface PieceInfo {
  name: string;
  faces: CadFace[];
  triangleFace: Uint32Array;
  // 1-based number in its symmetry set, or null if it is not in one.
  symmetryNumber: number | null;
}

export type IslandKind = 'side' | 'end';

export interface Island {
  piece: number;
  face: number;
  kind: IslandKind;
  label: string;
  // The face's frame in the world: a point on it, its outward normal, and
  // the world directions of page right and page up on it.
  origin: Vec3;
  normal: Vec3;
  right: Vec3;
  up: Vec3;
  // Station and roll angle of `origin`.
  station: number;
  roll: number;
  // The face's mesh triangles, and their corners in the island's own 2D
  // frame (x along `right`, y along `up`, origin at `origin`), in the
  // mesh's corner order: 6 numbers per triangle.
  triangles: number[];
  corners: Float64Array;
  // Edges of the face (2D, island frame): 4 numbers each.
  boundary: number[];
  // Bounds in the island frame.
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  // Where the island frame's origin is on the page (set by the layout).
  offsetX: number;
  offsetY: number;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Page right and up on a face with this outward normal (see the header).
export function islandAxes(normal: Vec3): { right: Vec3; up: Vec3; kind: IslandKind } {
  const alongAxis = dot(normal, AFT_DIRECTION);
  if (Math.abs(alongAxis) > endFaceAlignment) {
    const upInPlane = sub(WORLD_UP, scale(normal, dot(WORLD_UP, normal)));
    const up = normalize(upInPlane);
    return { right: cross(up, normal), up: up, kind: 'end' };
  }
  const aftInPlane = sub(AFT_DIRECTION, scale(normal, alongAxis));
  const right = normalize(aftInPlane);
  return { right: right, up: cross(normal, right), kind: 'side' };
}

// Which side of a two-sided part a face is, named as seen from behind the
// rocket (from the tail, looking towards the nose) with the part pointing up.
function sideName(normal: Vec3, origin: Vec3): string {
  const radial: Vec3 = [0, origin[1], origin[2]];
  if (length(radial) < 1e-9) {
    return '';
  }
  const outward = normalize(radial);
  if (Math.abs(dot(normal, outward)) >= sideFaceRadial) {
    return '';
  }
  const viewerRight = cross(NOSE_DIRECTION, outward);
  if (dot(normal, viewerRight) > 0) {
    return 'right';
  }
  return 'left';
}

export function findIslands(surface: Surface, info: PieceInfo[], strip: Strip): Island[] {
  const islands: Island[] = [];
  for (let p = 0; p < surface.pieces.length; p++) {
    const piece = surface.pieces[p];
    const mesh = piece.mesh;
    const part = info[p];
    // Triangles of each plane face.
    const byFace = new Map<number, number[]>();
    for (let t = 0; t < part.triangleFace.length; t++) {
      const face = part.triangleFace[t];
      if (part.faces[face].surface !== 'plane') {
        continue;
      }
      const n = mesh.normals;
      if (n[3 * t] === 0 && n[3 * t + 1] === 0 && n[3 * t + 2] === 0) {
        continue;
      }
      let list = byFace.get(face);
      if (list === undefined) {
        list = [];
        byFace.set(face, list);
      }
      list.push(t);
    }
    const faceNumbers = Array.from(byFace.keys());
    faceNumbers.sort(function ascending(a, b) {
      return a - b;
    });
    for (let f = 0; f < faceNumbers.length; f++) {
      const face = faceNumbers[f];
      const triangles = byFace.get(face) as number[];
      const island = makeIsland(surface, p, face, triangles, part, strip);
      if (island !== null) {
        islands.push(island);
      }
    }
  }
  return islands;
}

function makeIsland(surface: Surface, p: number, face: number, triangles: number[], part: PieceInfo, strip: Strip): Island | null {
  const piece = surface.pieces[p];
  const mesh = piece.mesh;
  const cad = part.faces[face];
  if (cad.area < minimumArea) {
    return null;
  }
  for (let i = 0; i < triangles.length; i++) {
    if (strip.index.has(triangleKey(p, triangles[i]))) {
      return null;
    }
  }
  // Outward normal: the triangles' (they agree on a plane), area weighted;
  // the origin is the face's area centroid.
  let normalSum: Vec3 = [0, 0, 0];
  let centroidSum: Vec3 = [0, 0, 0];
  let areaSum = 0;
  const world: Vec3[] = [];
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    const a = applyToPoint(piece.transform, meshVertex(mesh, t, 0));
    const b = applyToPoint(piece.transform, meshVertex(mesh, t, 1));
    const c = applyToPoint(piece.transform, meshVertex(mesh, t, 2));
    world.push(a, b, c);
    const area = length(cross(sub(b, a), sub(c, a))) / 2;
    const n = applyToDirection(piece.transform, [mesh.normals[3 * t], mesh.normals[3 * t + 1], mesh.normals[3 * t + 2]]);
    normalSum = [normalSum[0] + n[0] * area, normalSum[1] + n[1] * area, normalSum[2] + n[2] * area];
    const middle: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    centroidSum = [centroidSum[0] + middle[0] * area, centroidSum[1] + middle[1] * area, centroidSum[2] + middle[2] * area];
    areaSum = areaSum + area;
  }
  if (areaSum <= 0 || length(normalSum) === 0) {
    return null;
  }
  const normal = normalize(normalSum);
  const origin = scale(centroidSum, 1 / areaSum);
  const axes = islandAxes(normal);

  // 2D corners in the island frame.
  const corners = new Float64Array(triangles.length * 6);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < triangles.length; i++) {
    for (let k = 0; k < 3; k++) {
      const relative = sub(world[3 * i + k], origin);
      const x = dot(relative, axes.right);
      const y = dot(relative, axes.up);
      corners[6 * i + 2 * k] = x;
      corners[6 * i + 2 * k + 1] = y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  // The face's edges: triangle edges (welded vertices) used once.
  const edgeUse = new Map<string, { count: number; segment: number[] }>();
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    for (let k = 0; k < 3; k++) {
      const u = mesh.triangles[3 * t + k];
      const v = mesh.triangles[3 * t + ((k + 1) % 3)];
      const key = u < v ? String(u) + ':' + String(v) : String(v) + ':' + String(u);
      const entry = edgeUse.get(key);
      if (entry === undefined) {
        const kk = (k + 1) % 3;
        edgeUse.set(key, { count: 1, segment: [corners[6 * i + 2 * k], corners[6 * i + 2 * k + 1], corners[6 * i + 2 * kk], corners[6 * i + 2 * kk + 1]] });
      } else {
        entry.count = entry.count + 1;
      }
    }
  }
  const boundary: number[] = [];
  edgeUse.forEach(function keepOnce(entry) {
    if (entry.count === 1) {
      for (let q = 0; q < 4; q++) {
        boundary.push(entry.segment[q]);
      }
    }
  });

  // Narrowest width: twice the largest distance from a triangle centre to
  // the edge. (Doubt: on a face of a few big triangles the centres are not
  // the most inner points, so this errs small; a fin side still measures
  // far over the threshold.)
  let deepest = 0;
  for (let i = 0; i < triangles.length; i++) {
    const cx = (corners[6 * i] + corners[6 * i + 2] + corners[6 * i + 4]) / 3;
    const cy = (corners[6 * i + 1] + corners[6 * i + 3] + corners[6 * i + 5]) / 3;
    let nearest = Infinity;
    for (let e = 0; e < boundary.length; e = e + 4) {
      nearest = Math.min(nearest, distanceToSegment(cx, cy, boundary[e], boundary[e + 1], boundary[e + 2], boundary[e + 3]));
    }
    deepest = Math.max(deepest, nearest);
  }
  if (2 * deepest < minimumWidth) {
    return null;
  }

  // Outward: rays along the normal from points of the face.
  const stride = Math.max(1, Math.ceil((triangles.length * 4) / outwardSamples));
  let tried = 0;
  let escaped = 0;
  let sample = 0;
  for (let i = 0; i < triangles.length; i++) {
    const a = world[3 * i];
    const b = world[3 * i + 1];
    const c = world[3 * i + 2];
    const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const points: Vec3[] = [centre];
    const triangleCorners = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const toward = triangleCorners[k];
      points.push([(centre[0] + toward[0]) / 2, (centre[1] + toward[1]) / 2, (centre[2] + toward[2]) / 2]);
    }
    for (let q = 0; q < points.length; q++) {
      sample = sample + 1;
      if (sample % stride !== 0) {
        continue;
      }
      const start: Vec3 = [points[q][0] + normal[0] * 0.01, points[q][1] + normal[1] * 0.01, points[q][2] + normal[2] * 0.01];
      tried = tried + 1;
      const inFront: Vec3 = [points[q][0] + normal[0], points[q][1] + normal[1], points[q][2] + normal[2]];
      const bodyRadius = profileRadiusAt(strip.profile, stationOf(inFront));
      if (Number.isFinite(bodyRadius) && radiusOf(inFront) < bodyRadius - radiusTolerance) {
        continue; // inside the body
      }
      if (raycastSurface(surface, start, normal) === null) {
        escaped = escaped + 1;
      }
    }
  }
  if (tried === 0 || escaped * 2 < tried) {
    return null;
  }

  let label = part.name;
  if (part.symmetryNumber !== null) {
    label = label + ' ' + String(part.symmetryNumber);
  }
  const side = sideName(normal, origin);
  if (axes.kind === 'side' && side !== '') {
    label = label + ' · ' + side;
  }
  return {
    piece: p,
    face: face,
    kind: axes.kind,
    label: label,
    origin: origin,
    normal: normal,
    right: axes.right,
    up: axes.up,
    station: stationOf(origin),
    roll: rollOf(origin),
    triangles: triangles,
    corners: corners,
    boundary: boundary,
    minX: minX,
    minY: minY,
    maxX: maxX,
    maxY: maxY,
    offsetX: 0,
    offsetY: 0,
  };
}
