// The forward map from a flat decal to the surface: what laying a flat
// sticker on the rocket does.
//
// A regular grid is laid over the decal (decal frame: X to the right of the
// artwork, Y up, origin at its centre). From the anchor, a geodesic walk
// along the decal's long axis places the spine of the grid; from each spine
// point, walks at right angles to the spine place the rest of that grid
// line (Fermi coordinates). On a plane, cylinder or cone this lays the flat
// grid down without stretching (exactly, on the tessellated surface): a
// 20 mm circle is 20 mm across in every direction. On a doubly curved
// surface it is "apply from the middle outward along the long axis": lengths
// along the spine and along each cross line are exact, and the cross lines
// spread or bunch a little away from the spine as the curvature asks.
//
// Because it maps decal to surface, a band longer than the circumference
// simply goes round and overlaps itself.

import type { Vec3 } from './vec3.ts';
import { add, cross, dot, length, normalize, scale, sub } from './vec3.ts';
import { applyToDirection, applyToPoint } from './transform.ts';
import type { Surface, SurfacePoint, Walker } from './geodesic.ts';
import { cloneWalker, creaseAngle, pieceIndex, startWalk, walk, worldDirection, worldNormal, worldPoint } from './geodesic.ts';
import { barycentricOf, pointFromBarycentric, smoothNormal, triangleNormal } from './surface-mesh.ts';
import { WORLD_UP } from './rocket-axis.ts';

// Where a decal is stuck on: a placed part, a triangle of it, the point in
// that triangle. The world position and normal are kept as well, for
// re-attaching the decal when a part is replaced by a revised file.
export interface SurfaceAnchor {
  placedId: string;
  triangle: number;
  barycentric: Vec3;
  position: Vec3;
  normal: Vec3;
}

// The decal's frame on the surface: its anchor point and the world
// direction of the artwork's right (+X), in the anchor triangle's plane.
export interface DecalFrame {
  at: SurfacePoint;
  right: Vec3;
}

// Grid cells: about 1 mm, coarser for big decals so a decal never has more
// than about maxGridPoints points.
export const gridCell = 1;
const maxGridPoints = 40000;

export function cellSizeFor(width: number, height: number, fine: boolean): number {
  let cell = Math.max(gridCell, Math.sqrt((width * height) / maxGridPoints));
  if (!fine) {
    // While dragging: a quarter of the points.
    cell = cell * 2;
  }
  return cell;
}

export interface DecalGrid {
  // Grid points: columns along X (right), rows along Y (up). Point (i, j) is
  // number j * columns + i.
  columns: number;
  rows: number;
  xs: number[];
  ys: number[];
  // World positions and smooth outward normals; meaningful where present.
  positions: Float64Array;
  normals: Float64Array;
  present: Uint8Array;
}

// Rotate v (perpendicular to unit n) by angle about n.
export function rotateInPlane(v: Vec3, n: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(scale(v, c), scale(cross(n, v), s));
}

// Signed angle from a to b about n (both perpendicular to n).
export function angleInPlane(a: Vec3, b: Vec3, n: Vec3): number {
  const sine = dot(cross(a, b), n);
  const cosine = dot(a, b);
  return Math.atan2(sine, cosine);
}

// Fins and the body: the direction of the artwork's "up" a new decal gets.
// Artwork up is world up as seen on the surface, so lettering on the side of
// the rocket (lying nose left) reads left to right and upright, and on a fin
// it reads upright seen from outside. On a surface facing straight up or
// down (within 10 degrees) world up says nothing; there "up" is away from
// the viewer of the side view on top (as the top view shows it) and towards
// them underneath.
export function defaultUp(normal: Vec3): Vec3 {
  const up = sub(WORLD_UP, scale(normal, dot(WORLD_UP, normal)));
  if (length(up) > Math.sin((10 * Math.PI) / 180)) {
    return normalize(up);
  }
  // World "side" (towards the viewer of the side view) is +Z.
  let reference: Vec3 = [0, 0, -1];
  if (dot(normal, WORLD_UP) < 0) {
    reference = [0, 0, 1];
  }
  return normalize(sub(reference, scale(normal, dot(reference, normal))));
}

export function defaultRight(normal: Vec3): Vec3 {
  return normalize(cross(defaultUp(normal), normal));
}

// The frame of a stored decal: its anchor and rotation.
export function frameOf(surface: Surface, anchor: SurfaceAnchor, rotation: number): DecalFrame | null {
  const piece = pieceIndex(surface, anchor.placedId);
  if (piece < 0) {
    return null; // the part is hidden or gone
  }
  const mesh = surface.pieces[piece].mesh;
  if (anchor.triangle >= mesh.triangles.length / 3) {
    return null;
  }
  const point = pointFromBarycentric(mesh, anchor.triangle, anchor.barycentric);
  const at: SurfacePoint = { piece: piece, triangle: anchor.triangle, point: point };
  const normal = worldNormal(surface, at);
  if (length(normal) === 0) {
    return null;
  }
  const right = rotateInPlane(defaultRight(normal), normal, rotation);
  return { at: at, right: right };
}

