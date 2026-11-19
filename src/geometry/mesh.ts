// Per-face tessellations -> one welded triangle mesh with a face id per triangle.
//
// Welding: vertices closer than weldTolerance are merged, across faces and
// across parts. Within a part, OpenCascade discretises each CAD edge once and
// both neighbouring faces use the same edge nodes, so boundary vertices of
// neighbouring faces coincide exactly and welding makes the faces share them.
// Across parts (an assembly), vertices only merge where the two parts happen to
// have the same nodes on a shared boundary; elsewhere contact.ts records
// where they touch.
//
// Known defect (doubt stated): at a degenerate fillet corner OpenCascade's
// triangulation can have open edges whose ends do not coincide, or a sliver
// a few micrometres long. Welding does not repair those; the fused test rocket
// keeps 44 such open edges (all under 0.3 mm) and the assembly two
// non-manifold sliver edges. Tests in test/mesh.test.ts fence them in.

import type { CadImport } from './step-import.ts';
import type { CadFace, ModelMesh } from './types.ts';

// 1 micrometre. Far below the tessellation deflection (50 micrometres) and far
// above float32 rounding at 1.5 m (about 0.1 micrometre).
export const weldTolerance = 0.001;

export interface WeldedMesh {
  mesh: ModelMesh;
  faces: CadFace[];
}

function cellKey(ix: number, iy: number, iz: number): number {
  // A hash of three integer cell coordinates. Collisions are harmless: each
  // bucket is checked point by point.
  const h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0;
  return h;
}

