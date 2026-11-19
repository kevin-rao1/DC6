// The rocket's long axis, which end is the nose, and which faces are surfaces
// of revolution about that axis.
//
// Axis, in three steps:
//  1. Principal axis of the exterior surface (area-weighted covariance of the
//     triangle centroids; the eigenvector with the largest spread). For a
//     rocket this is within a fraction of a degree of the true axis.
//  2. If exterior faces with an analytic axis (cylinder, cone, torus, surface
//     of revolution) agree with step 1 within agreeDegrees, use their
//     area-weighted mean direction and the point closest to their axis lines.
//     This is exact to the CAD data.
//  3. Otherwise (a body that is all B-spline faces) refine step 1 by fitting
//     the line that the surface normals cross: on a surface of revolution every
//     normal line meets the axis, so (p - c) . (d x n) = 0 at every point p
//     with normal n. A few Gauss-Newton steps on (c, d) with a robust weight.
//
// Nose: the end whose last few percent of length has the smaller maximum
// radius (a nose tapers to a point; a tail ends in a boattail ring, a nozzle
// or fins). If the two ends differ by less than 20% the result is marked
// uncertain and the direction is chosen by a fixed rule so that loading the
// same file always gives the same answer. Doubt: a rocket with a large blunt
// nose and a long thin nozzle would be read backwards; the user can flip it.

import type { CadFace, ModelMesh, RocketAxis, Vec3 } from './types.ts';
import { SurfaceKind } from './types.ts';
import { add, angleBetweenDegrees, cross, dot, normalize, perpendicularFrame, scale, sub } from './vec3.ts';

export const axisRules = {
  agreeDegrees: 3, // analytic face axes this close to the principal axis are used
  lineDistance: 1.0, // mm; analytic axis lines further than this from the consensus are dropped
  noseBandFraction: 0.03, // end bands are this fraction of the length
  noseClearRatio: 0.8, // nose band radius must be below this times the tail band radius
  // Face classification against the axis:
  coaxialDegrees: 0.5,
  coaxialDistance: 0.5, // mm
  tiltTolerance: 0.01, // sine of the allowed circumferential tilt of a normal
  minAngularSpanDegrees: 20,
};

// Eigen-decomposition of a symmetric 3x3 matrix by Jacobi rotations.
// Returns eigenvalues and eigenvectors (columns of `vectors`, row-major).
export function symmetricEigen3(m: number[]): { values: number[]; vectors: number[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-14 * (Math.abs(a[0]) + Math.abs(a[4]) + Math.abs(a[8]) + 1e-300)) {
      break;
    }
    const pairs = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    for (let k = 0; k < 3; k++) {
      const p = pairs[k][0];
      const q = pairs[k][1];
      const apq = a[3 * p + q];
      if (Math.abs(apq) < 1e-300) {
        continue;
      }
      const app = a[3 * p + p];
      const aqq = a[3 * q + q];
      const theta = (aqq - app) / (2 * apq);
      let t = 1 / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      if (theta < 0) {
        t = -t;
      }
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      // Rotate rows/columns p and q.
      for (let r = 0; r < 3; r++) {
        const arp = a[3 * r + p];
        const arq = a[3 * r + q];
        a[3 * r + p] = c * arp - s * arq;
        a[3 * r + q] = s * arp + c * arq;
      }
      for (let r = 0; r < 3; r++) {
        const apr = a[3 * p + r];
        const aqr = a[3 * q + r];
        a[3 * p + r] = c * apr - s * aqr;
        a[3 * q + r] = s * apr + c * aqr;
      }
      for (let r = 0; r < 3; r++) {
        const vrp = v[3 * r + p];
        const vrq = v[3 * r + q];
        v[3 * r + p] = c * vrp - s * vrq;
        v[3 * r + q] = s * vrp + c * vrq;
      }
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: v };
}

function column(vectors: number[], index: number): Vec3 {
  return [vectors[index], vectors[3 + index], vectors[6 + index]];
}

