// Candidate attach faces of a part: where place on face and stack snapping
// can join it to another part.
//
// Two sources, merged:
//
// 1. Flat sides of the convex hull, as PrusaSlicer's and Bambu Studio's "lay
//    on face" offer them. Coplanar hull triangles are grouped into facets; a
//    facet is kept when
//      - its area is at least 1% of the hull's surface area (PrusaSlicer's
//        GLGizmoFlatten uses 1% of the total area, as far as I recall it),
//      - its outline has no corner sharper than 10 degrees (PrusaSlicer drops
//        such slivers too), and
//      - [our addition] a flat CAD face of the part really lies in the facet
//        plane over at least 1% of the facet. Without this, the strips the
//        hull makes along a tessellated cylinder or cone (each a few percent
//        of the area on a long tube) would be offered. PrusaSlicer does offer
//        them; for joining rocket sections they are noise.
//
// 2. Large circular flat features of the real geometry. On the can, internal
//    structure sticks out of the open end, so the hull's end facet sits on
//    the tip of the internals, not on the shell rim the user wants to mate.
//    So every flat CAD face bounded by a circle of large radius also offers a
//    disc (centre, normal, radius of that circle), when
//      - the face's edges go at least 90% of the way round the circle,
//      - the radius is at least 60% of the largest such circle on the part
//        and at least 3 mm (small holes and bosses offer nothing),
//      - the rim is on the outside: rays outward in the disc plane from just
//        beyond the rim leave the part (a ledge inside a cavity fails), and
//      - the face is open to the outside along its normal: from at least 25%
//        of sample points on the face, a ray along the normal leaves the part
//        without hitting it. A groove side wall faces the opposite wall and
//        fails; the can rim faces past the internals and passes.
//    Doubt: this would also offer an internal bulkhead that faces an open end
//    (a disc deep inside a tube with nothing in front of it). On our parts
//    such discs are hull facets anyway, so nothing extra appears; on a real
//    part with a recessed bulkhead the user would see one more disc.
//
// Where a feature disc and a hull facet coincide (same plane, same centre)
// they become one candidate. At most maxCandidates are kept, biggest first.

import type { AttachFace, CadFace } from './part.ts';
import type { Vec3 } from './vec3.ts';
import { add, cross, dot, length, normalize, scale, sub, pointAt, anyPerpendicular } from './vec3.ts';
import type { Bvh } from './part.ts';
import { raycast } from './bvh.ts';

export const minimumFacetAreaFraction = 0.01;
export const sliverAngleDegrees = 10;
export const minimumContactFraction = 0.01;
export const featureRadiusFraction = 0.6;
export const minimumFeatureRadius = 3;
export const minimumClearFraction = 0.25;
// A face's circular edges must go at least this far round (as a fraction of
// a full turn) for the circle to count.
export const minimumCircleCoverage = 0.9;
export const maxCandidates = 12;

// Hull triangles within this distance of a facet plane belong to it. The
// vertices of a CAD plane are exact up to float32 rounding (a few hundredths
// of a micrometre at rocket sizes); 2 micrometres also keeps the first row of
// a fillet's vertices, tangent to the plane, out of most facets.
const planeTolerance = 0.002;
// A part triangle counts as lying in a facet plane within this distance.
const contactTolerance = 0.01;

export interface AttachInput {
  positions: Float32Array;
  indices: Uint32Array;
  triangleFace: Uint32Array;
  faces: CadFace[];
  edges: Array<{ circle: { centre: Vec3; axis: Vec3; radius: number; span: number } | null }>;
  hullPoints: Float64Array;
  hullTriangles: Uint32Array;
  bvh: Bvh;
}

// A plane frame: origin, normal, and two in-plane axes.
interface PlaneFrame {
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}

function planeFrame(origin: Vec3, normal: Vec3): PlaneFrame {
  const u = anyPerpendicular(normal);
  const v = cross(normal, u);
  return { origin: origin, normal: normal, u: u, v: v };
}

function toPlane(frame: PlaneFrame, p: Vec3): [number, number] {
  const d = sub(p, frame.origin);
  return [dot(d, frame.u), dot(d, frame.v)];
}

function fromPlane(frame: PlaneFrame, q: [number, number]): Vec3 {
  return add(frame.origin, add(scale(frame.u, q[0]), scale(frame.v, q[1])));
}

