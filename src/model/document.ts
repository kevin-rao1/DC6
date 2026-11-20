// The assembly document: which parts are placed where. Plain data, so it can
// be snapshotted for undo and, in a later stage, saved as the project file.
//
// Transforms are world transforms (part frame -> world). The tree (parentId)
// says what moves with what: moving a part moves its descendants by the same
// rigid motion. Every operation here returns a new document and leaves its
// input untouched.

import type { RigidTransform } from '../geometry/transform.ts';
import { cloneTransform, compose, invert } from '../geometry/transform.ts';
import { aboutAxis } from '../geometry/mating.ts';
import type { Decal } from './decals.ts';

export interface Joint {
  // Attach face of this part that is joined (index into Part.attachFaces).
  ownFace: number;
  // Attach face of the parent it is joined to, or null when this part is
  // attached to the parent's surface (a fin on a tube).
  parentFace: number | null;
}

export interface SymmetryLink {
  // Members of one radial set share the group id.
  group: string;
  // This member's place in the set: it is member 0 turned by index/count of a
  // turn about the rocket axis.
  index: number;
  count: number;
}

export interface PlacedPart {
  id: string;
  // Part.id of the source part (file name and solid number).
  partId: string;
  transform: RigidTransform;
  parentId: string | null;
  joint: Joint | null;
  symmetry: SymmetryLink | null;
  hidden: boolean;
}

export interface AssemblyDocument {
  placed: PlacedPart[];
  // The first part dropped. It sits on the axis with its aft face at the origin.
  rootId: string | null;
  // The attach face the user chose for each source part (Part.id -> index).
  attachFaceByPart: Record<string, number>;
  // Counter for new ids, so ids are never reused (undo depends on that).
  nextId: number;
  // Decals, bottom layer first (see decals.ts).
  decals: Decal[];
  // Vinyl colours the user added to the two presets.
  vinylColours: string[];
  // Preview colour of placed parts (placed id -> '#rrggbb'); unlisted parts
  // are shown in the plain part grey.
  partColours: Record<string, string>;
}

export function emptyDocument(): AssemblyDocument {
  return { placed: [], rootId: null, attachFaceByPart: {}, nextId: 1, decals: [], vinylColours: [], partColours: {} };
}

export function cloneDocument(doc: AssemblyDocument): AssemblyDocument {
  // The document is plain JSON-able data; a JSON round trip is the plainest deep copy.
  return JSON.parse(JSON.stringify(doc)) as AssemblyDocument;
}

export function findPlaced(doc: AssemblyDocument, id: string): PlacedPart | null {
  for (let i = 0; i < doc.placed.length; i++) {
    if (doc.placed[i].id === id) {
      return doc.placed[i];
    }
  }
  return null;
}

export function requirePlaced(doc: AssemblyDocument, id: string): PlacedPart {
  const placed = findPlaced(doc, id);
  if (placed === null) {
    throw new Error('expected a placed part with id ' + id);
  }
  return placed;
}

export function childrenOf(doc: AssemblyDocument, id: string): PlacedPart[] {
  const result: PlacedPart[] = [];
  for (let i = 0; i < doc.placed.length; i++) {
    if (doc.placed[i].parentId === id) {
      result.push(doc.placed[i]);
    }
  }
  return result;
}

// The part and everything below it, parent before child.
export function subtreeIds(doc: AssemblyDocument, id: string): string[] {
  const result: string[] = [id];
  let cursor = 0;
  while (cursor < result.length) {
    const children = childrenOf(doc, result[cursor]);
    for (let i = 0; i < children.length; i++) {
      result.push(children[i].id);
    }
    cursor = cursor + 1;
  }
  return result;
}

// Members of the part's symmetry set, in index order (just the part if none).
export function symmetryMembers(doc: AssemblyDocument, id: string): PlacedPart[] {
  const placed = requirePlaced(doc, id);
  if (placed.symmetry === null) {
    return [placed];
  }
  const group = placed.symmetry.group;
  const members: PlacedPart[] = [];
  for (let i = 0; i < doc.placed.length; i++) {
    const other = doc.placed[i];
    if (other.symmetry !== null && other.symmetry.group === group) {
      members.push(other);
    }
  }
  members.sort(function byIndex(a, b) {
    const ia = a.symmetry === null ? 0 : a.symmetry.index;
    const ib = b.symmetry === null ? 0 : b.symmetry.index;
    return ia - ib;
  });
  return members;
}

export function newId(doc: AssemblyDocument): string {
  const id = 'p' + String(doc.nextId);
  doc.nextId = doc.nextId + 1;
  return id;
}