// Area-weighted centroid and principal (longest) direction of the included triangles.
function principalAxis(mesh: ModelMesh, included: Uint8Array): { centroid: Vec3; direction: Vec3 } {
  const p = mesh.positions;
  const triangleCount = mesh.triangleFace.length;
  let totalArea = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  const areas = new Float64Array(triangleCount);
  const centroids = new Float64Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    if (included[t] === 0) {
      continue;
    }
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
    const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    const cx = (p[3 * a] + p[3 * b] + p[3 * c]) / 3;
    const cy = (p[3 * a + 1] + p[3 * b + 1] + p[3 * c + 1]) / 3;
    const cz = (p[3 * a + 2] + p[3 * b + 2] + p[3 * c + 2]) / 3;
    areas[t] = area;
    centroids[3 * t] = cx;
    centroids[3 * t + 1] = cy;
    centroids[3 * t + 2] = cz;
    totalArea = totalArea + area;
    sx = sx + area * cx;
    sy = sy + area * cy;
    sz = sz + area * cz;
  }
  if (!(totalArea > 0)) {
    throw new Error('principalAxis: expected some exterior area');
  }
  const centroid: Vec3 = [sx / totalArea, sy / totalArea, sz / totalArea];
  const covariance = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let t = 0; t < triangleCount; t++) {
    if (included[t] === 0) {
      continue;
    }
    const dx = centroids[3 * t] - centroid[0];
    const dy = centroids[3 * t + 1] - centroid[1];
    const dz = centroids[3 * t + 2] - centroid[2];
    const w = areas[t];
    covariance[0] = covariance[0] + w * dx * dx;
    covariance[1] = covariance[1] + w * dx * dy;
    covariance[2] = covariance[2] + w * dx * dz;
    covariance[4] = covariance[4] + w * dy * dy;
    covariance[5] = covariance[5] + w * dy * dz;
    covariance[8] = covariance[8] + w * dz * dz;
  }
  covariance[3] = covariance[1];
  covariance[6] = covariance[2];
  covariance[7] = covariance[5];
  const eigen = symmetricEigen3(covariance);
  let best = 0;
  for (let k = 1; k < 3; k++) {
    if (eigen.values[k] > eigen.values[best]) {
      best = k;
    }
  }
  const direction = normalize(column(eigen.vectors, best));
  return { centroid: centroid, direction: direction };
}

// Step 2: consensus of analytic face axes near the principal direction.
function analyticAxis(
  faces: CadFace[],
  isUsable: (face: CadFace) => boolean,
  guess: Vec3,
): { origin: Vec3; direction: Vec3; area: number } | null {
  let candidates: CadFace[] = [];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    if (!isUsable(face)) {
      continue;
    }
    const kind = face.surface.kind;
    const hasAxis =
      kind === SurfaceKind.Cylinder ||
      kind === SurfaceKind.Cone ||
      kind === SurfaceKind.Torus ||
      kind === SurfaceKind.Revolution;
    if (!hasAxis) {
      continue;
    }
    const direction = face.surface.axisDirection;
    if (direction === null || face.surface.axisOrigin === null) {
      continue;
    }
    if (angleBetweenDegrees(direction, guess, true) > axisRules.agreeDegrees) {
      continue;
    }
    candidates.push(face);
  }
  // Two passes: fit, drop lines far from the fit (e.g. a cylinder face of a
  // part that is parallel to the axis but not on it), fit again.
  for (let pass = 0; pass < 2; pass++) {
    if (candidates.length === 0) {
      return null;
    }
    const fit = fitLines(candidates, guess);
    const kept: CadFace[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const face = candidates[i];
      const distance = lineDistanceToAxis(face.surface.axisOrigin as Vec3, face.surface.axisDirection as Vec3, fit.origin, fit.direction);
      if (distance <= axisRules.lineDistance) {
        kept.push(face);
      }
    }
    if (pass === 1 || kept.length === candidates.length) {
      if (kept.length === 0) {
        return null;
      }
      const final = fitLines(kept, guess);
      return final;
    }
    candidates = kept;
  }
  return null;
}

