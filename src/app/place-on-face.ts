// Place on face, as the slicers' "lay on face" does it but for joining
// parts: the user clicks one of the selected part's offered faces, then a
// face (or a point on the surface) of another part, and the selected part is
// brought there, centred, faces touching. For the root there is no second
// click: the face clicked becomes its aft face, centred on the rocket axis.
//
// Each function returns the new document; the editor commits it.

import type { Vec3 } from '../geometry/vec3.ts';
import { dot, scale, sub, add } from '../geometry/vec3.ts';
import type { RigidTransform } from '../geometry/transform.ts';
import { applyToPoint } from '../geometry/transform.ts';
import { attachToSurface, mateFaces, placeRoot } from '../geometry/mating.ts';
import { NOSE_DIRECTION } from '../geometry/rocket-axis.ts';
import type { AssemblyDocument, Joint } from '../model/document.ts';
import { movePart, rememberAttachFace, requirePlaced, symmetryMembers } from '../model/document.ts';
import type { PartLibrary } from './picking.ts';
import { partCentre, requirePart, worldFace } from './picking.ts';

// Move a pose along the rocket axis so that the given local point keeps the
// station (position along the axis) it has under `before`.
export function keepStation(pose: RigidTransform, before: RigidTransform, localPoint: Vec3): RigidTransform {
  const was = applyToPoint(before, localPoint);
  const now = applyToPoint(pose, localPoint);
  const along = dot(sub(was, now), NOSE_DIRECTION);
  const shift = scale(NOSE_DIRECTION, along);
  return { position: add(pose.position, shift), rotation: pose.rotation };
}

// The root: the clicked face becomes the aft-facing face, centred on the
// axis. The part stays where it was along the axis (its middle keeps its
// station), as a slicer leaves an object where it was on the bed.
export function rootOnFace(doc: AssemblyDocument, parts: PartLibrary, rootId: string, face: number): AssemblyDocument {
  const root = requirePlaced(doc, rootId);
  const part = requirePart(parts, root.partId);
  const placed = placeRoot(part.attachFaces[face], root.transform, 0);
  const pose = keepStation(placed, root.transform, partCentre(part));
  const moved = movePart(doc, rootId, pose);
  return rememberAttachFace(moved, root.partId, face);
}

// Make the selected part (and its symmetry set) a child of `parentId` with
// `joint`, at `pose`.
function attachSelected(doc: AssemblyDocument, selectedId: string, pose: RigidTransform, parentId: string, joint: Joint): AssemblyDocument {
  const selected = requirePlaced(doc, selectedId);
  const next = movePart(doc, selectedId, pose);
  const members = symmetryMembers(next, selectedId);
  for (let m = 0; m < members.length; m++) {
    members[m].parentId = parentId;
    members[m].joint = { ownFace: joint.ownFace, parentFace: joint.parentFace };
  }
  return rememberAttachFace(next, selected.partId, joint.ownFace);
}

// Face onto face: centres together, normals opposed.
export function faceOnFace(doc: AssemblyDocument, parts: PartLibrary, selectedId: string, ownFace: number, targetId: string, targetFace: number): AssemblyDocument {
  const selected = requirePlaced(doc, selectedId);
  const part = requirePart(parts, selected.partId);
  const target = worldFace(parts, requirePlaced(doc, targetId), targetFace);
  const pose = mateFaces(part.attachFaces[ownFace], selected.transform, target.centre, target.normal, 0);
  return attachSelected(doc, selectedId, pose, targetId, { ownFace: ownFace, parentFace: targetFace });
}

// Face onto a point of another part's surface (a fin root onto a tube): the
// face stands on the surface there, its long side along the rocket axis.
export function faceOnSurface(doc: AssemblyDocument, parts: PartLibrary, selectedId: string, ownFace: number, targetId: string, point: Vec3, normal: Vec3): AssemblyDocument {
  const selected = requirePlaced(doc, selectedId);
  const part = requirePart(parts, selected.partId);
  const pose = attachToSurface(part.attachFaces[ownFace], partCentre(part), selected.transform, point, normal, 0);
  return attachSelected(doc, selectedId, pose, targetId, { ownFace: ownFace, parentFace: null });
}