// Move one part (and its subtree) to a new world transform, without touching
// its symmetry partners.
function moveSubtreeInPlace(doc: AssemblyDocument, id: string, transform: RigidTransform): void {
  const placed = requirePlaced(doc, id);
  // The motion that takes the old pose to the new one: new = motion * old.
  const motion = compose(transform, invert(placed.transform));
  const ids = subtreeIds(doc, id);
  for (let i = 0; i < ids.length; i++) {
    const member = requirePlaced(doc, ids[i]);
    if (member.id === id) {
      member.transform = cloneTransform(transform);
    } else {
      member.transform = compose(motion, member.transform);
    }
  }
}

// Move a part to a new world transform. Its descendants come with it, and its
// symmetry partners take the same pose turned about the axis.
export function movePart(doc: AssemblyDocument, id: string, transform: RigidTransform): AssemblyDocument {
  const next = cloneDocument(doc);
  const placed = requirePlaced(next, id);
  if (placed.symmetry === null) {
    moveSubtreeInPlace(next, id, transform);
    return next;
  }
  const members = symmetryMembers(next, id);
  const count = placed.symmetry.count;
  // Pose of member 0, from which every member follows.
  const backToFirst = aboutAxis((-2 * Math.PI * placed.symmetry.index) / count);
  const firstPose = compose(backToFirst, transform);
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const index = member.symmetry === null ? 0 : member.symmetry.index;
    const pose = compose(aboutAxis((2 * Math.PI * index) / count), firstPose);
    moveSubtreeInPlace(next, member.id, pose);
  }
  return next;
}

// Remove parts and everything below them, and the decals stuck on them.
export function removeParts(doc: AssemblyDocument, ids: string[]): AssemblyDocument {
  const next = cloneDocument(doc);
  const doomed = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const subtree = subtreeIds(next, ids[i]);
    for (let k = 0; k < subtree.length; k++) {
      doomed.add(subtree[k]);
    }
  }
  const kept: PlacedPart[] = [];
  for (let i = 0; i < next.placed.length; i++) {
    if (!doomed.has(next.placed[i].id)) {
      kept.push(next.placed[i]);
    }
  }
  next.placed = kept;
  const keptDecals: Decal[] = [];
  for (let i = 0; i < next.decals.length; i++) {
    if (!doomed.has(next.decals[i].anchor.placedId)) {
      keptDecals.push(next.decals[i]);
    }
  }
  next.decals = keptDecals;
  if (next.rootId !== null && doomed.has(next.rootId)) {
    next.rootId = null;
  }
  return next;
}

// Hide or show a part; its symmetry partners follow.
export function setHidden(doc: AssemblyDocument, id: string, hidden: boolean): AssemblyDocument {
  const next = cloneDocument(doc);
  const members = symmetryMembers(next, id);
  for (let i = 0; i < members.length; i++) {
    members[i].hidden = hidden;
  }
  return next;
}

export function rememberAttachFace(doc: AssemblyDocument, partId: string, face: number): AssemblyDocument {
  const next = cloneDocument(doc);
  next.attachFaceByPart[partId] = face;
  return next;
}

// What a new placement adds: one or more parts (a symmetry set) with their
// poses, attached to a parent (or free).
export interface Placement {
  partId: string;
  transforms: RigidTransform[]; // one per symmetry member; member k is index k
  parentId: string | null;
  joint: Joint | null;
}

// Add parts. With more than one transform they form a linked symmetry set.
// The first part ever placed becomes the root. Returns the new document and
// the ids added.
export function addParts(doc: AssemblyDocument, placement: Placement): { doc: AssemblyDocument; ids: string[] } {
  const next = cloneDocument(doc);
  const ids: string[] = [];
  const count = placement.transforms.length;
  let group: string | null = null;
  if (count > 1) {
    group = 's' + String(next.nextId);
    next.nextId = next.nextId + 1;
  }
  for (let k = 0; k < count; k++) {
    const id = newId(next);
    let symmetry: SymmetryLink | null = null;
    if (group !== null) {
      symmetry = { group: group, index: k, count: count };
    }
    let joint: Joint | null = null;
    if (placement.joint !== null) {
      joint = { ownFace: placement.joint.ownFace, parentFace: placement.joint.parentFace };
    }
    next.placed.push({
      id: id,
      partId: placement.partId,
      transform: cloneTransform(placement.transforms[k]),
      parentId: placement.parentId,
      joint: joint,
      symmetry: symmetry,
      hidden: false,
    });
    ids.push(id);
  }
  if (next.rootId === null && placement.parentId === null && ids.length > 0) {
    next.rootId = ids[0];
  }
  return { doc: next, ids: ids };
}

// Re-attach an existing part (picked up and dropped again): new pose for it
// and its subtree, new parent and joint.
export function reattachPart(
  doc: AssemblyDocument,
  id: string,
  transform: RigidTransform,
  parentId: string | null,
  joint: Joint | null,
): AssemblyDocument {
  const moved = movePart(doc, id, transform);
  const placed = requirePlaced(moved, id);
  placed.parentId = parentId;
  placed.joint = joint;
  return moved;
}
