// RawPart (from step-import.ts) -> Part: adds face areas and flatness, the
// convex hull, the ray-cast tree and the attach faces. No OpenCascade here,
// so this runs and is tested on plain arrays.

import type { Part } from './part.ts';
import type { RawPart } from './step-import.ts';
import type { Vec3 } from './vec3.ts';
import { cross, dot, length, pointAt, scale, sub, add } from './vec3.ts';
import { convexHull } from './hull.ts';
import { buildBvh } from './bvh.ts';
import { attachFaces, guessAttachFace } from './attach-faces.ts';

// A non-plane face counts as flat when all its vertices are within this of
// one plane.
export const flatTolerance = 0.01;

// Fill in area, flat and flatNormal of every face from its triangles.
function describeFaceTriangles(raw: RawPart): void {
  const faceCount = raw.faces.length;
  const normalSums: Vec3[] = [];
  const areas: number[] = [];
  const pointSums: Vec3[] = [];
  for (let f = 0; f < faceCount; f++) {
    normalSums.push([0, 0, 0]);
    areas.push(0);
    pointSums.push([0, 0, 0]);
  }
  const triangleCount = raw.indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const f = raw.triangleFace[t];
    const ia = raw.indices[3 * t];
    const ib = raw.indices[3 * t + 1];
    const ic = raw.indices[3 * t + 2];
    const a = pointAt(raw.positions, ia);
    const b = pointAt(raw.positions, ib);
    const c = pointAt(raw.positions, ic);
    let n = cross(sub(b, a), sub(c, a));
    // Make the triangle normal agree with the CAD normals at its corners,
    // which point out of the solid.
    const cadNormal = add(add(pointAt(raw.normals, ia), pointAt(raw.normals, ib)), pointAt(raw.normals, ic));
    if (dot(n, cadNormal) < 0) {
      n = scale(n, -1);
    }
    const area = length(n) / 2;
    normalSums[f] = add(normalSums[f], n);
    areas[f] = areas[f] + area;
    const centre = scale(add(add(a, b), c), area / 3);
    pointSums[f] = add(pointSums[f], centre);
  }

  // Which vertices each face uses (a face's vertices are its own; see Part).
  const firstVertexOfFace: number[] = [];
  const lastVertexOfFace: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    firstVertexOfFace.push(Infinity);
    lastVertexOfFace.push(-1);
  }
  for (let t = 0; t < triangleCount; t++) {
    const f = raw.triangleFace[t];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = raw.indices[3 * t + corner];
      firstVertexOfFace[f] = Math.min(firstVertexOfFace[f], vertex);
      lastVertexOfFace[f] = Math.max(lastVertexOfFace[f], vertex);
    }
  }

  for (let f = 0; f < faceCount; f++) {
    const face = raw.faces[f];
    face.area = areas[f];
    const sumLength = length(normalSums[f]);
    if (areas[f] === 0 || sumLength === 0) {
      continue;
    }
    const normal = scale(normalSums[f], 1 / sumLength);
    if (face.surface === 'plane') {
      face.flat = true;
      face.flatNormal = normal;
      continue;
    }
    // Numerical test: area-weighted normals nearly all agree, and every
    // vertex lies within flatTolerance of the plane through the centroid.
    if (sumLength < 0.999 * 2 * areas[f]) {
      continue;
    }
    const centroid = scale(pointSums[f], 1 / areas[f]);
    const offset = dot(centroid, normal);
    let flat = true;
    for (let v = firstVertexOfFace[f]; v <= lastVertexOfFace[f]; v++) {
      const p = pointAt(raw.positions, v);
      if (Math.abs(dot(p, normal) - offset) > flatTolerance) {
        flat = false;
        break;
      }
    }
    if (flat) {
      face.flat = true;
      face.flatNormal = normal;
    }
  }
}

// The distinct vertex positions (faces repeat their boundary vertices).
function distinctPoints(positions: Float32Array): Float64Array {
  const seen = new Set<string>();
  const result: number[] = [];
  const count = positions.length / 3;
  for (let i = 0; i < count; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    const key = String(x) + ',' + String(y) + ',' + String(z);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(x, y, z);
  }
  return new Float64Array(result);
}

export function buildPart(raw: RawPart, fileName: string, solidIndex: number, sourceUnit: string): Part {
  describeFaceTriangles(raw);

  const hullPoints = distinctPoints(raw.positions);
  const hull = convexHull(hullPoints);
  const bvh = buildBvh(raw.positions, raw.indices);

  const candidates = attachFaces({
    positions: raw.positions,
    indices: raw.indices,
    triangleFace: raw.triangleFace,
    faces: raw.faces,
    hullPoints: hullPoints,
    hullTriangles: hull.triangles,
  });

  const boundsMin: Vec3 = [Infinity, Infinity, Infinity];
  const boundsMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  const count = raw.positions.length / 3;
  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      boundsMin[axis] = Math.min(boundsMin[axis], raw.positions[3 * i + axis]);
      boundsMax[axis] = Math.max(boundsMax[axis], raw.positions[3 * i + axis]);
    }
  }

  return {
    id: fileName + '#' + String(solidIndex),
    name: raw.name,
    fileName: fileName,
    sourceUnit: sourceUnit,
    positions: raw.positions,
    normals: raw.normals,
    indices: raw.indices,
    triangleFace: raw.triangleFace,
    faces: raw.faces,
    edges: raw.edges,
    hullPoints: hullPoints,
    hullTriangles: hull.triangles,
    attachFaces: candidates,
    guessedAttachFace: guessAttachFace(candidates),
    bvh: bvh,
    boundsMin: boundsMin,
    boundsMax: boundsMax,
  };
}
