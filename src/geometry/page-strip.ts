// The body strip of the flat page: the skin of the rocket seen from the
// side, unrolled round the axis (brief v1 4.3.4, "silhouette strip", turned
// on its side because the rocket lies down).
//
// Which triangles are on the strip is decided from the assembly as it
// stands, with no idea of what each part is:
//   1. The body profile: rays are cast radially in at the axis from outside,
//      round the rocket at every station. At each station the body radius is
//      the median of the radii the rays hit, so a fin (hit by a few rays) or a
//      window (a few rays go through it) does not count. Where fewer than half
//      the rays hit anything there is no body at that station.
//   2. A triangle is skin if a radial ray aimed at a point of it meets
//      nothing before it, for one of a few points spread over it (a long
//      triangle of a tube can have its middle under a fin's root and still
//      be skin along most of its length). It is on the strip if it is skin, its outward normal is
//      mostly radial (so the flat sides of fins, which rays graze, are not),
//      and it lies within radiusTolerance of the body profile (so the rounded
//      tip of a fin, hit first by the rays and facing outward, is not).
//
// Each strip triangle corner goes to the page at
//   x = arc length along the profile from the nose tip (nose left),
//   y = (roll angle - centre roll) * the corner's own distance from the axis.
// Between corners the map is affine (barycentric), so the map and its inverse
// are exact on the mesh, and a triangle keeps its shape wherever the surface
// is a cylinder. The centre roll is the roll angle shown along the middle of
// the strip; the seam is half a turn from it.
//
// Roll angle: measured about the rocket axis from the side facing the
// viewer of the side view (+Z) towards the top (+Y): angle = atan2(y, z).
// So page up is rocket up on the side the user looks at, and the seam
// (angle pi) is on the back.

import type { Vec3 } from './vec3.ts';
import { dot } from './vec3.ts';
import { applyToDirection, applyToPoint } from './transform.ts';
import type { Surface } from './geodesic.ts';
import { raycastSurface } from './geodesic.ts';
import { meshVertex, triangleNormal } from './surface-mesh.ts';
import { AFT_DIRECTION } from './rocket-axis.ts';

// Station spacing and the number of roll angles of the profile rays.
export const profileStep = 0.5;
export const profileAngles = 48;
// How far a strip triangle may lie from the body profile (mm). The same as
// the gap a decal may hop across between parts.
export const radiusTolerance = 1.0;
// A strip triangle's outward normal has at least this radial component.
export const radialNormalMinimum = 0.5;
// How far past each seam edge the strip is shown again (radians of roll).
// The page wraps: the user can work across the seam in this band. It is not
// a full extra turn, so the islands of the fins can sit beside the strip.
export const repeatAngle = Math.PI / 3;

// Distance along the rocket towards the tail, of a world point.
export function stationOf(p: Vec3): number {
  return dot(p, AFT_DIRECTION);
}

// Roll angle of a world point about the axis, in (-pi, pi]; 0 facing the
// side view, pi/2 on top.
export function rollOf(p: Vec3): number {
  return Math.atan2(p[1], p[2]);
}

export function radiusOf(p: Vec3): number {
  return Math.hypot(p[1], p[2]);
}

// The body profile: radius at stations `step` apart, and the arc length
// along the profile measured from the nose tip.
export interface Profile {
  // Station of sample 0 (axial, mm towards the tail).
  start: number;
  step: number;
  // Body radius at each sample; NaN where there is no body.
  radius: Float64Array;
  // Arc length from the nose tip to each sample (page x).
  arc: Float64Array;
  // Station of the nose tip (the strip's first point): page x 0, and the
  // strip's radius there (0 at the point of a nose, the full radius where
  // the strip starts with a plain tube end).
  tip: number;
  tipRadius: number;
}

// Page x (arc length from the nose tip) of an axial station. Linear between
// samples; ahead of the profile it falls straight back to the tip, behind it
// it carries on at one to one.
export function arcAt(profile: Profile, station: number): number {
  const position = (station - profile.start) / profile.step;
  const count = profile.arc.length;
  if (position <= 0) {
    // Between the tip and the first sample: a straight line on the profile.
    const firstRadius = profile.radius[0];
    const along = profile.start - station;
    const span = profile.start - profile.tip;
    if (span <= 1e-12 || !Number.isFinite(firstRadius)) {
      return profile.arc[0] - along;
    }
    const fraction = along / span;
    return profile.arc[0] - fraction * Math.hypot(span, firstRadius - profile.tipRadius);
  }
  if (position >= count - 1) {
    return profile.arc[count - 1] + (station - (profile.start + (count - 1) * profile.step));
  }
  const below = Math.floor(position);
  const fraction = position - below;
  return profile.arc[below] * (1 - fraction) + profile.arc[below + 1] * fraction;
}

