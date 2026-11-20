// Replacing a part with a revised STEP file (brief v1 4.7): the parts made
// from the old file keep their places in the assembly (pose, parent,
// children, symmetry) and take the new geometry; each decal stuck on them
// goes to the point of the new surface nearest its old anchor.
//
// A decal remembers its anchor as a world position and outward normal
// (refreshed on every edit). On the new surface it goes to the nearest
// point whose normal agrees (so a decal on one side of a fin stays on that
// side), turned to keep its old direction as near as the new surface
// allows. Any decal that moved more than `checkDistance`, or found nothing
// within `searchDistance`, is reported for the user to look at; none is
// dropped (one with nothing near goes to the nearest point there is).

import type { Part } from '../geometry/part.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import { dot, length, sub } from '../geometry/vec3.ts';
import type { Surface } from '../geometry/geodesic.ts';
import { nearestOnSurface, pieceIndex } from '../geometry/geodesic.ts';
import { anchorOf, defaultRight, frameAt, frameOf, rotateInPlane } from '../geometry/decal-map.ts';
import type { AssemblyDocument } from './document.ts';
import { cloneDocument } from './document.ts';

export const checkDistance = 2;
export const searchDistance = 10;
// How far to look before giving up altogether (mm).
const lastResortDistance = 2000;

export interface ReattachReport {
  decalId: string;
  name: string;
  // How far the anchor moved, mm.
  distance: number;
  // False when nothing agreeing was within searchDistance.
  foundNear: boolean;
}

// The attach face of `newPart` that matches face `index` of `oldPart`:
// the one facing the same way (normals within about 25 degrees) nearest
// the old face's centre, in the part's own frame; failing that, the one
// facing most nearly the same way.
export function matchingFace(oldPart: Part, newPart: Part, index: number): number {
  if (index < 0 || index >= oldPart.attachFaces.length || newPart.attachFaces.length === 0) {
    return newPart.attachFaces.length > 0 ? 0 : -1;
  }
  const old = oldPart.attachFaces[index];
  let best = -1;
  let bestDistance = Infinity;
  let bestFacing = -1;
  let mostFacing = -Infinity;
  for (let f = 0; f < newPart.attachFaces.length; f++) {
    const face = newPart.attachFaces[f];
    const facing = dot(face.normal, old.normal);
    if (facing > mostFacing) {
      mostFacing = facing;
      bestFacing = f;
    }
    if (facing < 0.9) {
      continue;
    }
    const apart = length(sub(face.centre, old.centre));
    if (apart < bestDistance) {
      bestDistance = apart;
      best = f;
    }
  }
  if (best >= 0) {
    return best;
  }
  return bestFacing;
}

// Every placed part made from `oldPartId` now uses `newPartId`; joints
// that name attach faces of the old part name the matching faces of the
// new one.
export function swapPart(doc: AssemblyDocument, oldPartId: string, newPartId: string, oldPart: Part, newPart: Part): AssemblyDocument {
  const next = cloneDocument(doc);
  const swapped = new Set<string>();
  for (let i = 0; i < next.placed.length; i++) {
    const placed = next.placed[i];
    if (placed.partId !== oldPartId) {
      continue;
    }
    placed.partId = newPartId;
    swapped.add(placed.id);
    if (placed.joint !== null) {
      placed.joint.ownFace = matchingFace(oldPart, newPart, placed.joint.ownFace);
    }
  }
  for (let i = 0; i < next.placed.length; i++) {
    const placed = next.placed[i];
    if (placed.parentId !== null && swapped.has(placed.parentId) && placed.joint !== null && placed.joint.parentFace !== null) {
      placed.joint.parentFace = matchingFace(oldPart, newPart, placed.joint.parentFace);
    }
  }
  const chosen = next.attachFaceByPart[oldPartId];
  if (chosen !== undefined) {
    next.attachFaceByPart[newPartId] = matchingFace(oldPart, newPart, chosen);
  }
  return next;
}

// Put each decal stuck on one of `placedIds` onto the new surface (see
// the header). `oldSurface` is the surface the decals were on.
export function reattachDecals(doc: AssemblyDocument, oldSurface: Surface, newSurface: Surface, placedIds: Set<string>): { doc: AssemblyDocument; report: ReattachReport[] } {
  const next = cloneDocument(doc);
  const report: ReattachReport[] = [];
  for (let i = 0; i < next.decals.length; i++) {
    const decal = next.decals[i];
    if (!placedIds.has(decal.anchor.placedId)) {
      continue;
    }
    const piece = pieceIndex(newSurface, decal.anchor.placedId);
    if (piece < 0) {
      continue; // the part is hidden: it has no surface now; the anchor waits
    }
    const position: Vec3 = decal.anchor.position;
    const normal: Vec3 = decal.anchor.normal;
    // The decal's right, from where it was.
    let right = rotateInPlane(defaultRight(normal), normal, decal.rotation);
    const oldFrame = frameOf(oldSurface, decal.anchor, decal.rotation);
    if (oldFrame !== null) {
      right = oldFrame.right;
    }
    let foundNear = true;
    let found = nearestOnSurface(newSurface, position, normal, searchDistance, [piece]);
    if (found === null) {
      foundNear = false;
      found = nearestOnSurface(newSurface, position, normal, lastResortDistance, [piece]);
    }
    if (found === null) {
      found = nearestOnSurface(newSurface, position, null, lastResortDistance, [piece]);
    }
    if (found === null) {
      report.push({ decalId: decal.id, name: decal.name, distance: Infinity, foundNear: false });
      continue;
    }
    let frame = frameAt(newSurface, found.at, right);
    if (frame === null) {
      // The old right is along the new normal: take the default direction.
      frame = frameAt(newSurface, found.at, defaultRight(normal));
      if (frame === null) {
        report.push({ decalId: decal.id, name: decal.name, distance: found.distance, foundNear: foundNear });
        continue;
      }
    }
    const stored = anchorOf(newSurface, frame);
    decal.anchor = stored.anchor;
    decal.rotation = stored.rotation;
    if (!foundNear || found.distance > checkDistance) {
      report.push({ decalId: decal.id, name: decal.name, distance: found.distance, foundNear: foundNear });
    }
  }
  return { doc: next, report: report };
}