export function weldFaces(cad: CadImport): WeldedMesh {
  // Count the input vertices and triangles.
  let inputVertexCount = 0;
  let inputTriangleCount = 0;
  for (let f = 0; f < cad.faces.length; f++) {
    inputVertexCount = inputVertexCount + cad.faces[f].positions.length / 3;
    inputTriangleCount = inputTriangleCount + cad.faces[f].triangles.length / 3;
  }

  // Two passes.
  // Pass 1, inside each face: merge nodes at exactly the same position on the
  // face's own open boundary (the two sides of a periodic seam, the several
  // nodes OpenCascade puts at a cone apex), unless that would make the face's
  // triangulation non-manifold. Distinct nodes inside one face can coincide
  // after rounding to float32 near a degenerate fillet corner; merging those
  // would fold triangles over each other, so they are left apart.
  // Pass 2, across faces: merge nodes closer than weldTolerance, but never two
  // nodes of the same face (pass 1 already decided those).
  const cellSize = weldTolerance;
  const buckets = new Map<number, number[]>();
  const weldedPositions = new Float64Array(inputVertexCount * 3);
  let weldedCount = 0;
  // For each input vertex (numbered across all faces), its welded index.
  const remap = new Uint32Array(inputVertexCount);
  const toleranceSquared = weldTolerance * weldTolerance;

  // The faces that contributed to each welded vertex. Most vertices have one,
  // boundary vertices two or three, so short lists are enough.
  const facesOfWelded: number[][] = [];
  function weldedHasFace(welded: number, face: number): boolean {
    const list = facesOfWelded[welded];
    return list !== undefined && list.includes(face);
  }
  function addFaceToWelded(welded: number, face: number): void {
    let list = facesOfWelded[welded];
    if (list === undefined) {
      list = [];
      facesOfWelded[welded] = list;
    }
    if (!list.includes(face)) {
      list.push(face);
    }
  }

  let inputBase = 0;
  for (let f = 0; f < cad.faces.length; f++) {
    const positions = cad.faces[f].positions;
    const vertexCount = positions.length / 3;
    const representative = weldWithinFace(positions, cad.faces[f].triangles);
    for (let v = 0; v < vertexCount; v++) {
      const rep = representative[v];
      if (rep !== v) {
        // Same welded vertex as its representative (which has a lower index,
        // so it has been placed already).
        remap[inputBase + v] = remap[inputBase + rep];
        continue;
      }
      const x = positions[3 * v];
      const y = positions[3 * v + 1];
      const z = positions[3 * v + 2];
      const ix = Math.floor(x / cellSize);
      const iy = Math.floor(y / cellSize);
      const iz = Math.floor(z / cellSize);
      let found = -1;
      for (let ox = -1; ox <= 1 && found < 0; ox++) {
        for (let oy = -1; oy <= 1 && found < 0; oy++) {
          for (let oz = -1; oz <= 1 && found < 0; oz++) {
            const bucket = buckets.get(cellKey(ix + ox, iy + oy, iz + oz));
            if (bucket === undefined) {
              continue;
            }
            for (let k = 0; k < bucket.length; k++) {
              const candidate = bucket[k];
              if (weldedHasFace(candidate, f)) {
                continue;
              }
              const dx = weldedPositions[3 * candidate] - x;
              const dy = weldedPositions[3 * candidate + 1] - y;
              const dz = weldedPositions[3 * candidate + 2] - z;
              const distanceSquared = dx * dx + dy * dy + dz * dz;
              if (distanceSquared <= toleranceSquared) {
                found = candidate;
                break;
              }
            }
          }
        }
      }
      if (found < 0) {
        found = weldedCount;
        weldedPositions[3 * found] = x;
        weldedPositions[3 * found + 1] = y;
        weldedPositions[3 * found + 2] = z;
        weldedCount = weldedCount + 1;
        const key = cellKey(ix, iy, iz);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(found);
      }
      addFaceToWelded(found, f);
      remap[inputBase + v] = found;
    }
    inputBase = inputBase + vertexCount;
  }

  // Triangles, face by face, dropping triangles that welding made degenerate
  // (at a cone apex OpenCascade puts several nodes at the same point).
  const triangles = new Uint32Array(inputTriangleCount * 3);
  const cornerNormals = new Float32Array(inputTriangleCount * 9);
  const triangleFace = new Int32Array(inputTriangleCount);
  const faces: CadFace[] = [];
  let triangleCount = 0;
  let faceVertexBase = 0;
  for (let f = 0; f < cad.faces.length; f++) {
    const face = cad.faces[f];
    const triangleStart = triangleCount;
    let area = 0;
    const faceTriangleCount = face.triangles.length / 3;
    for (let t = 0; t < faceTriangleCount; t++) {
      const localA = face.triangles[3 * t];
      const localB = face.triangles[3 * t + 1];
      const localC = face.triangles[3 * t + 2];
      const a = remap[faceVertexBase + localA];
      const b = remap[faceVertexBase + localB];
      const c = remap[faceVertexBase + localC];
      if (a === b || b === c || c === a) {
        continue;
      }
      const triangleArea = triangleAreaOf(weldedPositions, a, b, c);
      if (!(triangleArea > 0)) {
        continue;
      }
      area = area + triangleArea;
      triangles[3 * triangleCount] = a;
      triangles[3 * triangleCount + 1] = b;
      triangles[3 * triangleCount + 2] = c;
      const locals = [localA, localB, localC];
      for (let corner = 0; corner < 3; corner++) {
        const local = locals[corner];
        cornerNormals[9 * triangleCount + 3 * corner] = face.normals[3 * local];
        cornerNormals[9 * triangleCount + 3 * corner + 1] = face.normals[3 * local + 1];
        cornerNormals[9 * triangleCount + 3 * corner + 2] = face.normals[3 * local + 2];
      }
      triangleFace[triangleCount] = f;
      triangleCount = triangleCount + 1;
    }
    faceVertexBase = faceVertexBase + face.positions.length / 3;
    faces.push({
      id: f,
      part: face.part,
      surface: face.surface,
      triangleStart: triangleStart,
      triangleCount: triangleCount - triangleStart,
      area: area,
      visibleFraction: 0,
      exterior: false,
      axisymmetric: false,
    });
  }

  const mesh: ModelMesh = {
    positions: weldedPositions.slice(0, weldedCount * 3),
    triangles: triangles.slice(0, triangleCount * 3),
    cornerNormals: cornerNormals.slice(0, triangleCount * 9),
    triangleFace: triangleFace.slice(0, triangleCount),
  };
  return { mesh: mesh, faces: faces };
}

// Pass 1 of the weld for one face: for each node, the lowest-numbered node it
// is merged with (itself if none). See weldFaces.
function weldWithinFace(positions: Float32Array, triangles: Uint32Array): Int32Array {
  const vertexCount = positions.length / 3;
  const representative = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    representative[v] = v;
  }
  const onBoundary = rawBoundaryVertices(triangles, vertexCount);
  const firstAtPosition = new Map<string, number>();
  let merged = 0;
  for (let v = 0; v < vertexCount; v++) {
    if (onBoundary[v] === 0) {
      continue;
    }
    const key = String(positions[3 * v]) + ',' + String(positions[3 * v + 1]) + ',' + String(positions[3 * v + 2]);
    const first = firstAtPosition.get(key);
    if (first === undefined) {
      firstAtPosition.set(key, v);
    } else {
      representative[v] = first;
      merged = merged + 1;
    }
  }
  if (merged === 0) {
    return representative;
  }
  // Undo merges that make an edge of this face used more than twice, or that
  // collapse a triangle the other way round onto another (a fold). Two rounds:
  // undoing one merge cannot create a new over-used edge, but be safe.
  for (let round = 0; round < 2; round++) {
    const badVertices = overusedEdgeVertices(triangles, representative);
    if (badVertices.size === 0) {
      return representative;
    }
    for (let v = 0; v < vertexCount; v++) {
      const rep = representative[v];
      if (badVertices.has(rep)) {
        representative[v] = v;
      }
    }
  }
  return representative;
}