// Body radius at a station (nearest sample), NaN where there is none.
export function profileRadiusAt(profile: Profile, station: number): number {
  const index = Math.round((station - profile.start) / profile.step);
  if (index < 0 || index >= profile.radius.length) {
    return NaN;
  }
  return profile.radius[index];
}

function median(values: number[]): number {
  const sorted = values.slice();
  sorted.sort(function ascending(a, b) {
    return a - b;
  });
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// The world extent of the surface along the axis and away from it.
export function surfaceExtent(surface: Surface): { first: number; last: number; reach: number } {
  let first = Infinity;
  let last = -Infinity;
  let reach = 0;
  for (let i = 0; i < surface.pieces.length; i++) {
    const piece = surface.pieces[i];
    const positions = piece.mesh.positions;
    for (let v = 0; v < positions.length / 3; v++) {
      const world = applyToPoint(piece.transform, [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]]);
      const station = stationOf(world);
      first = Math.min(first, station);
      last = Math.max(last, station);
      reach = Math.max(reach, radiusOf(world));
    }
  }
  return { first: first, last: last, reach: reach };
}

// A ray from outside at (station, roll) straight in at the axis: the radius
// of the first surface it meets, or NaN.
function radialHit(surface: Surface, station: number, roll: number, from: number): number {
  const outward: Vec3 = [0, Math.sin(roll), Math.cos(roll)];
  const axisPoint: Vec3 = [AFT_DIRECTION[0] * station, AFT_DIRECTION[1] * station, AFT_DIRECTION[2] * station];
  const origin: Vec3 = [axisPoint[0] + outward[0] * from, axisPoint[1] + outward[1] * from, axisPoint[2] + outward[2] * from];
  const inward: Vec3 = [-outward[0], -outward[1], -outward[2]];
  const hit = raycastSurface(surface, origin, inward);
  if (hit === null || hit.distance > from) {
    return NaN;
  }
  return from - hit.distance;
}

// Step 1: the profile. `tip` is filled in later (buildStrip) from the strip
// triangles; until then it is the first sample.
export function measureProfile(surface: Surface): Profile {
  const extent = surfaceExtent(surface);
  const from = extent.reach + 10;
  const count = Math.max(2, Math.ceil((extent.last - extent.first) / profileStep) + 1);
  const radius = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const station = extent.first + i * profileStep;
    const hits: number[] = [];
    for (let j = 0; j < profileAngles; j++) {
      // Half a step off zero, so no ray runs exactly along a tessellation
      // edge at a round angle.
      const roll = ((j + 0.5) * 2 * Math.PI) / profileAngles;
      const r = radialHit(surface, station, roll, from);
      if (Number.isFinite(r)) {
        hits.push(r);
      }
    }
    if (hits.length * 2 < profileAngles) {
      radius[i] = NaN;
    } else {
      radius[i] = median(hits);
    }
  }
  return { start: extent.first, step: profileStep, radius: radius, arc: new Float64Array(count), tip: extent.first, tipRadius: 0 };
}

// Arc lengths along the profile from the tip. Across a station with no body
// (a gap between parts) the arc goes straight on.
function fillArc(profile: Profile): void {
  const count = profile.radius.length;
  let previousRadius = profile.tipRadius;
  let previousStation = profile.tip;
  let arc = 0;
  for (let i = 0; i < count; i++) {
    const station = profile.start + i * profile.step;
    const r = profile.radius[i];
    const dx = station - previousStation;
    if (station < profile.tip) {
      // Ahead of the tip: negative, straight.
      profile.arc[i] = station - profile.tip;
      continue;
    }
    if (Number.isFinite(r)) {
      arc = arc + Math.hypot(dx, r - previousRadius);
      previousRadius = r;
    } else {
      arc = arc + dx;
    }
    previousStation = station;
    profile.arc[i] = arc;
  }
}

// One strip triangle, with what its corners need for the page.
export interface StripTriangle {
  piece: number;
  triangle: number;
  // Per corner (in the mesh's corner order): world y and z, page x, distance
  // from the axis, roll angle (unwrapped within the triangle, so the three
  // differ by less than half a turn; a corner on the axis takes the angle
  // of the corner furthest out, where it does not matter).
  y: [number, number, number];
  z: [number, number, number];
  x: [number, number, number];
  rho: [number, number, number];
  phi: [number, number, number];
}

