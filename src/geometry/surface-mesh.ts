// A part's triangles as one connected surface, for walking decals across it.
//
// The imported mesh keeps every CAD face's vertices separate (so faces shade
// crisply). A decal must cross CAD face boundaries freely, so here the
// vertices are welded by position and each triangle learns its neighbour
// across each of its three edges. Triangle numbers are the same as in
// Part.indices, so an anchor (triangle + barycentric) means the same thing
// in both.

import type { Part } from './part.ts';
import type { Vec3 } from './vec3.ts';

// Vertices closer than this are the same vertex. OpenCascade writes the
// shared edge of two faces with identical points, so this only has to absorb
// float rounding.
export const weldTolerance = 1e-4;

export interface SurfaceMesh {
  // Welded vertices, xyz, part frame.
  positions: Float64Array;
  // Three welded vertex numbers per triangle, in the part's triangle order.
  triangles: Uint32Array;
  // Per triangle and edge k (corner k to corner k+1): the triangle across
  // that edge, or -1 where there is none.
  neighbours: Int32Array;
  // Unit normal per triangle, pointing out of the solid (agreeing with the
  // CAD normals); zero for a degenerate triangle.
  normals: Float64Array;
  // The part's own (unwelded) indices and smooth CAD normals, for shading.
  partIndices: Uint32Array;
  partNormals: Float32Array;
}

function weldKey(x: number, y: number, z: number): string {
  const qx = Math.round(x / weldTolerance);
  const qy = Math.round(y / weldTolerance);
  const qz = Math.round(z / weldTolerance);
  return String(qx) + ',' + String(qy) + ',' + String(qz);
}

export function buildSurfaceMesh(part: Part): SurfaceMesh {
  const vertexCount = part.positions.length / 3;
  const triangleCount = part.indices.length / 3;

  // Weld: the first vertex at each position stands for all of them.
  // Doubt: rounding to a grid can split two points that straddle a grid
  // line; with OpenCascade's identical edge points this does not happen.
  const keyToWelded = new Map<string, number>();
  const welded = new Uint32Array(vertexCount);
  const weldedPositions: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    const x = part.positions[3 * v];
    const y = part.positions[3 * v + 1];
    const z = part.positions[3 * v + 2];
    const key = weldKey(x, y, z);
    let index = keyToWelded.get(key);
    if (index === undefined) {
      index = weldedPositions.length / 3;
      keyToWelded.set(key, index);
      weldedPositions.push(x, y, z);
    }
    welded[v] = index;
  }
  const positions = new Float64Array(weldedPositions);
  const triangles = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount * 3; i++) {
    triangles[i] = welded[part.indices[i]];
  }

  // Outward normals.
  const normals = new Float64Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const a = 3 * triangles[3 * t];
    const b = 3 * triangles[3 * t + 1];
    const c = 3 * triangles[3 * t + 2];
    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) {
      continue; // degenerate: normal stays zero
    }
    nx = nx / length;
    ny = ny / length;
    nz = nz / length;
    // The CAD normals at the corners point out of the solid; the winding
    // of the triangles is not to be trusted.
    let cadX = 0;
    let cadY = 0;
    let cadZ = 0;
    for (let corner = 0; corner < 3; corner++) {
      const original = part.indices[3 * t + corner];
      cadX = cadX + part.normals[3 * original];
      cadY = cadY + part.normals[3 * original + 1];
      cadZ = cadZ + part.normals[3 * original + 2];
    }
    if (nx * cadX + ny * cadY + nz * cadZ < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    normals[3 * t] = nx;
    normals[3 * t + 1] = ny;
    normals[3 * t + 2] = nz;
  }

  // Neighbours: triangles that share an edge (two welded vertices).
  const edgeOwners = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    if (normals[3 * t] === 0 && normals[3 * t + 1] === 0 && normals[3 * t + 2] === 0) {
      continue; // degenerate triangles take no part
    }
    for (let k = 0; k < 3; k++) {
      const p = triangles[3 * t + k];
      const q = triangles[3 * t + ((k + 1) % 3)];
      const key = p < q ? String(p) + ':' + String(q) : String(q) + ':' + String(p);
      let owners = edgeOwners.get(key);
      if (owners === undefined) {
        owners = [];
        edgeOwners.set(key, owners);
      }
      owners.push(3 * t + k);
    }
  }
  const neighbours = new Int32Array(triangleCount * 3);
  neighbours.fill(-1);
  edgeOwners.forEach(function pair(owners) {
    if (owners.length < 2) {
      return;
    }
    // Usually two triangles. Where more meet (an inner wall fused onto the
    // outer one), each triangle pairs with the one whose surface continues
    // most nearly straight on (the most similar normal).
    for (let i = 0; i < owners.length; i++) {
      const t = Math.floor(owners[i] / 3);
      let best = -1;
      let bestAlignment = -Infinity;
      for (let j = 0; j < owners.length; j++) {
        if (j === i) {
          continue;
        }
        const other = Math.floor(owners[j] / 3);
        if (other === t) {
          continue;
        }
        const alignment = normals[3 * t] * normals[3 * other] + normals[3 * t + 1] * normals[3 * other + 1] + normals[3 * t + 2] * normals[3 * other + 2];
        if (alignment > bestAlignment) {
          bestAlignment = alignment;
          best = other;
        }
      }
      neighbours[owners[i]] = best;
    }
  });

  return {
    positions: positions,
    triangles: triangles,
    neighbours: neighbours,
    normals: normals,
    partIndices: part.indices,
    partNormals: part.normals,
  };
}

