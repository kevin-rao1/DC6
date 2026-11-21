// Test parts assembled into surfaces the decal map can walk on, the way the
// editor assembles them: a root on the axis, a nose mated onto its fore
// end. World axis X, nose towards -X.

import type { Part } from '../src/geometry/part.ts';
import type { RigidTransform } from '../src/geometry/transform.ts';
import { applyToDirection, applyToPoint, identityTransform } from '../src/geometry/transform.ts';
import type { Vec3 } from '../src/geometry/vec3.ts';
import { mateFaces, placeRoot } from '../src/geometry/mating.ts';
import { buildSurfaceMesh } from '../src/geometry/surface-mesh.ts';
import type { SurfaceMesh } from '../src/geometry/surface-mesh.ts';
import type { Surface } from '../src/geometry/geodesic.ts';
import { makePiece } from '../src/geometry/geodesic.ts';
import { loadPart } from './models.ts';

const meshes = new Map<string, SurfaceMesh>();

export function meshOf(part: Part): SurfaceMesh {
  let mesh = meshes.get(part.id);
  if (mesh === undefined) {
    mesh = buildSurfaceMesh(part);
    meshes.set(part.id, mesh);
  }
  return mesh;
}

export interface Placed {
  id: string;
  part: Part;
  transform: RigidTransform;
}

export function surfaceOf(list: Placed[]): Surface {
  const pieces = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    pieces.push(makePiece(p.id, meshOf(p.part), p.part.bvh, p.part.positions, p.part.indices, p.transform));
  }
  return { pieces: pieces };
}

// An independent intrinsic measure of a developable mesh: lay its triangles
// out flat by unfolding outward from one triangle (breadth first, each new
// triangle placed against an edge already laid down, keeping its edge
// lengths). Within `reach` mm of the start. Returns per-triangle 2D corner
// positions. On a developable tessellation (plane, polyhedral cylinder or
// cone) this is exact, so distances in it are distances in the surface.
export function unfoldMesh(mesh: SurfaceMesh, start: number, reach: number): Map<number, [number, number][]> {
  const layout = new Map<number, [number, number][]>();
  const corner = function corner(t: number, k: number): Vec3 {
    const v = 3 * mesh.triangles[3 * t + k];
    return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
  };
  const a0 = corner(start, 0);
  const b0 = corner(start, 1);
  const c0 = corner(start, 2);
  const ab = Math.hypot(b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]);
  const ac = Math.hypot(c0[0] - a0[0], c0[1] - a0[1], c0[2] - a0[2]);
  const bc = Math.hypot(c0[0] - b0[0], c0[1] - b0[1], c0[2] - b0[2]);
  const cx = (ab * ab + ac * ac - bc * bc) / (2 * ab);
  const cy = Math.sqrt(Math.max(0, ac * ac - cx * cx));
  layout.set(start, [
    [0, 0],
    [ab, 0],
    [cx, cy],
  ]);
  const queue = [start];
  while (queue.length > 0) {
    const t = queue.shift() as number;
    const flat = layout.get(t) as [number, number][];
    for (let e = 0; e < 3; e++) {
      const n = mesh.neighbours[3 * t + e];
      if (n < 0 || layout.has(n)) {
        continue;
      }
      const centre = corner(n, 0);
      if (Math.hypot(centre[0] - a0[0], centre[1] - a0[1], centre[2] - a0[2]) > reach) {
        continue;
      }
      const p = mesh.triangles[3 * t + e];
      const q = mesh.triangles[3 * t + ((e + 1) % 3)];
      // Corners of n: which are p and q, which is new.
      const placed: [number, number][] = [
        [0, 0],
        [0, 0],
        [0, 0],
      ];
      let fresh = -1;
      for (let k = 0; k < 3; k++) {
        const v = mesh.triangles[3 * n + k];
        if (v === p) {
          placed[k] = flat[e];
        } else if (v === q) {
          placed[k] = flat[(e + 1) % 3];
        } else {
          fresh = k;
        }
      }
      const kp = (fresh + 1) % 3;
      const kq = (fresh + 2) % 3;
      const P = placed[kp];
      const Q = placed[kq];
      const p3 = corner(n, kp);
      const q3 = corner(n, kq);
      const r3 = corner(n, fresh);
      const pq = Math.hypot(q3[0] - p3[0], q3[1] - p3[1], q3[2] - p3[2]);
      const pr = Math.hypot(r3[0] - p3[0], r3[1] - p3[1], r3[2] - p3[2]);
      const qr = Math.hypot(r3[0] - q3[0], r3[1] - q3[1], r3[2] - q3[2]);
      const along = (pq * pq + pr * pr - qr * qr) / (2 * pq);
      const across = Math.sqrt(Math.max(0, pr * pr - along * along));
      const ux = (Q[0] - P[0]) / pq;
      const uy = (Q[1] - P[1]) / pq;
      // The new corner goes on the far side of PQ from t's third corner.
      const third = flat[(e + 2) % 3];
      const side = ux * (third[1] - P[1]) - uy * (third[0] - P[0]);
      const sign = side > 0 ? -1 : 1;
      placed[fresh] = [P[0] + ux * along - uy * across * sign, P[1] + uy * along + ux * across * sign];
      layout.set(n, placed);
      queue.push(n);
    }
  }
  return layout;
}

// The attach face of a part with a circular outline of this radius.
export function circularFace(part: Part, radius: number, after: number): number {
  for (let f = 0; f < part.attachFaces.length; f++) {
    const r = part.attachFaces[f].radius;
    if (r !== null && Math.abs(r - radius) < 0.05 && f > after) {
      return f;
    }
  }
  throw new Error('no circular attach face of radius ' + String(radius) + ' on ' + part.name);
}

export function worldFace(placed: Placed, face: number): { centre: Vec3; normal: Vec3 } {
  const f = placed.part.attachFaces[face];
  return { centre: applyToPoint(placed.transform, f.centre), normal: applyToDirection(placed.transform, f.normal) };
}

// A part on the axis, its chosen face aft at the origin.
export async function rootPart(name: string, face: number | null): Promise<Placed> {
  const part = await loadPart(name);
  const index = face === null ? part.guessedAttachFace : face;
  const transform = placeRoot(part.attachFaces[index], identityTransform(), 0);
  return { id: name, part: part, transform: transform };
}

// The tube as root with the nose mated onto its fore end.
export async function tubeAndNose(): Promise<{ tube: Placed; nose: Placed }> {
  const tube = await rootPart('tube', null);
  const nosePart = await loadPart('nose');
  // The tube face whose normal points at the nose (-X).
  let fore = -1;
  for (let f = 0; f < tube.part.attachFaces.length; f++) {
    const face = worldFace(tube, f);
    if (face.normal[0] < -0.99) {
      fore = f;
    }
  }
  if (fore < 0) {
    throw new Error('no fore face on the tube');
  }
  const target = worldFace(tube, fore);
  const base = circularFace(nosePart, 33, -1);
  const transform = mateFaces(nosePart.attachFaces[base], identityTransform(), target.centre, target.normal, 0);
  return { tube: tube, nose: { id: 'nose', part: nosePart, transform: transform } };
}