export interface Strip {
  profile: Profile;
  triangles: StripTriangle[];
  // "piece:triangle" -> index into triangles.
  index: Map<string, number>;
  // Page x of the strip's last point (the tail).
  length: number;
}

export function triangleKey(piece: number, triangle: number): string {
  return String(piece) + ':' + String(triangle);
}

// Step 2: the strip triangles.
// Points spread over a triangle: its centre, and towards each corner and
// each edge's middle (nine tenths of the way from the centre).
const sampleReach = 0.9;

// Is some point of the triangle the first thing a radial ray from outside meets?
function seenFromOutside(surface: Surface, corners: Vec3[], centre: Vec3, from: number): boolean {
  const samples: Vec3[] = [centre];
  for (let k = 0; k < 3; k++) {
    const corner = corners[k];
    const next = corners[(k + 1) % 3];
    const middle: Vec3 = [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2, (corner[2] + next[2]) / 2];
    const targets = [corner, middle];
    for (let q = 0; q < targets.length; q++) {
      const t = targets[q];
      samples.push([centre[0] + sampleReach * (t[0] - centre[0]), centre[1] + sampleReach * (t[1] - centre[1]), centre[2] + sampleReach * (t[2] - centre[2])]);
    }
  }
  for (let i = 0; i < samples.length; i++) {
    const radius = radiusOf(samples[i]);
    if (radius < 1e-6) {
      continue;
    }
    const hit = radialHit(surface, stationOf(samples[i]), rollOf(samples[i]), from);
    if (Number.isFinite(hit) && hit <= radius + 0.01) {
      return true;
    }
  }
  return false;
}

export function buildStrip(surface: Surface): Strip {
  const profile = measureProfile(surface);
  const extent = surfaceExtent(surface);
  const from = extent.reach + 10;
  const chosen: Array<{ piece: number; triangle: number; corners: Vec3[] }> = [];
  for (let p = 0; p < surface.pieces.length; p++) {
    const piece = surface.pieces[p];
    const mesh = piece.mesh;
    const triangleCount = mesh.triangles.length / 3;
    for (let t = 0; t < triangleCount; t++) {
      const localNormal = triangleNormal(mesh, t);
      if (localNormal[0] === 0 && localNormal[1] === 0 && localNormal[2] === 0) {
        continue;
      }
      const corners: Vec3[] = [];
      for (let k = 0; k < 3; k++) {
        corners.push(applyToPoint(piece.transform, meshVertex(mesh, t, k)));
      }
      const centre: Vec3 = [
        (corners[0][0] + corners[1][0] + corners[2][0]) / 3,
        (corners[0][1] + corners[1][1] + corners[2][1]) / 3,
        (corners[0][2] + corners[1][2] + corners[2][2]) / 3,
      ];
      const centreRadius = radiusOf(centre);
      if (centreRadius < 1e-6) {
        continue;
      }
      const normal = applyToDirection(piece.transform, localNormal);
      const radial = (normal[1] * centre[1] + normal[2] * centre[2]) / centreRadius;
      if (radial < radialNormalMinimum) {
        continue;
      }
      const station = stationOf(centre);
      const bodyRadius = profileRadiusAt(profile, station);
      if (!Number.isFinite(bodyRadius) || Math.abs(centreRadius - bodyRadius) > radiusTolerance) {
        continue;
      }
      if (!seenFromOutside(surface, corners, centre, from)) {
        continue;
      }
      chosen.push({ piece: p, triangle: t, corners: corners });
    }
  }

  // The nose tip: the most forward strip corner.
  let tip = Infinity;
  for (let i = 0; i < chosen.length; i++) {
    for (let k = 0; k < 3; k++) {
      tip = Math.min(tip, stationOf(chosen[i].corners[k]));
    }
  }
  if (!Number.isFinite(tip)) {
    tip = profile.start;
  }
  let tipRadius = Infinity;
  for (let i = 0; i < chosen.length; i++) {
    for (let k = 0; k < 3; k++) {
      if (stationOf(chosen[i].corners[k]) < tip + 0.01) {
        tipRadius = Math.min(tipRadius, radiusOf(chosen[i].corners[k]));
      }
    }
  }
  if (!Number.isFinite(tipRadius)) {
    tipRadius = 0;
  }
  // Where the strip starts with an open end (a plain tube) the profile's own
  // measure of the radius stands: the corners are on the true surface, the
  // rays hit the flat facets a hair inside it.
  for (let i = 0; i < profile.radius.length; i++) {
    if (Number.isFinite(profile.radius[i])) {
      if (Math.abs(profile.radius[i] - tipRadius) < radiusTolerance) {
        tipRadius = profile.radius[i];
      }
      break;
    }
  }
  profile.tip = tip;
  profile.tipRadius = tipRadius;
  fillArc(profile);

  const triangles: StripTriangle[] = [];
  const index = new Map<string, number>();
  let length = 0;
  for (let i = 0; i < chosen.length; i++) {
    const corners = chosen[i].corners;
    const y: [number, number, number] = [corners[0][1], corners[1][1], corners[2][1]];
    const z: [number, number, number] = [corners[0][2], corners[1][2], corners[2][2]];
    const x: [number, number, number] = [0, 0, 0];
    const rho: [number, number, number] = [0, 0, 0];
    const phi: [number, number, number] = [0, 0, 0];
    let outermost = 0;
    for (let k = 0; k < 3; k++) {
      x[k] = arcAt(profile, stationOf(corners[k]));
      rho[k] = radiusOf(corners[k]);
      phi[k] = rollOf(corners[k]);
      length = Math.max(length, x[k]);
      if (rho[k] > rho[outermost]) {
        outermost = k;
      }
    }
    for (let k = 0; k < 3; k++) {
      if (rho[k] < 1e-9) {
        phi[k] = phi[outermost];
        continue;
      }
      phi[k] = nearestTurn(phi[k], phi[outermost]);
    }
    index.set(triangleKey(chosen[i].piece, chosen[i].triangle), triangles.length);
    triangles.push({ piece: chosen[i].piece, triangle: chosen[i].triangle, y: y, z: z, x: x, rho: rho, phi: phi });
  }
  return { profile: profile, triangles: triangles, index: index, length: length };
}