// The anchor and rotation that store a frame.
export function anchorOf(surface: Surface, frame: DecalFrame): { anchor: SurfaceAnchor; rotation: number } {
  const piece = surface.pieces[frame.at.piece];
  const normal = worldNormal(surface, frame.at);
  const barycentric = barycentricOf(piece.mesh, frame.at.triangle, frame.at.point);
  const rotation = angleInPlane(defaultRight(normal), frame.right, normal);
  const anchor: SurfaceAnchor = {
    placedId: piece.placedId,
    triangle: frame.at.triangle,
    barycentric: barycentric,
    position: worldPoint(surface, frame.at),
    normal: normal,
  };
  return { anchor: anchor, rotation: rotation };
}

// A frame at a surface point with the given right direction (projected into
// the triangle's plane), or null if that direction is along the normal.
export function frameAt(surface: Surface, at: SurfacePoint, right: Vec3): DecalFrame | null {
  const normal = worldNormal(surface, at);
  const inPlane = sub(right, scale(normal, dot(right, normal)));
  if (length(inPlane) < 1e-6) {
    return null;
  }
  return { at: at, right: normalize(inPlane) };
}

export function upOf(surface: Surface, frame: DecalFrame): Vec3 {
  return cross(worldNormal(surface, frame.at), frame.right);
}

// Walk from a frame by (dx along its right, dy along its up) and carry the
// frame with it (parallel transport along the geodesic: the angle between
// the frame and the direction of travel stays the same). Null if the
// surface ends on the way.
export function walkFrame(surface: Surface, frame: DecalFrame, dx: number, dy: number): DecalFrame | null {
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) {
    return { at: frame.at, right: frame.right };
  }
  const normal = worldNormal(surface, frame.at);
  const up = cross(normal, frame.right);
  const heading = normalize(add(scale(frame.right, dx), scale(up, dy)));
  const walker = startWalk(surface, frame.at, heading);
  if (walker === null) {
    return null;
  }
  // Angle from the direction of travel to the frame's right.
  const offset = angleInPlane(heading, frame.right, normal);
  walk(surface, walker, distance);
  if (!walker.alive) {
    return null;
  }
  const endNormal = worldNormal(surface, walker);
  const endHeading = worldDirection(surface, walker);
  const right = rotateInPlane(endHeading, endNormal, offset);
  return { at: { piece: walker.piece, triangle: walker.triangle, point: walker.point }, right: right };
}

// Carry the decal's frame at the cursor from where it was to the surface
// point now under the cursor: walk along the surface towards it (so the
// frame is carried by the same geodesic rules as the map, across joints),
// then step onto the point under the cursor, projecting the frame onto its
// tangent plane. If the point under the cursor turns sharply away from where
// the walk arrived (the cursor is over the crack between two parts and the
// ray found an end face, or over a fin standing on the body), the walk's
// end stands instead: the decal goes no further than the surface allows.
export function followCursor(surface: Surface, from: DecalFrame, target: SurfacePoint): DecalFrame | null {
  const start = worldPoint(surface, from.at);
  const normal = worldNormal(surface, from.at);
  const chord = sub(worldPoint(surface, target), start);
  const inPlane = sub(chord, scale(normal, dot(chord, normal)));
  let arrived: DecalFrame = from;
  const distance = length(inPlane);
  if (distance > 1e-6) {
    const direction = scale(inPlane, 1 / distance);
    const up = cross(normal, from.right);
    const walked = walkFrame(surface, from, distance * dot(direction, from.right), distance * dot(direction, up));
    if (walked !== null) {
      arrived = walked;
    }
  }
  const arrivedNormal = worldNormal(surface, arrived.at);
  const targetNormal = worldNormal(surface, target);
  const turn = Math.acos(Math.max(-1, Math.min(1, dot(arrivedNormal, targetNormal))));
  if (turn >= creaseAngle) {
    return arrived;
  }
  const onTarget = frameAt(surface, target, arrived.right);
  if (onTarget === null) {
    return arrived;
  }
  return onTarget;
}

// Evenly spaced coordinates from -half to +half with an even number of
// cells, so 0 (the spine and the anchor's cross line) is a grid line.
function gridCoordinates(size: number, cell: number): number[] {
  let cells = 2 * Math.ceil(size / (2 * cell));
  if (cells < 2) {
    cells = 2;
  }
  const result: number[] = [];
  for (let i = 0; i <= cells; i++) {
    result.push(-size / 2 + (size * i) / cells);
  }
  return result;
}

// The walker's state at each of `stops` (signed distances along its
// direction, the zero stop first, then ascending positive ones, then
// descending negative ones handled by the caller): records a copy at every
// stop, or null where the surface had ended.
function walkStops(surface: Surface, start: Walker, stops: number[]): Array<Walker | null> {
  const result: Array<Walker | null> = [];
  const walker = cloneWalker(start);
  let travelled = 0;
  for (let i = 0; i < stops.length; i++) {
    walk(surface, walker, stops[i] - travelled);
    travelled = stops[i];
    if (!walker.alive) {
      result.push(null);
    } else {
      result.push(cloneWalker(walker));
    }
  }
  return result;
}