function fitLines(faces: CadFace[], guess: Vec3): { origin: Vec3; direction: Vec3; area: number } {
  let sum: Vec3 = [0, 0, 0];
  let totalArea = 0;
  for (let i = 0; i < faces.length; i++) {
    let d = faces[i].surface.axisDirection as Vec3;
    if (dot(d, guess) < 0) {
      d = scale(d, -1);
    }
    sum = add(sum, scale(d, faces[i].area));
    totalArea = totalArea + faces[i].area;
  }
  const direction = normalize(sum);
  // Point: area-weighted mean of the axis origins projected onto the plane
  // perpendicular to the direction. Then the origin is that point.
  const frame = perpendicularFrame(direction);
  let su = 0;
  let sv = 0;
  for (let i = 0; i < faces.length; i++) {
    const o = faces[i].surface.axisOrigin as Vec3;
    su = su + faces[i].area * dot(o, frame.u);
    sv = sv + faces[i].area * dot(o, frame.v);
  }
  const origin = add(scale(frame.u, su / totalArea), scale(frame.v, sv / totalArea));
  return { origin: origin, direction: direction, area: totalArea };
}

// Distance between a (nearly parallel) line and the axis, measured at the
// line's origin.
function lineDistanceToAxis(lineOrigin: Vec3, lineDirection: Vec3, axisOrigin: Vec3, axisDirection: Vec3): number {
  const offset = sub(lineOrigin, axisOrigin);
  const along = dot(offset, axisDirection);
  const perpendicular = sub(offset, scale(axisDirection, along));
  const distance = Math.sqrt(dot(perpendicular, perpendicular));
  // lineDirection is only checked for being near-parallel by the caller.
  if (lineDirection.length !== 3) {
    throw new Error('lineDistanceToAxis: expected a 3-vector direction');
  }
  return distance;
}

interface NormalSample {
  p: Vec3;
  n: Vec3;
  w: number;
}

// Step 3: fit the axis that the surface normals cross.
function normalFitAxis(samples: NormalSample[], startOrigin: Vec3, startDirection: Vec3): { origin: Vec3; direction: Vec3 } {
  let origin = startOrigin;
  let direction = startDirection;
  for (let iteration = 0; iteration < 12; iteration++) {
    const frame = perpendicularFrame(direction);
    // Parameters: x = (du, dv, cu, cv); direction' = normalize(d + du u + dv v),
    // origin' = origin + cu u + cv v.
    const residualAt = function residual(x: number[], s: NormalSample): number {
      const d = normalize(add(direction, add(scale(frame.u, x[0]), scale(frame.v, x[1]))));
      const c = add(origin, add(scale(frame.u, x[2]), scale(frame.v, x[3])));
      return dot(sub(s.p, c), cross(d, s.n));
    };
    // Robust scale from the current residuals.
    const zero = [0, 0, 0, 0];
    const residuals: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      residuals.push(Math.abs(residualAt(zero, samples[i])));
    }
    const sorted = residuals.slice().sort(function ascending(a, b) {
      return a - b;
    });
    const median = sorted[Math.floor(sorted.length / 2)];
    const sigma = Math.max(median * 3, 1e-6);
    // Normal equations J^T W J x = -J^T W r with a numeric Jacobian.
    const jtj = new Float64Array(16);
    const jtr = new Float64Array(4);
    const step = 1e-6;
    for (let i = 0; i < samples.length; i++) {
      const r0 = residualAt(zero, samples[i]);
      const robust = 1 / (1 + (r0 / sigma) * (r0 / sigma));
      const w = samples[i].w * robust;
      const jacobian = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const x = [0, 0, 0, 0];
        x[k] = step;
        jacobian[k] = (residualAt(x, samples[i]) - r0) / step;
      }
      for (let r = 0; r < 4; r++) {
        jtr[r] = jtr[r] + w * jacobian[r] * r0;
        for (let c = 0; c < 4; c++) {
          jtj[4 * r + c] = jtj[4 * r + c] + w * jacobian[r] * jacobian[c];
        }
      }
    }
    const delta = solve4(jtj, jtr);
    if (delta === null) {
      break;
    }
    const newDirection = normalize(add(direction, add(scale(frame.u, -delta[0]), scale(frame.v, -delta[1]))));
    const newOrigin = add(origin, add(scale(frame.u, -delta[2]), scale(frame.v, -delta[3])));
    direction = newDirection;
    origin = newOrigin;
    const change = Math.abs(delta[0]) + Math.abs(delta[1]);
    if (change < 1e-10) {
      break;
    }
  }
  return { origin: origin, direction: direction };
}