// The angle equal to `angle` plus a whole number of turns that is nearest
// to `near`.
export function nearestTurn(angle: number, near: number): number {
  const turns = Math.round((near - angle) / (2 * Math.PI));
  return angle + turns * 2 * Math.PI;
}

// ---------------------------------------------------------------------------
// The strip on the page for a given centre roll.

// Which band of the page a piece of strip is in: 0 the strip itself (the
// turn between the two seam edges), +1 the repeat above its top edge, -1
// the repeat below its bottom edge.
export type Band = -1 | 0 | 1;

// A piece of one strip triangle on the page: the triangle clipped to one
// band at one wrap. Its page map is the affine map taking the triangle's
// corners to `corners`.
export interface StripPiece {
  strip: number; // index into Strip.triangles
  band: Band;
  // The triangle's corners on the page for this piece (page x, page y).
  corners: Array<[number, number]>;
  // The whole turns added to the triangle's roll angles for this piece.
  turn: number;
  // The piece outline: barycentric points in the triangle, counterclockwise on the page.
  outline: Vec3[];
  // Per outline edge (edge i runs from point i to point i + 1): the cut it
  // lies on (one of cutLines), or -1 for a piece of the triangle's own edge.
  cutEdges: number[];
}

// The four cuts, in order of roll: the outer edge of the repeat below, the
// bottom seam edge, the top seam edge, the outer edge of the repeat above.
export const cutLines = ['repeat-low', 'seam-low', 'seam-high', 'repeat-high'];

// Page position of barycentric point w of strip triangle s, with the
// triangle's roll angles turned by `turn` (a whole number of turns).
export function stripPagePoint(s: StripTriangle, w: Vec3, turn: number, roll: number): [number, number] {
  let x = 0;
  let y = 0;
  for (let k = 0; k < 3; k++) {
    x = x + w[k] * s.x[k];
    y = y + w[k] * (s.phi[k] + turn - roll) * s.rho[k];
  }
  return [x, y];
}

// The true roll angle of barycentric point w (as the corners are unwrapped).
export function stripPointRoll(s: StripTriangle, w: Vec3): number {
  let y = 0;
  let z = 0;
  let unwrapped = 0;
  for (let k = 0; k < 3; k++) {
    y = y + w[k] * s.y[k];
    z = z + w[k] * s.z[k];
    unwrapped = unwrapped + w[k] * s.phi[k];
  }
  if (Math.hypot(y, z) < 1e-12) {
    return unwrapped;
  }
  return nearestTurn(Math.atan2(y, z), unwrapped);
}