// 2D convex hull, counter-clockwise (Andrew's monotone chain).
function convexHull2d(points: Array<[number, number]>): Array<[number, number]> {
  const sorted = points.slice();
  sorted.sort(function byXThenY(a, b) {
    if (a[0] !== b[0]) {
      return a[0] - b[0];
    }
    return a[1] - b[1];
  });
  function turn(o: [number, number], a: [number, number], b: [number, number]): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }
  const lower: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; i++) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0) {
      lower.pop();
    }
    lower.push(sorted[i]);
  }
  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], sorted[i]) <= 0) {
      upper.pop();
    }
    upper.push(sorted[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Drop outline points closer than minSpacing to the previous kept point, so
// that the corner-angle test is not fooled by near-duplicates.
function thinOutline(outline: Array<[number, number]>, minSpacing: number): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    if (kept.length > 0) {
      const last = kept[kept.length - 1];
      const gap = Math.hypot(p[0] - last[0], p[1] - last[1]);
      if (gap < minSpacing) {
        continue;
      }
    }
    kept.push(p);
  }
  if (kept.length > 2) {
    const first = kept[0];
    const last = kept[kept.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < minSpacing) {
      kept.pop();
    }
  }
  return kept;
}

function polygonArea(outline: Array<[number, number]>): number {
  let twice = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    twice = twice + a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

function polygonCentroid(outline: Array<[number, number]>): [number, number] {
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const cross2 = a[0] * b[1] - b[0] * a[1];
    twice = twice + cross2;
    cx = cx + (a[0] + b[0]) * cross2;
    cy = cy + (a[1] + b[1]) * cross2;
  }
  if (Math.abs(twice) < 1e-12) {
    return outline[0];
  }
  return [cx / (3 * twice), cy / (3 * twice)];
}

function hasSliverCorner(outline: Array<[number, number]>): boolean {
  const threshold = Math.cos((sliverAngleDegrees * Math.PI) / 180);
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const previous = outline[(i + n - 1) % n];
    const current = outline[i];
    const next = outline[(i + 1) % n];
    const ax = previous[0] - current[0];
    const ay = previous[1] - current[1];
    const bx = next[0] - current[0];
    const by = next[1] - current[1];
    const cosine = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    if (cosine > threshold) {
      return true;
    }
  }
  return false;
}

// Least-squares circle through 2D points (Kasa fit). Returns null when the
// points are not on a circle within 2% of its radius.
function fitCircle(outline: Array<[number, number]>): { centre: [number, number]; radius: number } | null {
  if (outline.length < 12) {
    return null;
  }
  // Solve x^2 + y^2 = 2 a x + 2 b y + c in the least-squares sense.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let sxz = 0;
  let syz = 0;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const x = outline[i][0];
    const y = outline[i][1];
    const z = x * x + y * y;
    sxx = sxx + x * x;
    sxy = sxy + x * y;
    syy = syy + y * y;
    sx = sx + x;
    sy = sy + y;
    sz = sz + z;
    sxz = sxz + x * z;
    syz = syz + y * z;
  }
  // Normal equations, unknowns (2a, 2b, c).
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const r = [sxz, syz, sz];
  const solution = solve3(m, r);
  if (solution === null) {
    return null;
  }
  const a = solution[0] / 2;
  const b = solution[1] / 2;
  const radiusSquared = solution[2] + a * a + b * b;
  if (radiusSquared <= 0) {
    return null;
  }
  const radius = Math.sqrt(radiusSquared);
  const angles: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(outline[i][0] - a, outline[i][1] - b);
    if (Math.abs(d - radius) > 0.02 * radius) {
      return null;
    }
    angles.push(Math.atan2(outline[i][1] - b, outline[i][0] - a));
  }
  // The points must go round the circle, not bunch at a few places: the
  // corners of a long thin rectangle also lie on a circle.
  angles.sort(function ascending(p, q) {
    return p - q;
  });
  let widestGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) {
    widestGap = Math.max(widestGap, angles[i] - angles[i - 1]);
  }
  if (widestGap > Math.PI / 6) {
    return null;
  }
  return { centre: [a, b], radius: radius };
}

function solve3(m: number[][], r: number[]): number[] | null {
  // Cramer's rule; the matrices here are small and well conditioned enough.
  function det(a: number[][]): number {
    return (
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
      a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
      a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
    );
  }
  const d = det(m);
  if (Math.abs(d) < 1e-12) {
    return null;
  }
  const result: number[] = [];
  for (let column = 0; column < 3; column++) {
    const replaced = [m[0].slice(), m[1].slice(), m[2].slice()];
    for (let row = 0; row < 3; row++) {
      replaced[row][column] = r[row];
    }
    result.push(det(replaced) / d);
  }
  return result;
}

