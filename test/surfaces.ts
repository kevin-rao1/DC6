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