// Solve a 4x4 system by Gaussian elimination with partial pivoting.
function solve4(matrix: Float64Array, rhs: Float64Array): number[] | null {
  const a: number[][] = [];
  for (let r = 0; r < 4; r++) {
    a.push([matrix[4 * r], matrix[4 * r + 1], matrix[4 * r + 2], matrix[4 * r + 3], rhs[r]]);
  }
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-300) {
      return null;
    }
    const swap = a[col];
    a[col] = a[pivot];
    a[pivot] = swap;
    for (let r = col + 1; r < 4; r++) {
      const factor = a[r][col] / a[col][col];
      for (let c = col; c < 5; c++) {
        a[r][c] = a[r][c] - factor * a[col][c];
      }
    }
  }
  const x = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let sum = a[r][4];
    for (let c = r + 1; c < 4; c++) {
      sum = sum - a[r][c] * x[c];
    }
    x[r] = sum / a[r][r];
  }
  return x;
}

// Normal samples (triangle centroids with the mean corner normal) from the
// included triangles of curved faces.
function normalSamples(mesh: ModelMesh, faces: CadFace[], included: Uint8Array, maxSamples: number): NormalSample[] {
  const candidates: number[] = [];
  const triangleCount = mesh.triangleFace.length;
  for (let t = 0; t < triangleCount; t++) {
    if (included[t] === 0) {
      continue;
    }
    const kind = faces[mesh.triangleFace[t]].surface.kind;
    if (kind === SurfaceKind.Plane) {
      continue;
    }
    candidates.push(t);
  }
  let stride = 1;
  if (candidates.length > maxSamples) {
    stride = Math.ceil(candidates.length / maxSamples);
  }
  const samples: NormalSample[] = [];
  const p = mesh.positions;
  for (let i = 0; i < candidates.length; i = i + stride) {
    const t = candidates[i];
    const a = mesh.triangles[3 * t];
    const b = mesh.triangles[3 * t + 1];
    const c = mesh.triangles[3 * t + 2];
    const point: Vec3 = [
      (p[3 * a] + p[3 * b] + p[3 * c]) / 3,
      (p[3 * a + 1] + p[3 * b + 1] + p[3 * c + 1]) / 3,
      (p[3 * a + 2] + p[3 * b + 2] + p[3 * c + 2]) / 3,
    ];
    const n = mesh.cornerNormals;
    const sum: Vec3 = [
      n[9 * t] + n[9 * t + 3] + n[9 * t + 6],
      n[9 * t + 1] + n[9 * t + 4] + n[9 * t + 7],
      n[9 * t + 2] + n[9 * t + 5] + n[9 * t + 8],
    ];
    const lengthSquared = dot(sum, sum);
    if (!(lengthSquared > 0)) {
      continue;
    }
    samples.push({ p: point, n: normalize(sum), w: 1 });
  }
  return samples;
}