// Direction in the plane along which the outline is long: the direction of
// its longest edge. For a fin root (a long thin strip) that is the root
// chord. (The farthest pair of points would give the diagonal instead.)
function longestDirection(frame: PlaneFrame, outline: Array<[number, number]>): Vec3 {
  let best = -1;
  let direction: [number, number] = [1, 0];
  for (let i = 0; i < outline.length; i++) {
    const next = outline[(i + 1) % outline.length];
    const dx = next[0] - outline[i][0];
    const dy = next[1] - outline[i][1];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      direction = [dx, dy];
    }
  }
  const world = add(scale(frame.u, direction[0]), scale(frame.v, direction[1]));
  return normalize(world);
}

function circleOutline(frame: PlaneFrame, radius: number): Vec3[] {
  const points: Vec3[] = [];
  const segments = 64;
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    points.push(fromPlane(frame, [radius * Math.cos(angle), radius * Math.sin(angle)]));
  }
  return points;
}

// Make a candidate from 2D outline points in a plane frame.
function candidateFromOutline(frame: PlaneFrame, outline: Array<[number, number]>, source: AttachFace['source']): AttachFace {
  const circle = fitCircle(outline);
  const area = polygonArea(outline);
  let centre: Vec3;
  let radius: number | null = null;
  if (circle !== null) {
    centre = fromPlane(frame, circle.centre);
    radius = circle.radius;
  } else {
    centre = fromPlane(frame, polygonCentroid(outline));
  }
  const points: Vec3[] = [];
  for (let i = 0; i < outline.length; i++) {
    points.push(fromPlane(frame, outline[i]));
  }
  return {
    normal: frame.normal,
    centre: centre,
    outline: points,
    area: area,
    radius: radius,
    longDirection: longestDirection(frame, outline),
    source: source,
  };
}

function triangleArea(positions: ArrayLike<number>, a: number, b: number, c: number): number {
  const pa = pointAt(positions, a);
  const ab = sub(pointAt(positions, b), pa);
  const ac = sub(pointAt(positions, c), pa);
  return length(cross(ab, ac)) / 2;
}

// Area of flat CAD faces of the part lying in the plane (n . p = offset).
function contactArea(input: AttachInput, normal: Vec3, offset: number): number {
  let area = 0;
  const triangleCount = input.indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    const face = input.faces[input.triangleFace[t]];
    if (!face.flat || face.flatNormal === null) {
      continue;
    }
    if (dot(face.flatNormal, normal) < 0.99) {
      continue;
    }
    let inPlane = true;
    for (let corner = 0; corner < 3; corner++) {
      const p = pointAt(input.positions, input.indices[3 * t + corner]);
      if (Math.abs(dot(p, normal) - offset) > contactTolerance) {
        inPlane = false;
      }
    }
    if (inPlane) {
      area = area + triangleArea(input.positions, input.indices[3 * t], input.indices[3 * t + 1], input.indices[3 * t + 2]);
    }
  }
  return area;
}

export function hullFacets(input: AttachInput): AttachFace[] {
  const points = input.hullPoints;
  const triangles = input.hullTriangles;
  const triangleCount = triangles.length / 3;
  const normals: Vec3[] = [];
  const areas: number[] = [];
  let totalArea = 0;
  for (let t = 0; t < triangleCount; t++) {
    const a = pointAt(points, triangles[3 * t]);
    const b = pointAt(points, triangles[3 * t + 1]);
    const c = pointAt(points, triangles[3 * t + 2]);
    const n = cross(sub(b, a), sub(c, a));
    const area = length(n) / 2;
    areas.push(area);
    totalArea = totalArea + area;
    if (area > 0) {
      normals.push(scale(n, 1 / (2 * area)));
    } else {
      normals.push([0, 0, 0]);
    }
  }

  // Seeds in order of area, largest first: a large triangle has a reliable normal.
  const seeds: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    seeds.push(t);
  }
  seeds.sort(function byArea(p, q) {
    return areas[q] - areas[p];
  });

  const used = new Uint8Array(triangleCount);
  const facets: AttachFace[] = [];
  for (let s = 0; s < seeds.length; s++) {
    const seed = seeds[s];
    if (used[seed] === 1 || areas[seed] === 0) {
      continue;
    }
    const normal = normals[seed];
    const offset = dot(pointAt(points, triangles[3 * seed]), normal);
    // On a convex hull every triangle with all corners in a supporting plane
    // belongs to the one face in that plane, so no adjacency walk is needed.
    const members: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      if (used[t] === 1) {
        continue;
      }
      if (areas[t] > 0 && dot(normals[t], normal) < 0.5) {
        continue;
      }
      let inPlane = true;
      for (let corner = 0; corner < 3; corner++) {
        const p = pointAt(points, triangles[3 * t + corner]);
        if (Math.abs(dot(p, normal) - offset) > planeTolerance) {
          inPlane = false;
          break;
        }
      }
      if (inPlane) {
        members.push(t);
      }
    }
    let facetArea = 0;
    for (let k = 0; k < members.length; k++) {
      used[members[k]] = 1;
      facetArea = facetArea + areas[members[k]];
    }
    if (facetArea < minimumFacetAreaFraction * totalArea) {
      continue;
    }
    const frame = planeFrame(scale(normal, offset), normal);
    const flatPoints: Array<[number, number]> = [];
    for (let k = 0; k < members.length; k++) {
      for (let corner = 0; corner < 3; corner++) {
        flatPoints.push(toPlane(frame, pointAt(points, triangles[3 * members[k] + corner])));
      }
    }
    const outline = thinOutline(convexHull2d(flatPoints), 0.2);
    if (outline.length < 3 || hasSliverCorner(outline)) {
      continue;
    }
    const contact = contactArea(input, normal, offset);
    if (contact < minimumContactFraction * facetArea) {
      continue;
    }
    facets.push(candidateFromOutline(frame, outline, 'hull'));
  }
  return facets;
}