// The band an unwrapped roll angle falls in, or null outside all of them.
export function bandOf(angle: number, roll: number): Band | null {
  const offset = angle - roll;
  if (offset < -Math.PI - repeatAngle || offset > Math.PI + repeatAngle) {
    return null;
  }
  if (offset > Math.PI) {
    return 1;
  }
  if (offset <= -Math.PI) {
    return -1;
  }
  return 0;
}

// Signed side of a point (barycentric w in s) of the half-plane through the
// axis at roll angle `cut`: positive past it (larger roll). Linear in w.
function sideOf(s: StripTriangle, w: Vec3, cut: number): number {
  const c = Math.cos(cut);
  const n = Math.sin(cut);
  let value = 0;
  for (let k = 0; k < 3; k++) {
    value = value + w[k] * (s.y[k] * c - s.z[k] * n);
  }
  return value;
}

// Keep the part of a barycentric polygon on one side of a cut (keepAbove:
// the larger-roll side). Sutherland-Hodgman; the new edge along the cut is
// marked as a cut edge.
function clipPolygon(s: StripTriangle, points: Vec3[], cuts: number[], cut: number, line: number, keepAbove: boolean): { points: Vec3[]; cuts: number[] } {
  const sides: number[] = [];
  for (let i = 0; i < points.length; i++) {
    let side = sideOf(s, points[i], cut);
    if (!keepAbove) {
      side = -side;
    }
    sides.push(side);
  }
  const outPoints: Vec3[] = [];
  const outCuts: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const a = points[i];
    const b = points[j];
    const sa = sides[i];
    const sb = sides[j];
    if (sa >= 0) {
      outPoints.push(a);
      // The edge a-b keeps its kind if b is kept too.
      outCuts.push(cuts[i]);
    }
    if ((sa >= 0 && sb < 0) || (sa < 0 && sb >= 0)) {
      const t = sa / (sa - sb);
      const crossing: Vec3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
      if (sa >= 0) {
        // Leaving: the edge from here runs along the cut.
        outPoints.push(crossing);
        outCuts.push(line);
      } else {
        // Entering: the edge from here is the rest of a-b.
        outPoints.push(crossing);
        outCuts.push(cuts[i]);
      }
    }
  }
  return { points: outPoints, cuts: outCuts };
}

function polygonArea(points: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area = area + a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

const cornersInOrder: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const cornersReversed: Vec3[] = [
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0],
];
const noCuts = [-1, -1, -1];

// A strip triangle no cut runs through, as one piece.
function wholePiece(s: StripTriangle, index: number, turn: number, roll: number): StripPiece {
  const corners: Array<[number, number]> = [];
  for (let c = 0; c < 3; c++) {
    corners.push([s.x[c], (s.phi[c] + turn - roll) * s.rho[c]]);
  }
  const middle = (s.phi[0] + s.phi[1] + s.phi[2]) / 3 + turn;
  let band = bandOf(middle, roll);
  if (band === null) {
    band = 0; // cannot happen: the caller checked the triangle is in the window
  }
  const ax = corners[1][0] - corners[0][0];
  const ay = corners[1][1] - corners[0][1];
  const bx = corners[2][0] - corners[0][0];
  const by = corners[2][1] - corners[0][1];
  let outline = cornersInOrder;
  if (ax * by - ay * bx < 0) {
    outline = cornersReversed;
  }
  return { strip: index, band: band, turn: turn, corners: corners, outline: outline, cutEdges: noCuts };
}