// Station range and the largest radius in each end band.
function stationProfile(
  mesh: ModelMesh,
  included: Uint8Array,
  origin: Vec3,
  direction: Vec3,
): { stationMin: number; stationMax: number; radiusNearMin: number; radiusNearMax: number } {
  const vertexCount = mesh.positions.length / 3;
  const used = new Uint8Array(vertexCount);
  const triangleCount = mesh.triangleFace.length;
  for (let t = 0; t < triangleCount; t++) {
    if (included[t] === 1) {
      used[mesh.triangles[3 * t]] = 1;
      used[mesh.triangles[3 * t + 1]] = 1;
      used[mesh.triangles[3 * t + 2]] = 1;
    }
  }
  let stationMin = Infinity;
  let stationMax = -Infinity;
  const stations = new Float64Array(vertexCount);
  const radii = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    if (used[v] === 0) {
      continue;
    }
    const px = mesh.positions[3 * v] - origin[0];
    const py = mesh.positions[3 * v + 1] - origin[1];
    const pz = mesh.positions[3 * v + 2] - origin[2];
    const s = px * direction[0] + py * direction[1] + pz * direction[2];
    const rx = px - s * direction[0];
    const ry = py - s * direction[1];
    const rz = pz - s * direction[2];
    stations[v] = s;
    radii[v] = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (s < stationMin) {
      stationMin = s;
    }
    if (s > stationMax) {
      stationMax = s;
    }
  }
  const band = (stationMax - stationMin) * axisRules.noseBandFraction;
  let radiusNearMin = 0;
  let radiusNearMax = 0;
  for (let v = 0; v < vertexCount; v++) {
    if (used[v] === 0) {
      continue;
    }
    if (stations[v] <= stationMin + band && radii[v] > radiusNearMin) {
      radiusNearMin = radii[v];
    }
    if (stations[v] >= stationMax - band && radii[v] > radiusNearMax) {
      radiusNearMax = radii[v];
    }
  }
  return { stationMin: stationMin, stationMax: stationMax, radiusNearMin: radiusNearMin, radiusNearMax: radiusNearMax };
}

// Fixed tie-break for a direction whose sign the shape does not decide: make
// its largest component positive.
function canonicalSign(direction: Vec3): Vec3 {
  let largest = 0;
  for (let k = 1; k < 3; k++) {
    if (Math.abs(direction[k]) > Math.abs(direction[largest])) {
      largest = k;
    }
  }
  if (direction[largest] < 0) {
    return scale(direction, -1);
  }
  return direction;
}

// Move the origin along the axis to station 0 = the tail end, and fill in the
// station range.
function finishAxis(
  mesh: ModelMesh,
  included: Uint8Array,
  origin: Vec3,
  direction: Vec3,
  source: RocketAxis['source'],
  noseConfidence: RocketAxis['noseConfidence'],
): RocketAxis {
  const profile = stationProfile(mesh, included, origin, direction);
  const tailPoint = add(origin, scale(direction, profile.stationMin));
  const length = profile.stationMax - profile.stationMin;
  return {
    origin: tailPoint,
    direction: direction,
    source: source,
    stationMin: 0,
    stationMax: length,
    noseConfidence: noseConfidence,
  };
}

