// Stack snapping while a part is held: which of the held part's attach faces
// goes onto which free attach face of the rocket.
//
// As in the KSP editor, the choice is made on screen: each attach face is a
// node at its centre, and the held part snaps when one of its nodes comes
// near a free node of the rocket. The nearest pair wins; there is no
// preference by size or shape. Hysteresis keeps a pair once chosen until
// the cursor moves clearly away, so the part does not flicker between two
// nodes at the edge of the snap distance.

import type { Part } from '../geometry/part.ts';
import type { RigidTransform } from '../geometry/transform.ts';
import { applyToPoint } from '../geometry/transform.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import type { AssemblyDocument } from '../model/document.ts';
import type { FaceRef, PartLibrary } from './picking.ts';
import { requirePart } from './picking.ts';

// Screen distances in CSS pixels. A pair snaps when the held node comes
// within snapEnter of a free node, and stays snapped until it is farther
// than snapExit.
export const snapEnter = 30;
export const snapExit = 55;

export interface StackPair {
  targetId: string;
  targetFace: number;
  ownFace: number;
}

export type ToScreen = (point: Vec3) => { x: number; y: number; inFront: boolean };

// Attach faces already used by a joint, per placed part.
export function usedFaces(doc: AssemblyDocument): Map<string, Set<number>> {
  const used = new Map<string, Set<number>>();
  for (let i = 0; i < doc.placed.length; i++) {
    const placed = doc.placed[i];
    if (placed.joint === null) {
      continue;
    }
    let own = used.get(placed.id);
    if (own === undefined) {
      own = new Set<number>();
      used.set(placed.id, own);
    }
    own.add(placed.joint.ownFace);
    if (placed.parentId !== null && placed.joint.parentFace !== null) {
      let parentSet = used.get(placed.parentId);
      if (parentSet === undefined) {
        parentSet = new Set<number>();
        used.set(placed.parentId, parentSet);
      }
      parentSet.add(placed.joint.parentFace);
    }
  }
  return used;
}

// Free attach faces of visible parts that are not in `moving`.
export function freeFaces(doc: AssemblyDocument, parts: PartLibrary, moving: Set<string>): FaceRef[] {
  const result: FaceRef[] = [];
  const used = usedFaces(doc);
  for (let i = 0; i < doc.placed.length; i++) {
    const placed = doc.placed[i];
    if (placed.hidden || moving.has(placed.id)) {
      continue;
    }
    const part = requirePart(parts, placed.partId);
    const usedHere = used.get(placed.id);
    for (let f = 0; f < part.attachFaces.length; f++) {
      if (usedHere !== undefined && usedHere.has(f)) {
        continue;
      }
      result.push({ placedId: placed.id, face: f });
    }
  }
  return result;
}

function samePair(a: StackPair, b: StackPair): boolean {
  return a.targetId === b.targetId && a.targetFace === b.targetFace && a.ownFace === b.ownFace;
}

// The pair to snap to, or null. `heldPose` is where the held part floats
// under the cursor; `current` is the pair it is snapped to now, if any.
export function findStackPair(
  doc: AssemblyDocument,
  parts: PartLibrary,
  heldPart: Part,
  heldPose: RigidTransform,
  moving: Set<string>,
  current: StackPair | null,
  toScreen: ToScreen,
): StackPair | null {
  if (heldPart.attachFaces.length === 0) {
    return null;
  }
  const heldScreen: Array<{ x: number; y: number }> = [];
  for (let f = 0; f < heldPart.attachFaces.length; f++) {
    const centre = applyToPoint(heldPose, heldPart.attachFaces[f].centre);
    heldScreen.push(toScreen(centre));
  }
  const targets = freeFaces(doc, parts, moving);
  let best: StackPair | null = null;
  let bestDistance = Infinity;
  let currentDistance = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const placed = doc.placed.find(function byId(p) {
      return p.id === target.placedId;
    });
    if (placed === undefined) {
      continue;
    }
    const targetPart = requirePart(parts, placed.partId);
    const targetCentre = applyToPoint(placed.transform, targetPart.attachFaces[target.face].centre);
    const screen = toScreen(targetCentre);
    if (!screen.inFront) {
      continue;
    }
    for (let f = 0; f < heldScreen.length; f++) {
      const distance = Math.hypot(heldScreen[f].x - screen.x, heldScreen[f].y - screen.y);
      const pair: StackPair = { targetId: target.placedId, targetFace: target.face, ownFace: f };
      if (current !== null && samePair(pair, current)) {
        currentDistance = distance;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = pair;
      }
    }
  }
  // Keep the current pair while it is within snapExit; switch only when
  // another pair is clearly nearer (by half the hysteresis band).
  if (current !== null && currentDistance < snapExit) {
    const margin = (snapExit - snapEnter) / 2;
    if (best === null || bestDistance > currentDistance - margin) {
      return current;
    }
  }
  if (best !== null && bestDistance <= snapEnter) {
    return best;
  }
  return null;
}