// Discs from flat CAD faces bounded by large circles (see the top of the file).
export function featureDiscs(input: AttachInput): AttachFace[] {
  interface Found {
    face: number;
    centre: Vec3;
    normal: Vec3;
    radius: number;
  }
  const found: Found[] = [];
  let largest = 0;
  for (let f = 0; f < input.faces.length; f++) {
    const face = input.faces[f];
    if (!face.flat || face.flatNormal === null) {
      continue;
    }
    // Group the face's circular edges by circle (CAD often splits a circle
    // into two or more arcs) and keep circles the face's edges go nearly all
    // the way round. A fin's trailing edge face meeting the tube has an arc
    // of the tube's radius, but only a few degrees of it.
    const circles: Array<{ centre: Vec3; radius: number; span: number }> = [];
    for (let k = 0; k < face.edges.length; k++) {
      const circle = input.edges[face.edges[k]].circle;
      if (circle === null) {
        continue;
      }
      if (Math.abs(dot(circle.axis, face.flatNormal)) < 0.999) {
        continue;
      }
      let joined = false;
      for (let c = 0; c < circles.length; c++) {
        const sameCentre = length(sub(circles[c].centre, circle.centre)) < 1e-3;
        const sameRadius = Math.abs(circles[c].radius - circle.radius) < 1e-3;
        if (sameCentre && sameRadius) {
          circles[c].span = circles[c].span + circle.span;
          joined = true;
        }
      }
      if (!joined) {
        circles.push({ centre: circle.centre, radius: circle.radius, span: circle.span });
      }
    }
    let best: Found | null = null;
    for (let c = 0; c < circles.length; c++) {
      if (circles[c].span < minimumCircleCoverage * 2 * Math.PI) {
        continue;
      }
      if (best === null || circles[c].radius > best.radius) {
        best = { face: f, centre: circles[c].centre, normal: face.flatNormal, radius: circles[c].radius };
      }
    }
    if (best !== null) {
      found.push(best);
      largest = Math.max(largest, best.radius);
    }
  }

  const discs: AttachFace[] = [];
  for (let i = 0; i < found.length; i++) {
    const candidate = found[i];
    if (candidate.radius < minimumFeatureRadius || candidate.radius < featureRadiusFraction * largest) {
      continue;
    }
    if (clearFraction(input, candidate.face, candidate.normal) < minimumClearFraction) {
      continue;
    }
    if (!rimIsOutside(input, candidate.centre, candidate.normal, candidate.radius)) {
      continue;
    }
    const frame = planeFrame(candidate.centre, candidate.normal);
    discs.push({
      normal: candidate.normal,
      centre: candidate.centre,
      outline: circleOutline(frame, candidate.radius),
      area: Math.PI * candidate.radius * candidate.radius,
      radius: candidate.radius,
      longDirection: frame.u,
      source: 'feature',
    });
  }
  return discs;
}