export function detectAxis(mesh: ModelMesh, faces: CadFace[], included: Uint8Array): RocketAxis {
  const principal = principalAxis(mesh, included);
  let origin = principal.centroid;
  let direction = principal.direction;
  let source: RocketAxis['source'] = 'pca';

  const isIncludedFace = function isIncludedFace(face: CadFace): boolean {
    if (face.triangleCount === 0) {
      return false;
    }
    return included[face.triangleStart] === 1;
  };
  const analytic = analyticAxis(faces, isIncludedFace, direction);
  if (analytic !== null) {
    direction = analytic.direction;
    origin = analytic.origin;
    source = 'analytic-faces';
  } else {
    const samples = normalSamples(mesh, faces, included, 4000);
    if (samples.length >= 12) {
      const fitted = normalFitAxis(samples, origin, direction);
      // Only accept the fit if it stayed near the principal axis; a wild
      // result means the surface is not a body of revolution.
      if (angleBetweenDegrees(fitted.direction, principal.direction, true) < 10) {
        direction = fitted.direction;
        origin = fitted.origin;
        source = 'normal-fit';
      }
    }
  }

  // Which end is the nose.
  const profile = stationProfile(mesh, included, origin, direction);
  let noseConfidence: RocketAxis['noseConfidence'] = 'uncertain';
  if (profile.radiusNearMax < axisRules.noseClearRatio * profile.radiusNearMin) {
    noseConfidence = 'clear';
  } else if (profile.radiusNearMin < axisRules.noseClearRatio * profile.radiusNearMax) {
    direction = scale(direction, -1);
    noseConfidence = 'clear';
  } else {
    direction = canonicalSign(direction);
  }
  return finishAxis(mesh, included, origin, direction, source, noseConfidence);
}

// The user's choice of axis direction: a world axis, optionally flipped.
// The axis line is placed through the analytic consensus point if the
// analytic faces agree with the chosen direction, otherwise through the
// exterior area centroid.
export function axisFromUser(mesh: ModelMesh, faces: CadFace[], included: Uint8Array, direction: Vec3): RocketAxis {
  const unit = normalize(direction);
  const principal = principalAxis(mesh, included);
  let origin = principal.centroid;
  const isIncludedFace = function isIncludedFace(face: CadFace): boolean {
    if (face.triangleCount === 0) {
      return false;
    }
    return included[face.triangleStart] === 1;
  };
  const analytic = analyticAxis(faces, isIncludedFace, unit);
  if (analytic !== null) {
    origin = analytic.origin;
  }
  const result = finishAxis(mesh, included, origin, unit, 'user', 'user');
  return result;
}

export function flipAxis(axis: RocketAxis): RocketAxis {
  const length = axis.stationMax - axis.stationMin;
  const nose = add(axis.origin, scale(axis.direction, length));
  return {
    origin: nose,
    direction: scale(axis.direction, -1),
    source: axis.source,
    stationMin: 0,
    stationMax: length,
    noseConfidence: 'user',
  };
}

// ---------------------------------------------------------------------------
// Axisymmetric faces.

// Smallest arc (degrees) that holds every given roll angle: 360 minus the
// largest gap between neighbouring angles.
function angularSpanDegrees(angles: number[]): number {
  if (angles.length < 2) {
    return 0;
  }
  const sorted = angles.slice().sort(function ascending(a, b) {
    return a - b;
  });
  let largestGap = sorted[0] + 2 * Math.PI - sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > largestGap) {
      largestGap = gap;
    }
  }
  const span = 2 * Math.PI - largestGap;
  return (span * 180) / Math.PI;
}

// Mark each face axisymmetric if it is a surface of revolution about the
// rocket axis (brief 4.3.2: test numerically too, not only by surface type).
//   - Analytic faces (cylinder, cone, torus, revolution, sphere): their own
//     axis (or centre) lies on the rocket axis.
//   - Every other face: at every sampled vertex the normal has no
//     circumferential component (it lies in the plane through the axis), and
//     the face spans at least minAngularSpanDegrees of roll. The span rule
//     stops thin faces that happen to face outwards, such as a fin tip, from
//     counting.
export function classifyAxisymmetric(mesh: ModelMesh, faces: CadFace[], axis: RocketAxis): void {
  const d = axis.direction;
  const o = axis.origin;
  const frame = perpendicularFrame(d);
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    const surface = face.surface;
    const kind = surface.kind;
    let result = false;
    if (
      (kind === SurfaceKind.Cylinder || kind === SurfaceKind.Cone || kind === SurfaceKind.Torus || kind === SurfaceKind.Revolution) &&
      surface.axisDirection !== null &&
      surface.axisOrigin !== null
    ) {
      const parallel = angleBetweenDegrees(surface.axisDirection, d, true) <= axisRules.coaxialDegrees;
      const distance = lineDistanceToAxis(surface.axisOrigin, surface.axisDirection, o, d);
      result = parallel && distance <= axisRules.coaxialDistance;
    } else if (kind === SurfaceKind.Sphere && surface.axisOrigin !== null) {
      const distance = lineDistanceToAxis(surface.axisOrigin, d, o, d);
      result = distance <= axisRules.coaxialDistance;
    } else {
      result = numericallyAxisymmetric(mesh, face, o, d, frame.u, frame.v);
    }
    face.axisymmetric = result;
  }
}