// Representatives at the ends of edges used by more than two triangles,
// with vertices replaced by their representatives.
function overusedEdgeVertices(triangles: Uint32Array, representative: Int32Array): Set<number> {
  const vertexCount = representative.length;
  const uses = new Map<number, number>();
  const triangleCount = triangles.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const a = representative[triangles[3 * t]];
    const b = representative[triangles[3 * t + 1]];
    const c = representative[triangles[3 * t + 2]];
    if (a === b || b === c || c === a) {
      continue;
    }
    const corners = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const p = corners[k];
      const q = corners[(k + 1) % 3];
      let key = q * vertexCount + p;
      if (p < q) {
        key = p * vertexCount + q;
      }
      const previous = uses.get(key);
      if (previous === undefined) {
        uses.set(key, 1);
      } else {
        uses.set(key, previous + 1);
      }
    }
  }
  const bad = new Set<number>();
  for (const entry of uses) {
    if (entry[1] <= 2) {
      continue;
    }
    const key = entry[0];
    const p = Math.floor(key / vertexCount);
    const q = key - p * vertexCount;
    bad.add(p);
    bad.add(q);
  }
  return bad;
}

// Vertices on an open edge (an edge used by one triangle) of one face's own
// triangulation, before welding.
function rawBoundaryVertices(triangles: Uint32Array, vertexCount: number): Uint8Array {
  const uses = new Map<number, number>();
  const triangleCount = triangles.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[3 * t + k];
      const b = triangles[3 * t + ((k + 1) % 3)];
      let key = b * vertexCount + a;
      if (a < b) {
        key = a * vertexCount + b;
      }
      const previous = uses.get(key);
      if (previous === undefined) {
        uses.set(key, 1);
      } else {
        uses.set(key, previous + 1);
      }
    }
  }
  const flags = new Uint8Array(vertexCount);
  for (const entry of uses) {
    if (entry[1] !== 1) {
      continue;
    }
    const key = entry[0];
    const a = Math.floor(key / vertexCount);
    const b = key - a * vertexCount;
    flags[a] = 1;
    flags[b] = 1;
  }
  return flags;
}

export function triangleAreaOf(positions: Float64Array, a: number, b: number, c: number): number {
  const abx = positions[3 * b] - positions[3 * a];
  const aby = positions[3 * b + 1] - positions[3 * a + 1];
  const abz = positions[3 * b + 2] - positions[3 * a + 2];
  const acx = positions[3 * c] - positions[3 * a];
  const acy = positions[3 * c + 1] - positions[3 * a + 1];
  const acz = positions[3 * c + 2] - positions[3 * a + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

// Unit geometric normal of triangle t (from its winding), written into out.
export function triangleNormal(positions: Float64Array, triangles: Uint32Array, t: number, out: Float64Array): void {
  const a = triangles[3 * t];
  const b = triangles[3 * t + 1];
  const c = triangles[3 * t + 2];
  const abx = positions[3 * b] - positions[3 * a];
  const aby = positions[3 * b + 1] - positions[3 * a + 1];
  const abz = positions[3 * b + 2] - positions[3 * a + 2];
  const acx = positions[3 * c] - positions[3 * a];
  const acy = positions[3 * c + 1] - positions[3 * a + 1];
  const acz = positions[3 * c + 2] - positions[3 * a + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  out[0] = nx / length;
  out[1] = ny / length;
  out[2] = nz / length;
}

// Reverse the winding of every triangle of a face (and its corner normals).
export function flipFace(mesh: ModelMesh, face: CadFace): void {
  const end = face.triangleStart + face.triangleCount;
  for (let t = face.triangleStart; t < end; t++) {
    const b = mesh.triangles[3 * t + 1];
    mesh.triangles[3 * t + 1] = mesh.triangles[3 * t + 2];
    mesh.triangles[3 * t + 2] = b;
    for (let axis = 0; axis < 3; axis++) {
      const nb = mesh.cornerNormals[9 * t + 3 + axis];
      mesh.cornerNormals[9 * t + 3 + axis] = mesh.cornerNormals[9 * t + 6 + axis];
      mesh.cornerNormals[9 * t + 6 + axis] = nb;
    }
    for (let k = 0; k < 9; k++) {
      mesh.cornerNormals[9 * t + k] = -mesh.cornerNormals[9 * t + k];
    }
  }
}