// Fraction of sample points on a face from which a ray along the normal
// leaves the part without hitting it. Samples: triangle centres and the
// midpoints of triangle edges.
function clearFraction(input: AttachInput, faceIndex: number, normal: Vec3): number {
  let samples = 0;
  let clear = 0;
  const triangleCount = input.indices.length / 3;
  for (let t = 0; t < triangleCount; t++) {
    if (input.triangleFace[t] !== faceIndex) {
      continue;
    }
    const a = pointAt(input.positions, input.indices[3 * t]);
    const b = pointAt(input.positions, input.indices[3 * t + 1]);
    const c = pointAt(input.positions, input.indices[3 * t + 2]);
    const starts: Vec3[] = [
      scale(add(add(a, b), c), 1 / 3),
      scale(add(a, b), 0.5),
      scale(add(b, c), 0.5),
      scale(add(c, a), 0.5),
    ];
    for (let k = 0; k < starts.length; k++) {
      // Start a little off the face so the face itself is not hit.
      const origin = add(starts[k], scale(normal, 0.01));
      const hit = raycast(input.bvh, input.positions, input.indices, origin, normal, Infinity);
      samples = samples + 1;
      if (hit === null) {
        clear = clear + 1;
      }
    }
  }
  if (samples === 0) {
    return 0;
  }
  return clear / samples;
}

// Is the disc's rim on the outside of the part? From just beyond the rim
// (and just in front of the face), rays straight outward in the disc plane
// must mostly leave the part. A ledge inside a cavity (the top of a nose's
// bore, the top of a strut inside the can) has wall all round it and fails.
function rimIsOutside(input: AttachInput, centre: Vec3, normal: Vec3, radius: number): boolean {
  const frame = planeFrame(centre, normal);
  const rays = 16;
  let clear = 0;
  for (let i = 0; i < rays; i++) {
    const angle = (2 * Math.PI * i) / rays;
    const outward = normalize(add(scale(frame.u, Math.cos(angle)), scale(frame.v, Math.sin(angle))));
    const origin = add(add(centre, scale(outward, radius + 0.05)), scale(normal, 0.05));
    const hit = raycast(input.bvh, input.positions, input.indices, origin, outward, Infinity);
    if (hit === null) {
      clear = clear + 1;
    }
  }
  return clear >= rays / 2;
}

// Two candidates are the same place when their planes and centres coincide.
function sameCandidate(a: AttachFace, b: AttachFace): boolean {
  if (dot(a.normal, b.normal) < 0.999) {
    return false;
  }
  const planeGap = Math.abs(dot(sub(b.centre, a.centre), a.normal));
  if (planeGap > 0.05) {
    return false;
  }
  const centreGap = length(sub(b.centre, a.centre));
  let size = Math.sqrt(Math.max(a.area, b.area));
  if (a.radius !== null) {
    size = a.radius;
  }
  return centreGap < Math.max(0.5, 0.05 * size);
}

export function attachFaces(input: AttachInput): AttachFace[] {
  const facets = hullFacets(input);
  const discs = featureDiscs(input);
  const result: AttachFace[] = facets.slice();
  for (let i = 0; i < discs.length; i++) {
    const disc = discs[i];
    let merged = false;
    for (let k = 0; k < result.length; k++) {
      if (sameCandidate(result[k], disc)) {
        // Keep the exact circle of the feature; it is where parts join.
        if (result[k].source === 'hull') {
          result[k] = {
            normal: result[k].normal,
            centre: disc.centre,
            outline: disc.outline,
            area: disc.area,
            radius: disc.radius,
            longDirection: result[k].longDirection,
            source: 'both',
          };
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      result.push(disc);
    }
  }
  result.sort(function byArea(p, q) {
    return q.area - p.area;
  });
  if (result.length > maxCandidates) {
    result.length = maxCandidates;
  }
  return result;
}

// The first guess at which candidate a part is joined by, before the user
// picks one with place on face:
//   - the largest circular candidate, if there is one (a section joins by an
//     end disc);
//   - otherwise, for a plate (a fin), the candidate at right angles to the
//     largest one with the longest outline: the root edge;
//   - otherwise the largest candidate.
export function guessAttachFace(candidates: AttachFace[]): number {
  if (candidates.length === 0) {
    return -1;
  }
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].radius !== null) {
      return i;
    }
  }
  const largest = candidates[0];
  let best = -1;
  let bestLength = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (Math.abs(dot(candidates[i].normal, largest.normal)) > 0.1) {
      continue;
    }
    const extent = outlineExtent(candidates[i]);
    if (extent > bestLength) {
      bestLength = extent;
      best = i;
    }
  }
  if (best >= 0) {
    return best;
  }
  return 0;
}

function outlineExtent(candidate: AttachFace): number {
  let best = 0;
  for (let i = 0; i < candidate.outline.length; i++) {
    for (let k = i + 1; k < candidate.outline.length; k++) {
      best = Math.max(best, length(sub(candidate.outline[k], candidate.outline[i])));
    }
  }
  return best;
}