function numericallyAxisymmetric(mesh: ModelMesh, face: CadFace, o: Vec3, d: Vec3, u: Vec3, v: Vec3): boolean {
  if (face.triangleCount === 0) {
    return false;
  }
  const angles: number[] = [];
  let tilted = 0;
  let checked = 0;
  let stride = 1;
  const maxSamples = 600;
  if (face.triangleCount > maxSamples) {
    stride = Math.ceil(face.triangleCount / maxSamples);
  }
  const end = face.triangleStart + face.triangleCount;
  for (let t = face.triangleStart; t < end; t = t + stride) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = mesh.triangles[3 * t + corner];
      const px = mesh.positions[3 * vertex] - o[0];
      const py = mesh.positions[3 * vertex + 1] - o[1];
      const pz = mesh.positions[3 * vertex + 2] - o[2];
      const s = px * d[0] + py * d[1] + pz * d[2];
      const rx = px - s * d[0];
      const ry = py - s * d[1];
      const rz = pz - s * d[2];
      const radius = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const nx = mesh.cornerNormals[9 * t + 3 * corner];
      const ny = mesh.cornerNormals[9 * t + 3 * corner + 1];
      const nz = mesh.cornerNormals[9 * t + 3 * corner + 2];
      if (radius < 1e-6) {
        continue; // on the axis: no circumferential direction
      }
      // Circumferential unit direction at this point: d x r / |r|.
      const ex = (d[1] * rz - d[2] * ry) / radius;
      const ey = (d[2] * rx - d[0] * rz) / radius;
      const ez = (d[0] * ry - d[1] * rx) / radius;
      const tilt = Math.abs(nx * ex + ny * ey + nz * ez);
      checked = checked + 1;
      if (tilt > axisRules.tiltTolerance) {
        tilted = tilted + 1;
      }
      const cu = rx * u[0] + ry * u[1] + rz * u[2];
      const cv = rx * v[0] + ry * v[1] + rz * v[2];
      angles.push(Math.atan2(cv, cu) + Math.PI);
    }
  }
  if (checked === 0) {
    return false;
  }
  // Allow a few stray vertices (degenerate corners of the tessellation).
  if (tilted > 0.02 * checked) {
    return false;
  }
  const span = angularSpanDegrees(angles);
  return span >= axisRules.minAngularSpanDegrees;
}

// Station and roll (radians, 0..2pi from the axis frame's u direction) of a point.
export function cylindricalCoordinates(axis: RocketAxis, point: Vec3): { station: number; radius: number; roll: number } {
  const frame = perpendicularFrame(axis.direction);
  const offset = sub(point, axis.origin);
  const station = dot(offset, axis.direction);
  const radial = sub(offset, scale(axis.direction, station));
  const radius = Math.sqrt(dot(radial, radial));
  let roll = Math.atan2(dot(radial, frame.v), dot(radial, frame.u));
  if (roll < 0) {
    roll = roll + 2 * Math.PI;
  }
  // A point a hair below the u direction (rounding noise) comes out as just
  // under 2pi; call it 0 so that a fin on the u direction reads 0, not 360.
  if (roll > 2 * Math.PI - 1e-5) {
    roll = 0;
  }
  return { station: station, radius: radius, roll: roll };
}
