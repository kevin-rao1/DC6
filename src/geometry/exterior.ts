// Which faces and parts can be seen from outside the rocket.
//
// Method: for sample points on each face (triangle centroids), cast rays
// outwards in many directions. A sample point counts as "seen from outside"
// if enough of the rays leaving it escape the model without hitting anything.
// A face is exterior if enough of its area is seen. A part is exterior if
// enough of its area is seen; a part that is not exterior has all its faces
// hidden.
//
// The rules, and why:
// - Rays leave from both sides of the surface (orientation is not trusted at
//   this point): first along the CAD normal, and only if that side is not seen,
//   from the other side. The side that sees out is the outward side, and is
//   used to orient the face (orientOutward below).
// - A sample is seen only if at least minSeenFraction (15%) of the directions in
//   its outward hemisphere escape. An outer surface point sees about 100%; a
//   point in the corner between a fin and the body about 50%; a point on the
//   inner wall of a tube a few centimetres in from an open end sees the sky
//   only through the opening, a few percent. So a ray glancing up an open tail
//   does not make the inner wall count as seen.
// - A face is exterior if at least faceExteriorFraction (50%) of its area is
//   seen. A tube's inner wall near an open end is partly seen, but only a small
//   fraction of the whole face; an end ring (the aft edge of the boattail) is
//   fully seen and is exterior, which is what we want: it is part of the
//   visible airframe.
// - A part is exterior if at least partExteriorFraction (5%) of its area is
//   seen. A motor tube whose aft ring shows through the open tail has well
//   under 1% of its area seen, so it is hidden as a whole, ring and all.
//
// Doubts:
// - The direction set is fixed (Fibonacci sphere); a very narrow slot that
//   only a few directions see through could be missed or caught depending on
//   where those directions fall.
// - Faces exactly coincident with another part's face (a fin root lying on the
//   tube) are hidden, because rays from them start inside the other part. That
//   is the right answer for a fin root, but would be wrong for two parts that
//   overlap without one covering the other (not expected in a rocket).
// - Samples are triangle centroids, at most maxSamplesPerFace per face; a face
//   with a few huge triangles and a small visible corner may be misjudged.

import type { Bvh } from './bvh.ts';
import { makeTraversalStack, rayHitsAny } from './bvh.ts';
import type { CadFace, CadPart, ModelMesh } from './types.ts';
import { flipFace, triangleNormal } from './mesh.ts';

export const exteriorRules = {
  directionCount: 128,
  minSeenFraction: 0.15,
  faceExteriorFraction: 0.5,
  partExteriorFraction: 0.05,
  maxSamplesPerFace: 160,
  // How far off the surface a ray starts, so it does not hit its own triangle.
  rayStartOffset: 0.01,
};

// Evenly spread unit directions on the sphere (Fibonacci lattice).
export function sphereDirections(count: number): Float64Array {
  const directions = new Float64Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(1 - z * z);
    const angle = goldenAngle * i;
    directions[3 * i] = radius * Math.cos(angle);
    directions[3 * i + 1] = radius * Math.sin(angle);
    directions[3 * i + 2] = z;
  }
  return directions;
}

export interface FaceVisibility {
  visibleFraction: number;
  // +1 if the face's current winding normal points to the side that sees out,
  // -1 if the other side does, 0 if no sample was seen.
  outwardSign: number;
}

// Is the point seen from the side `side` (+1 along n, -1 against)?
function seenFromSide(
  bvh: Bvh,
  stack: Int32Array,
  directions: Float64Array,
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  ny: number,
  nz: number,
  side: number,
): boolean {
  const offset = exteriorRules.rayStartOffset;
  const ox = cx + side * nx * offset;
  const oy = cy + side * ny * offset;
  const oz = cz + side * nz * offset;
  const directionCount = directions.length / 3;
  // Count the directions in this side's hemisphere first, so we know how many
  // escapes are needed and when it can no longer succeed.
  let hemisphereCount = 0;
  for (let d = 0; d < directionCount; d++) {
    const along = side * (directions[3 * d] * nx + directions[3 * d + 1] * ny + directions[3 * d + 2] * nz);
    if (along > 0) {
      hemisphereCount = hemisphereCount + 1;
    }
  }
  const needed = Math.ceil(exteriorRules.minSeenFraction * hemisphereCount);
  let escaped = 0;
  let tested = 0;
  for (let d = 0; d < directionCount; d++) {
    const dx = directions[3 * d];
    const dy = directions[3 * d + 1];
    const dz = directions[3 * d + 2];
    const along = side * (dx * nx + dy * ny + dz * nz);
    if (!(along > 0)) {
      continue;
    }
    tested = tested + 1;
    const hit = rayHitsAny(bvh, ox, oy, oz, dx, dy, dz, 0, Infinity, stack);
    if (!hit) {
      escaped = escaped + 1;
      if (escaped >= needed) {
        return true;
      }
    }
    const remaining = hemisphereCount - tested;
    if (escaped + remaining < needed) {
      return false;
    }
  }
  return false;
}