// The strip triangle cut into pieces for centre roll `roll`.
export function stripPieces(strip: Strip, roll: number): StripPiece[] {
  const pieces: StripPiece[] = [];
  const low = roll - Math.PI - repeatAngle;
  const high = roll + Math.PI + repeatAngle;
  const seamLow = roll - Math.PI;
  const seamHigh = roll + Math.PI;
  for (let i = 0; i < strip.triangles.length; i++) {
    const s = strip.triangles[i];
    const lowest = Math.min(s.phi[0], s.phi[1], s.phi[2]);
    const highest = Math.max(s.phi[0], s.phi[1], s.phi[2]);
    // The triangle's roll angles, turned by whole turns into the window.
    const firstTurn = Math.ceil((low - highest) / (2 * Math.PI));
    const lastTurn = Math.floor((high - lowest) / (2 * Math.PI));
    for (let k = firstTurn; k <= lastTurn; k++) {
      const turn = k * 2 * Math.PI;
      const a = lowest + turn;
      const b = highest + turn;
      if (b <= low || a >= high) {
        continue;
      }
      const lines = [low, seamLow, seamHigh, high];
      let crossed = false;
      for (let l = 0; l < lines.length; l++) {
        if (a < lines[l] && lines[l] < b) {
          crossed = true;
        }
      }
      if (!crossed) {
        // The usual case: the whole triangle is in one band.
        pieces.push(wholePiece(s, i, turn, roll));
        continue;
      }
      // Cut the triangle at whichever of the four lines run through it.
      // Angles are compared turned back into the triangle's own unwrapping.
      let parts: Array<{ points: Vec3[]; cuts: number[] }> = [
        {
          points: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          cuts: [-1, -1, -1],
        },
      ];
      for (let l = 0; l < lines.length; l++) {
        const line = lines[l];
        if (!(a < line && line < b)) {
          continue;
        }
        const local = line - turn;
        const next: Array<{ points: Vec3[]; cuts: number[] }> = [];
        for (let p = 0; p < parts.length; p++) {
          const above = clipPolygon(s, parts[p].points, parts[p].cuts, local, l, true);
          const below = clipPolygon(s, parts[p].points, parts[p].cuts, local, l, false);
          if (above.points.length >= 3) {
            next.push(above);
          }
          if (below.points.length >= 3) {
            next.push(below);
          }
        }
        parts = next;
      }
      const corners: Array<[number, number]> = [];
      for (let c = 0; c < 3; c++) {
        const w: Vec3 = [0, 0, 0];
        w[c] = 1;
        corners.push(stripPagePoint(s, w, turn, roll));
      }
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        // Which band: from the part's middle.
        let mid: Vec3 = [0, 0, 0];
        for (let q = 0; q < part.points.length; q++) {
          mid = [mid[0] + part.points[q][0], mid[1] + part.points[q][1], mid[2] + part.points[q][2]];
        }
        mid = [mid[0] / part.points.length, mid[1] / part.points.length, mid[2] / part.points.length];
        const band = bandOf(stripPointRoll(s, mid) + turn, roll);
        if (band === null) {
          continue;
        }
        const page: Array<[number, number]> = [];
        for (let q = 0; q < part.points.length; q++) {
          page.push(stripPagePoint(s, part.points[q], turn, roll));
        }
        let outline = part.points;
        let cutEdges = part.cuts;
        if (polygonArea(page) < 0) {
          // Counterclockwise on the page: reverse (edge i becomes the edge
          // from the old point i + 1 back to i).
          outline = [];
          cutEdges = [];
          const n = part.points.length;
          for (let q = n - 1; q >= 0; q--) {
            outline.push(part.points[q]);
            cutEdges.push(part.cuts[(q - 1 + n) % n]);
          }
        }
        pieces.push({ strip: i, band: band, turn: turn, corners: corners, outline: outline, cutEdges: cutEdges });
      }
    }
  }
  return pieces;
}

// Every place a point of a strip triangle shows on the page: its page
// position in each band it falls in (one, or two near a seam).
export function stripImages(strip: Strip, stripIndex: number, w: Vec3, roll: number): Array<{ x: number; y: number; band: Band; turn: number }> {
  const s = strip.triangles[stripIndex];
  const angle = stripPointRoll(s, w);
  const result: Array<{ x: number; y: number; band: Band; turn: number }> = [];
  const low = roll - Math.PI - repeatAngle;
  const high = roll + Math.PI + repeatAngle;
  const firstTurn = Math.ceil((low - angle) / (2 * Math.PI));
  const lastTurn = Math.floor((high - angle) / (2 * Math.PI));
  for (let k = firstTurn; k <= lastTurn; k++) {
    const turn = k * 2 * Math.PI;
    const band = bandOf(angle + turn, roll);
    if (band === null) {
      continue;
    }
    const page = stripPagePoint(s, w, turn, roll);
    result.push({ x: page[0], y: page[1], band: band, turn: turn });
  }
  return result;
}

// The page position of a strip point with its roll angle unwrapped near
// `near`: used to carry a decal across the seam as one continuous piece.
export function stripPointNear(strip: Strip, stripIndex: number, w: Vec3, near: number, roll: number): { x: number; y: number; angle: number } {
  const s = strip.triangles[stripIndex];
  const angle = stripPointRoll(s, w);
  const unwrapped = nearestTurn(angle, near);
  const turn = unwrapped - angle;
  const page = stripPagePoint(s, w, turn, roll);
  return { x: page[0], y: page[1], angle: unwrapped };
}