export function meshVertex(mesh: SurfaceMesh, triangle: number, corner: number): Vec3 {
  const v = 3 * mesh.triangles[3 * triangle + corner];
  return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
}

export function triangleNormal(mesh: SurfaceMesh, triangle: number): Vec3 {
  return [mesh.normals[3 * triangle], mesh.normals[3 * triangle + 1], mesh.normals[3 * triangle + 2]];
}

// Barycentric weights of point p (in the triangle's plane) in triangle t.
export function barycentricOf(mesh: SurfaceMesh, triangle: number, p: Vec3): Vec3 {
  const a = meshVertex(mesh, triangle, 0);
  const b = meshVertex(mesh, triangle, 1);
  const c = meshVertex(mesh, triangle, 2);
  const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const v2 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2];
  const d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
  const d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2];
  const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2];
  const d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2];
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) < 1e-18) {
    return [1, 0, 0];
  }
  const wb = (d11 * d20 - d01 * d21) / denominator;
  const wc = (d00 * d21 - d01 * d20) / denominator;
  return [1 - wb - wc, wb, wc];
}

export function pointFromBarycentric(mesh: SurfaceMesh, triangle: number, weights: Vec3): Vec3 {
  const a = meshVertex(mesh, triangle, 0);
  const b = meshVertex(mesh, triangle, 1);
  const c = meshVertex(mesh, triangle, 2);
  return [
    a[0] * weights[0] + b[0] * weights[1] + c[0] * weights[2],
    a[1] * weights[0] + b[1] * weights[1] + c[1] * weights[2],
    a[2] * weights[0] + b[2] * weights[1] + c[2] * weights[2],
  ];
}

// The smooth (CAD) normal at point p of triangle t, made outward. Used for
// shading the decal like the part under it, and for lifting it off the surface.
export function smoothNormal(mesh: SurfaceMesh, triangle: number, p: Vec3): Vec3 {
  const weights = barycentricOf(mesh, triangle, p);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let corner = 0; corner < 3; corner++) {
    const original = mesh.partIndices[3 * triangle + corner];
    x = x + weights[corner] * mesh.partNormals[3 * original];
    y = y + weights[corner] * mesh.partNormals[3 * original + 1];
    z = z + weights[corner] * mesh.partNormals[3 * original + 2];
  }
  const length = Math.hypot(x, y, z);
  const flat = triangleNormal(mesh, triangle);
  if (length < 1e-12) {
    return flat;
  }
  x = x / length;
  y = y / length;
  z = z / length;
  if (x * flat[0] + y * flat[1] + z * flat[2] < 0) {
    return [-x, -y, -z];
  }
  return [x, y, z];
}