export function faceVisibility(mesh: ModelMesh, faces: CadFace[], bvh: Bvh): FaceVisibility[] {
  const directions = sphereDirections(exteriorRules.directionCount);
  const stack = makeTraversalStack(bvh);
  const normal = new Float64Array(3);
  const result: FaceVisibility[] = [];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    let sampledArea = 0;
    let seenArea = 0;
    let outwardVote = 0;
    // Sample every k-th triangle so a face gets at most maxSamplesPerFace samples.
    let stride = 1;
    if (face.triangleCount > exteriorRules.maxSamplesPerFace) {
      stride = Math.ceil(face.triangleCount / exteriorRules.maxSamplesPerFace);
    }
    const end = face.triangleStart + face.triangleCount;
    for (let t = face.triangleStart; t < end; t = t + stride) {
      const a = mesh.triangles[3 * t];
      const b = mesh.triangles[3 * t + 1];
      const c = mesh.triangles[3 * t + 2];
      const cx = (mesh.positions[3 * a] + mesh.positions[3 * b] + mesh.positions[3 * c]) / 3;
      const cy = (mesh.positions[3 * a + 1] + mesh.positions[3 * b + 1] + mesh.positions[3 * c + 1]) / 3;
      const cz = (mesh.positions[3 * a + 2] + mesh.positions[3 * b + 2] + mesh.positions[3 * c + 2]) / 3;
      triangleNormal(mesh.positions, mesh.triangles, t, normal);
      const area = triangleArea(mesh, t);
      sampledArea = sampledArea + area;
      const seenFront = seenFromSide(bvh, stack, directions, cx, cy, cz, normal[0], normal[1], normal[2], 1);
      if (seenFront) {
        seenArea = seenArea + area;
        outwardVote = outwardVote + area;
        continue;
      }
      const seenBack = seenFromSide(bvh, stack, directions, cx, cy, cz, normal[0], normal[1], normal[2], -1);
      if (seenBack) {
        seenArea = seenArea + area;
        outwardVote = outwardVote - area;
      }
    }
    let fraction = 0;
    if (sampledArea > 0) {
      fraction = seenArea / sampledArea;
    }
    let sign = 0;
    if (outwardVote > 0) {
      sign = 1;
    } else if (outwardVote < 0) {
      sign = -1;
    }
    result.push({ visibleFraction: fraction, outwardSign: sign });
  }
  return result;
}

function triangleArea(mesh: ModelMesh, t: number): number {
  const p = mesh.positions;
  const a = mesh.triangles[3 * t];
  const b = mesh.triangles[3 * t + 1];
  const c = mesh.triangles[3 * t + 2];
  const abx = p[3 * b] - p[3 * a];
  const aby = p[3 * b + 1] - p[3 * a + 1];
  const abz = p[3 * b + 2] - p[3 * a + 2];
  const acx = p[3 * c] - p[3 * a];
  const acy = p[3 * c + 1] - p[3 * a + 1];
  const acz = p[3 * c + 2] - p[3 * a + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

// Apply the rules above: fill in face.visibleFraction and face.exterior, and
// each part's exteriorAreaFraction and exterior flag. A face of a hidden part
// is not exterior.
export function classifyExterior(faces: CadFace[], parts: CadPart[], visibility: FaceVisibility[]): void {
  for (let f = 0; f < faces.length; f++) {
    faces[f].visibleFraction = visibility[f].visibleFraction;
    faces[f].exterior = visibility[f].visibleFraction >= exteriorRules.faceExteriorFraction;
  }
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    let seenArea = 0;
    let totalArea = 0;
    for (let k = 0; k < part.faceIds.length; k++) {
      const face = faces[part.faceIds[k]];
      totalArea = totalArea + face.area;
      seenArea = seenArea + face.area * face.visibleFraction;
    }
    let fraction = 0;
    if (totalArea > 0) {
      fraction = seenArea / totalArea;
    }
    part.area = totalArea;
    part.exteriorAreaFraction = fraction;
    part.exterior = fraction >= exteriorRules.partExteriorFraction;
  }
  for (let f = 0; f < faces.length; f++) {
    const part = parts[faces[f].part];
    if (!part.exterior) {
      faces[f].exterior = false;
    }
  }
}

// Flip faces whose winding points inwards, so that every seen face's
// triangles face outwards. Faces nobody saw keep the CAD orientation.
// Returns the number of faces flipped.
export function orientOutward(mesh: ModelMesh, faces: CadFace[], visibility: FaceVisibility[]): number {
  let flipped = 0;
  for (let f = 0; f < faces.length; f++) {
    if (visibility[f].outwardSign < 0) {
      flipFace(mesh, faces[f]);
      flipped = flipped + 1;
    }
  }
  return flipped;
}
