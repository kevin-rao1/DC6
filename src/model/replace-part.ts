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
import { dot, length, scale, sub } from '../geometry/vec3.ts';
import type { Quat, RigidTransform } from '../geometry/transform.ts';
import { applyToDirection, applyToPoint, compose, quatFromUnitVectors, rotateVector } from '../geometry/transform.ts';
import type { Surface } from '../geometry/geodesic.ts';
import { nearestOnSurface, pieceIndex } from '../geometry/geodesic.ts';
import { anchorOf, defaultRight, frameAt, frameOf, rotateInPlane } from '../geometry/decal-map.ts';
import type { AssemblyDocument } from './document.ts';
import { childrenOf, cloneDocument, moveSubtreeBy } from './document.ts';

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

// The parts hung on a replaced part stay attached where they were on it:
// each moves (with what hangs on it) as the place it was attached at moved.
// A part joined face to face (stacked on an end) moves as the replaced
// part's face moved, from the old face to the matching face of the new
// part: a tube 10 mm longer pushes what is on its far end out by 10 mm,
// and a part that was slid along after it snapped keeps its offset. A part
// standing on the surface (a fin) moves as the nearest surface point to
// its attach face moved, from the old surface to the new. Joints say which
// faces were joined, so stacked parts need no search.
//   `before`: the document before the swap (its joints name old faces);
//   `swapped`: after swapPart; `parts`: every loaded part by id.
export function reseatChildren(
  before: AssemblyDocument,
  swapped: AssemblyDocument,
  oldPartId: string,
  oldPart: Part,
  newPart: Part,
  parts: Map<string, Part>,
  oldSurface: Surface,
  newSurface: Surface,
): { doc: AssemblyDocument; moved: Array<{ placedId: string; distance: number }> } {
  let next = cloneDocument(swapped);
  const moved: Array<{ placedId: string; distance: number }> = [];
  for (let p = 0; p < before.placed.length; p++) {
    const parent = before.placed[p];
    if (parent.partId !== oldPartId) {
      continue;
    }
    const children = childrenOf(before, parent.id);
    for (let c = 0; c < children.length; c++) {
      const child = children[c];
      const joint = child.joint;
      if (joint === null) {
        continue;
      }
      let motion: RigidTransform | null = null;
      if (joint.parentFace !== null) {
        if (joint.parentFace < 0 || joint.parentFace >= oldPart.attachFaces.length) {
          continue;
        }
        const newIndex = matchingFace(oldPart, newPart, joint.parentFace);
        if (newIndex < 0) {
          continue;
        }
        const oldFace = oldPart.attachFaces[joint.parentFace];
        const newFace = newPart.attachFaces[newIndex];
        const oldCentre = applyToPoint(parent.transform, oldFace.centre);
        const newCentre = applyToPoint(parent.transform, newFace.centre);
        const oldNormal = applyToDirection(parent.transform, oldFace.normal);
        const newNormal = applyToDirection(parent.transform, newFace.normal);
        // Turn about the old face centre as the face turned, then slide.
        const turn = rotationAbout(oldCentre, quatFromUnitVectors(oldNormal, newNormal));
        motion = compose({ position: sub(newCentre, oldCentre), rotation: [0, 0, 0, 1] }, turn);
      } else {
        const childPart = parts.get(child.partId);
        if (childPart === undefined || joint.ownFace < 0 || joint.ownFace >= childPart.attachFaces.length) {
          continue;
        }
        const oldPiece = pieceIndex(oldSurface, parent.id);
        const newPiece = pieceIndex(newSurface, parent.id);
        if (oldPiece < 0 || newPiece < 0) {
          continue;
        }
        const ownCentre = applyToPoint(child.transform, childPart.attachFaces[joint.ownFace].centre);
        const inward = scale(applyToDirection(child.transform, childPart.attachFaces[joint.ownFace].normal), -1);
        const was = nearestOnSurface(oldSurface, ownCentre, inward, searchDistance, [oldPiece]);
        const now = nearestOnSurface(newSurface, ownCentre, inward, searchDistance, [newPiece]);
        if (was === null || now === null) {
          continue;
        }
        const wasPoint = applyToPoint(oldSurface.pieces[oldPiece].transform, was.at.point);
        const nowPoint = applyToPoint(newSurface.pieces[newPiece].transform, now.at.point);
        motion = { position: sub(nowPoint, wasPoint), rotation: [0, 0, 0, 1] };
      }
      const distance = length(motion.position);
      if (distance < 1e-9 && Math.abs(motion.rotation[3]) > 1 - 1e-12) {
        continue;
      }
      next = moveSubtreeBy(next, child.id, motion);
      moved.push({ placedId: child.id, distance: distance });
    }
  }
  return { doc: next, moved: moved };
}

// A rotation about a point, as a rigid transform.
function rotationAbout(point: Vec3, rotation: Quat): RigidTransform {
  const turned = rotateVector(rotation, point);
  return { position: sub(point, turned), rotation: rotation };
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