// The state at every coordinate in `coordinates` (which contains 0) along a
// line through `centre`, heading `direction` (world) for positive values and
// the opposite way for negative ones. The walker returned at a negative
// coordinate heads in the negative direction.
function walkLine(surface: Surface, centre: SurfacePoint, direction: Vec3, coordinates: number[]): Array<Walker | null> {
  const result: Array<Walker | null> = [];
  for (let i = 0; i < coordinates.length; i++) {
    result.push(null);
  }
  const forward = startWalk(surface, centre, direction);
  const backward = startWalk(surface, centre, scale(direction, -1));
  if (forward === null || backward === null) {
    return result;
  }
  const positive: number[] = [];
  const positiveIndex: number[] = [];
  const negative: number[] = [];
  const negativeIndex: number[] = [];
  for (let i = 0; i < coordinates.length; i++) {
    if (coordinates[i] >= 0) {
      positive.push(coordinates[i]);
      positiveIndex.push(i);
    }
  }
  for (let i = coordinates.length - 1; i >= 0; i--) {
    if (coordinates[i] < 0) {
      negative.push(-coordinates[i]);
      negativeIndex.push(i);
    }
  }
  const ahead = walkStops(surface, forward, positive);
  for (let k = 0; k < ahead.length; k++) {
    result[positiveIndex[k]] = ahead[k];
  }
  const behind = walkStops(surface, backward, negative);
  for (let k = 0; k < behind.length; k++) {
    result[negativeIndex[k]] = behind[k];
  }
  return result;
}

// Lay the decal's grid on the surface.
export function mapDecal(surface: Surface, frame: DecalFrame, width: number, height: number, cell: number): DecalGrid {
  if (!(width > 0) || !(height > 0)) {
    throw new Error('mapDecal: width and height must be positive, got ' + String(width) + ' x ' + String(height));
  }
  const xs = gridCoordinates(width, cell);
  const ys = gridCoordinates(height, cell);
  const columns = xs.length;
  const rows = ys.length;
  const count = columns * rows;
  const positions = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  const present = new Uint8Array(count);

  const normal = worldNormal(surface, frame.at);
  const up = cross(normal, frame.right);
  // The spine runs along the long side.
  const spineAlongX = width >= height;
  let spineDirection = frame.right;
  let spineCoordinates = xs;
  let crossCoordinates = ys;
  if (!spineAlongX) {
    spineDirection = up;
    spineCoordinates = ys;
    crossCoordinates = xs;
  }
  const spine = walkLine(surface, frame.at, spineDirection, spineCoordinates);

  for (let s = 0; s < spineCoordinates.length; s++) {
    const state = spine[s];
    if (state === null) {
      continue;
    }
    // The spine's own direction at this point, pointing along +spine.
    const piece = surface.pieces[state.piece];
    const localNormal = triangleNormal(piece.mesh, state.triangle);
    let tangent = state.direction;
    if (spineCoordinates[s] < 0) {
      tangent = scale(tangent, -1);
    }
    // Cross direction: up when the spine is X (n x right), right when the
    // spine is Y (up x n). Both keep the frame right-handed.
    let crossLocal = cross(localNormal, tangent);
    if (!spineAlongX) {
      crossLocal = cross(tangent, localNormal);
    }
    const crossWorld = applyToDirection(piece.transform, crossLocal);
    const line = walkLine(surface, state, crossWorld, crossCoordinates);
    for (let c = 0; c < crossCoordinates.length; c++) {
      const point = line[c];
      if (point === null) {
        continue;
      }
      let column = s;
      let row = c;
      if (!spineAlongX) {
        column = c;
        row = s;
      }
      const index = row * columns + column;
      const target = surface.pieces[point.piece];
      const world = applyToPoint(target.transform, point.point);
      const smooth = applyToDirection(target.transform, smoothNormal(target.mesh, point.triangle, point.point));
      positions[3 * index] = world[0];
      positions[3 * index + 1] = world[1];
      positions[3 * index + 2] = world[2];
      normals[3 * index] = smooth[0];
      normals[3 * index + 1] = smooth[1];
      normals[3 * index + 2] = smooth[2];
      present[index] = 1;
    }
  }
  return { columns: columns, rows: rows, xs: xs, ys: ys, positions: positions, normals: normals, present: present };
}

export function gridPoint(grid: DecalGrid, column: number, row: number): Vec3 | null {
  const index = row * grid.columns + column;
  if (grid.present[index] === 0) {
    return null;
  }
  return [grid.positions[3 * index], grid.positions[3 * index + 1], grid.positions[3 * index + 2]];
}

export function gridNormal(grid: DecalGrid, column: number, row: number): Vec3 {
  const index = row * grid.columns + column;
  return [grid.normals[3 * index], grid.normals[3 * index + 1], grid.normals[3 * index + 2]];
}
