// The assembly editor: what happens when the user points, clicks, drags and
// presses keys in the 3D view. Behaviour follows the KSP vehicle editor
// (pick a part, it follows the cursor, it snaps on, click drops it) and the
// slicers' "lay on face" tool.
//
// The jobs are split by file:
//   picking.ts        what is under the cursor; attach faces in the world
//   stack-snap.ts     which node of the held part goes onto which node
//   place-on-face.ts  the place on face operations on the document
//   gizmo.ts          the move and rotate gizmos
// This file holds the state and wires them to the pointer and the keys.
//
// State lives in two places:
//   - history.document: the committed assembly (what undo steps through);
//   - shown: what is drawn right now. While a part is held or a gizmo is
//     dragged, `shown` is a preview made from the committed document by the
//     same operations a drop would commit, so what you see is what you get.

import type { Part } from '../geometry/part.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import { add, cross, dot, scale, sub } from '../geometry/vec3.ts';
import type { Quat, RigidTransform } from '../geometry/transform.ts';
import { applyToPoint, compose, multiplyQuat, quatFromAxisAngle, quatFromUnitVectors, rotateVector } from '../geometry/transform.ts';
import { attachToSurface, distanceFromAxis, mateFaces, placeRoot, symmetryTransforms } from '../geometry/mating.ts';
import { AFT_DIRECTION, AXIS_ORIGIN, NOSE_DIRECTION, WORLD_UP } from '../geometry/rocket-axis.ts';
import type { AssemblyDocument, Joint } from '../model/document.ts';
import {
  addParts,
  cloneDocument,
  emptyDocument,
  findPlaced,
  movePart,
  removeParts,
  requirePlaced,
  setHidden,
  subtreeIds,
  symmetryMembers,
} from '../model/document.ts';
import { History } from '../model/history.ts';
import { View } from './view.ts';
import type { PresetView } from './view.ts';
import type { PartGeometry, Highlight } from './part-visuals.ts';
import { FacePatch, Markers, PartVisual, accent, applyTransform, makePartGeometry } from './part-visuals.ts';
import type { FaceRef, PartHit } from './picking.ts';
import { partCentre, pickFace, pickPart, requirePart, sameFace, worldFace } from './picking.ts';
import type { StackPair } from './stack-snap.ts';
import { findStackPair, freeFaces } from './stack-snap.ts';
import { faceOnFace, faceOnSurface, rootOnFace } from './place-on-face.ts';
import { PartGizmo } from './gizmo.ts';

export type Tool = 'place' | 'move' | 'rotate' | 'face';

export const symmetryChoices = [1, 2, 3, 4, 6, 8];

// A press that moves less than this (CSS pixels) is a click, not a drag.
const clickSlop = 5;

type Snap =
  | { kind: 'root' }
  | { kind: 'stack'; pair: StackPair }
  | { kind: 'surface'; targetId: string; point: Vec3; normal: Vec3 };

interface Held {
  partId: string;
  // When an existing part was picked up: its id. Null for a new part.
  pickedId: string | null;
  // Orientation while floating (the user can turn it with Q/E/W/S/A/D).
  floatingRotation: Quat;
  // From the cursor's point on the work plane to the part's middle.
  grabOffset: Vec3;
  // Extra turn about the joint normal once snapped (Q/E).
  roll: number;
  snap: Snap | null;
  // Picked up by pressing and dragging: releasing drops it.
  dragging: boolean;
  // Ids (in `shown`) of everything that moves with the held part.
  shownIds: string[];
  pose: RigidTransform;
}

interface Press {
  x: number;
  y: number;
  button: number;
  onPart: string | null;
  moved: boolean;
}

export interface EditorEvents {
  // Something the panels show has changed.
  changed(): void;
}

export class Editor {
  readonly view: View;
  readonly parts = new Map<string, Part>();
  readonly partOrder: string[] = [];
  private readonly geometries = new Map<string, PartGeometry>();
  private readonly visuals = new Map<string, { visual: PartVisual; partId: string }>();
  readonly history = new History(emptyDocument());
  private shown: AssemblyDocument = emptyDocument();

  tool: Tool = 'place';
  symmetryCount = 1;
  selectedId: string | null = null;
  private held: Held | null = null;
  // Place on face: the face chosen on the selected part, waiting for a target.
  private chosenFace: number | null = null;

  private hoverId: string | null = null;
  private hoverFace: FaceRef | null = null;
  private readonly patches = new Map<string, FacePatch>();
  private readonly targetMarkers = new Markers(13, false, accent);
  private readonly heldMarkers = new Markers(9, false, 0xffffff);
  private readonly activeMarker = new Markers(17, true, accent);

  readonly gizmo: PartGizmo;
  // The committed pose of the selected part when a gizmo drag began.
  private gizmoStartPose: RigidTransform | null = null;

  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private press: Press | null = null;
  private updateQueued = false;
  private readonly listeners: EditorEvents[] = [];

  constructor(container: HTMLElement) {
    this.view = new View(container);
    this.view.overlayGroup.add(this.targetMarkers.points);
    this.view.overlayGroup.add(this.heldMarkers.points);
    this.view.overlayGroup.add(this.activeMarker.points);

    const self = this;
    this.gizmo = new PartGizmo(this.view, container, {
      preview: function preview(motion: RigidTransform) {
        self.gizmoPreview(motion);
      },
      commit: function commit(motion: RigidTransform) {
        self.gizmoCommit(motion);
      },
    });

    const canvas = this.view.canvas;
    // Capture phase: these run before the orbit controls' own listeners, so
    // a press that picks or drops a part can switch orbiting off first.
    canvas.addEventListener(
      'pointerdown',
      function down(event) {
        self.onPointerDown(event);
      },
      true,
    );
    window.addEventListener('pointermove', function move(event) {
      self.onPointerMove(event);
    });
    window.addEventListener('pointerup', function up(event) {
      self.onPointerUp(event);
    });
    canvas.addEventListener('pointerleave', function leave() {
      self.pointerInside = false;
      self.queueUpdate();
    });
    canvas.addEventListener('contextmenu', function context(event) {
      event.preventDefault();
    });
    window.addEventListener('keydown', function key(event) {
      self.onKeyDown(event);
    });
    window.addEventListener('keyup', function key(event) {
      self.setModifiers(event.shiftKey, event.ctrlKey || event.metaKey);
    });
    window.addEventListener('blur', function lostFocus() {
      self.setModifiers(false, false);
    });
    this.view.controls.addEventListener('change', function cameraMoved() {
      // Screen-space snapping depends on the camera.
      if (self.held !== null) {
        self.queueUpdate();
      }
    });
  }

  addListener(listener: EditorEvents): void {
    this.listeners.push(listener);
  }

  private notify(): void {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].changed();
    }
  }

  // -------------------------------------------------------------------------
  // Parts and documents.

  addPart(part: Part): void {
    this.parts.set(part.id, part);
    this.partOrder.push(part.id);
    this.geometries.set(part.id, makePartGeometry(part));
    this.notify();
  }

  get document(): AssemblyDocument {
    return this.history.document;
  }

  get shownDocument(): AssemblyDocument {
    return this.shown;
  }

  isHolding(): boolean {
    return this.held !== null;
  }

  heldSnapKind(): string | null {
    if (this.held === null || this.held.snap === null) {
      return null;
    }
    return this.held.snap.kind;
  }

  // The id the held part has in the shown document (for the test hook).
  heldShownId(): string | null {
    if (this.held === null || this.held.shownIds.length === 0) {
      return null;
    }
    return this.held.shownIds[0];
  }

  heldPartId(): string | null {
    if (this.held === null) {
      return null;
    }
    return this.held.partId;
  }

  // The attach face of a source part: the user's choice, else the guess.
  attachFaceOf(partId: string): number {
    const chosen = this.history.document.attachFaceByPart[partId];
    if (chosen !== undefined) {
      return chosen;
    }
    return requirePart(this.parts, partId).guessedAttachFace;
  }

  private commit(next: AssemblyDocument): void {
    this.history.commit(next);
    this.showCommitted();
  }

  private showCommitted(): void {
    this.shown = cloneDocument(this.history.document);
    if (this.selectedId !== null && findPlaced(this.shown, this.selectedId) === null) {
      this.selectedId = null;
      this.chosenFace = null;
    }
    this.syncScene();
    this.notify();
  }

  undo(): void {
    this.cancelHeld();
    if (this.history.undo()) {
      this.showCommitted();
    }
  }

  redo(): void {
    this.cancelHeld();
    if (this.history.redo()) {
      this.showCommitted();
    }
  }

  // -------------------------------------------------------------------------
  // Drawing.

  // Make the three.js objects match `shown`, and the overlays match the state.
  private syncScene(): void {
    const present = new Set<string>();
    for (let i = 0; i < this.shown.placed.length; i++) {
      const placed = this.shown.placed[i];
      if (placed.hidden) {
        continue;
      }
      present.add(placed.id);
      let entry = this.visuals.get(placed.id);
      if (entry === undefined || entry.partId !== placed.partId) {
        if (entry !== undefined) {
          this.view.partsGroup.remove(entry.visual.group);
          entry.visual.dispose();
        }
        const geometry = this.geometries.get(placed.partId);
        if (geometry === undefined) {
          continue;
        }
        entry = { visual: new PartVisual(geometry), partId: placed.partId };
        this.visuals.set(placed.id, entry);
        this.view.partsGroup.add(entry.visual.group);
      }
      applyTransform(entry.visual.group, placed.transform);
    }
    const self = this;
    this.visuals.forEach(function removeStale(entry, id) {
      if (!present.has(id)) {
        self.view.partsGroup.remove(entry.visual.group);
        entry.visual.dispose();
        self.visuals.delete(id);
      }
    });
    this.updateHighlights();
    this.updatePatches();
    this.updateMarkers();
    this.updateGizmo();
    this.view.requestRender();
  }

  // The ids of the selected part's symmetry set (empty when nothing is selected).
  private selectedSet(): Set<string> {
    const selected = new Set<string>();
    if (this.selectedId === null || this.held !== null) {
      return selected;
    }
    if (findPlaced(this.shown, this.selectedId) === null) {
      return selected;
    }
    const members = symmetryMembers(this.shown, this.selectedId);
    for (let i = 0; i < members.length; i++) {
      selected.add(members[i].id);
    }
    return selected;
  }

  private updateHighlights(): void {
    const selected = this.selectedSet();
    const hovered = new Set<string>();
    if (this.hoverId !== null && findPlaced(this.shown, this.hoverId) !== null) {
      // Hover lights the whole symmetry set, as selection does.
      const members = symmetryMembers(this.shown, this.hoverId);
      for (let i = 0; i < members.length; i++) {
        hovered.add(members[i].id);
      }
    }
    const heldIds = new Set<string>();
    let floating = false;
    if (this.held !== null) {
      for (let i = 0; i < this.held.shownIds.length; i++) {
        heldIds.add(this.held.shownIds[i]);
      }
      floating = this.held.snap === null;
    }
    this.visuals.forEach(function setHighlight(entry, id) {
      let highlight: Highlight = 'none';
      if (selected.has(id)) {
        highlight = 'selected';
      } else if (hovered.has(id)) {
        highlight = 'hover';
      }
      entry.visual.setHighlight(highlight);
      entry.visual.setFloating(heldIds.has(id) && floating);
    });
  }

  // Everything that moves with the held part, in the committed document.
  private movingWithHeld(): Set<string> {
    const moving = new Set<string>();
    if (this.held === null || this.held.pickedId === null) {
      return moving;
    }
    const committed = this.history.document;
    const members = symmetryMembers(committed, this.held.pickedId);
    for (let m = 0; m < members.length; m++) {
      const subtree = subtreeIds(committed, members[m].id);
      for (let k = 0; k < subtree.length; k++) {
        moving.add(subtree[k]);
      }
    }
    return moving;
  }

  // Attach nodes show while a part is held (not for the root, which has
  // nothing to attach to): rings on the rocket's free faces, small white
  // rings on the held part's faces, a filled dot on the node it snapped to.
  private updateMarkers(): void {
    const targets: number[] = [];
    const heldPoints: number[] = [];
    const active: number[] = [];
    const held = this.held;
    const placingRoot = held !== null && held.snap !== null && held.snap.kind === 'root';
    if (held !== null && !placingRoot) {
      const shownMoving = new Set<string>(held.shownIds);
      const nodes = freeFaces(this.shown, this.parts, shownMoving);
      for (let i = 0; i < nodes.length; i++) {
        const placed = requirePlaced(this.shown, nodes[i].placedId);
        const centre = worldFace(this.parts, placed, nodes[i].face).centre;
        targets.push(centre[0], centre[1], centre[2]);
      }
      let heldPlaced = null;
      if (held.shownIds.length > 0) {
        heldPlaced = findPlaced(this.shown, held.shownIds[0]);
      }
      if (heldPlaced !== null) {
        const part = requirePart(this.parts, heldPlaced.partId);
        for (let f = 0; f < part.attachFaces.length; f++) {
          const centre = worldFace(this.parts, heldPlaced, f).centre;
          heldPoints.push(centre[0], centre[1], centre[2]);
        }
      }
      const snap = held.snap;
      if (snap !== null && snap.kind === 'stack') {
        const target = requirePlaced(this.shown, snap.pair.targetId);
        const centre = worldFace(this.parts, target, snap.pair.targetFace).centre;
        active.push(centre[0], centre[1], centre[2]);
      }
    }
    this.targetMarkers.setPositions(targets);
    this.heldMarkers.setPositions(heldPoints);
    this.activeMarker.setPositions(active);
  }

  // The face patches place on face shows: the selected part's faces, and
  // once one is chosen, the faces of every other visible part not moving
  // with it.
  private offeredFaces(): FaceRef[] {
    const wanted: FaceRef[] = [];
    if (this.tool !== 'face' || this.held !== null || this.selectedId === null) {
      return wanted;
    }
    const selected = findPlaced(this.shown, this.selectedId);
    if (selected === null || selected.hidden) {
      return wanted;
    }
    const part = requirePart(this.parts, selected.partId);
    for (let f = 0; f < part.attachFaces.length; f++) {
      wanted.push({ placedId: selected.id, face: f });
    }
    if (this.chosenFace === null) {
      return wanted;
    }
    const moving = new Set<string>();
    const members = symmetryMembers(this.shown, selected.id);
    for (let m = 0; m < members.length; m++) {
      const subtree = subtreeIds(this.shown, members[m].id);
      for (let k = 0; k < subtree.length; k++) {
        moving.add(subtree[k]);
      }
    }
    for (let i = 0; i < this.shown.placed.length; i++) {
      const other = this.shown.placed[i];
      if (other.hidden || moving.has(other.id)) {
        continue;
      }
      const otherPart = requirePart(this.parts, other.partId);
      for (let f = 0; f < otherPart.attachFaces.length; f++) {
        wanted.push({ placedId: other.id, face: f });
      }
    }
    return wanted;
  }

  private updatePatches(): void {
    const wanted = this.offeredFaces();
    const keep = new Set<string>();
    for (let i = 0; i < wanted.length; i++) {
      const ref = wanted[i];
      const placed = requirePlaced(this.shown, ref.placedId);
      // The key includes the pose, so a moved part gets fresh patches.
      const key = ref.placedId + ':' + String(ref.face) + ':' + JSON.stringify(placed.transform);
      keep.add(key);
      let patch = this.patches.get(key);
      if (patch === undefined) {
        patch = new FacePatch(worldFace(this.parts, placed, ref.face));
        this.patches.set(key, patch);
        this.view.overlayGroup.add(patch.group);
      }
      const onSelected = ref.placedId === this.selectedId;
      const hovered = sameFace(this.hoverFace, ref);
      if (onSelected && this.chosenFace === ref.face) {
        patch.setState('chosen');
      } else if (hovered) {
        patch.setState('hover');
      } else if (onSelected && this.chosenFace !== null) {
        // The other faces of the part being placed step back.
        patch.setState('dim');
      } else {
        patch.setState('idle');
      }
    }
    const self = this;
    this.patches.forEach(function removeStale(patch, key) {
      if (!keep.has(key)) {
        self.view.overlayGroup.remove(patch.group);
        patch.dispose();
        self.patches.delete(key);
      }
    });
  }

  // The world point the gizmos turn about and the inspector shows: the
  // middle of the selected part's bounding box.
  selectedPivot(): Vec3 | null {
    if (this.selectedId === null) {
      return null;
    }
    const placed = findPlaced(this.shown, this.selectedId);
    if (placed === null) {
      return null;
    }
    const part = requirePart(this.parts, placed.partId);
    return applyToPoint(placed.transform, partCentre(part));
  }

  private updateGizmo(): void {
    const wanted = (this.tool === 'move' || this.tool === 'rotate') && this.held === null;
    const pivot = this.selectedPivot();
    let placed = null;
    if (this.selectedId !== null) {
      placed = findPlaced(this.shown, this.selectedId);
    }
    if (!wanted || pivot === null || placed === null || placed.hidden) {
      this.gizmo.hide();
      return;
    }
    this.gizmo.show(this.tool === 'move' ? 'move' : 'rotate', pivot);
  }

  // -------------------------------------------------------------------------
  // Holding parts.

  // Where the cursor ray meets the plane facing the camera through the orbit
  // centre: held parts float at the rocket's depth, as in KSP.
  private workPlanePoint(origin: Vec3, direction: Vec3): Vec3 {
    const target = this.view.controls.target;
    const centre: Vec3 = [target.x, target.y, target.z];
    const normal = this.view.viewDirection();
    const along = dot(direction, normal);
    const distance = dot(sub(centre, origin), normal) / along;
    return add(origin, scale(direction, distance));
  }

  // The orientation a new part is held in: a section (attach face round)
  // with its attach face aft, so it lines up with the rocket; anything else
  // (a fin) standing on its attach face with its long side along the axis.
  private holdingRotation(partId: string): Quat {
    const part = requirePart(this.parts, partId);
    const faceIndex = this.attachFaceOf(partId);
    if (faceIndex < 0) {
      return [0, 0, 0, 1];
    }
    const face = part.attachFaces[faceIndex];
    if (face.radius !== null) {
      return quatFromUnitVectors(face.normal, AFT_DIRECTION);
    }
    const down = scale(WORLD_UP, -1);
    const first = quatFromUnitVectors(face.normal, down);
    const long = rotateVector(first, face.longDirection);
    const sine = dot(cross(long, NOSE_DIRECTION), down);
    const cosine = dot(long, NOSE_DIRECTION);
    const turn = quatFromAxisAngle(down, Math.atan2(sine, cosine));
    return multiplyQuat(turn, first);
  }

  // Thumbnail orientation, the same as when the part is first held.
  holdingTransform(partId: string): RigidTransform {
    return { position: [0, 0, 0], rotation: this.holdingRotation(partId) };
  }

  // Pick up a new part from the parts list.
  pickNew(partId: string): void {
    this.cancelHeld();
    this.chosenFace = null;
    const rotation = this.holdingRotation(partId);
    this.held = {
      partId: partId,
      pickedId: null,
      floatingRotation: rotation,
      grabOffset: [0, 0, 0],
      roll: 0,
      snap: null,
      dragging: false,
      shownIds: [],
      pose: { position: [0, 0, 0], rotation: rotation },
    };
    this.updateHeld();
    this.notify();
  }

  // Pick up a placed part (and its children, and its symmetry set).
  private pickUp(placedId: string, dragging: boolean): void {
    const placed = requirePlaced(this.history.document, placedId);
    const part = requirePart(this.parts, placed.partId);
    const middle = applyToPoint(placed.transform, partCentre(part));
    const ray = this.view.rayAt(this.pointerX, this.pointerY);
    const onPlane = this.workPlanePoint(ray.origin, ray.direction);
    // Keep the part where it is under the cursor: its middle stays at the
    // same offset from the cursor's point on the work plane.
    const grabOffset = sub(middle, onPlane);
    this.held = {
      partId: placed.partId,
      pickedId: placedId,
      floatingRotation: placed.transform.rotation,
      grabOffset: grabOffset,
      roll: 0,
      snap: null,
      dragging: dragging,
      shownIds: [],
      pose: placed.transform,
    };
    this.selectedId = null;
    this.hoverId = null;
    this.updateHeld();
    this.notify();
  }

  cancelHeld(): void {
    if (this.held === null) {
      return;
    }
    this.held = null;
    this.showCommitted();
  }

  private queueUpdate(): void {
    if (this.updateQueued) {
      return;
    }
    this.updateQueued = true;
    const self = this;
    // Once per frame however many pointer events arrive.
    requestAnimationFrame(function update() {
      self.updateQueued = false;
      if (self.held !== null) {
        self.updateHeld();
      } else {
        self.updateHover();
      }
    });
  }

  // How many copies a new placement makes: one for a section on the axis
  // (nowhere to put copies), the symmetry count for anything off it.
  private copiesFor(snap: Snap | null, held: Held, pose: RigidTransform): number {
    if (held.pickedId !== null) {
      return 1; // movePart carries the symmetry set of a picked-up part
    }
    if (snap === null || snap.kind === 'root') {
      return 1;
    }
    const middle = applyToPoint(pose, partCentre(requirePart(this.parts, held.partId)));
    if (distanceFromAxis(middle) < 0.5) {
      return 1;
    }
    return this.symmetryCount;
  }

  // Recompute where the held part is, from the cursor.
  private updateHeld(): void {
    const held = this.held;
    if (held === null) {
      return;
    }
    const committed = this.history.document;
    const part = requirePart(this.parts, held.partId);
    const faceIndex = this.attachFaceOf(held.partId);
    const middle = partCentre(part);
    const ray = this.view.rayAt(this.pointerX, this.pointerY);
    const cursorPoint = add(this.workPlanePoint(ray.origin, ray.direction), held.grabOffset);
    const floatingPose: RigidTransform = {
      rotation: held.floatingRotation,
      position: sub(cursorPoint, rotateVector(held.floatingRotation, middle)),
    };
    const moving = this.movingWithHeld();
    const becomesRoot = committed.rootId === null || committed.rootId === held.pickedId;

    let snap: Snap | null = null;
    let pose = floatingPose;
    if (becomesRoot) {
      // The root lies on the axis, attach face aft, and slides along the
      // axis with the cursor.
      snap = { kind: 'root' };
      if (faceIndex >= 0) {
        const onAxis = placeRoot(part.attachFaces[faceIndex], floatingPose, held.roll);
        const middleNow = applyToPoint(onAxis, middle);
        const cursorStation = dot(sub(cursorPoint, AXIS_ORIGIN), NOSE_DIRECTION);
        const middleStation = dot(sub(middleNow, AXIS_ORIGIN), NOSE_DIRECTION);
        const slide = scale(NOSE_DIRECTION, cursorStation - middleStation);
        pose = { position: add(onAxis.position, slide), rotation: onAxis.rotation };
      }
    } else {
      let current: StackPair | null = null;
      if (held.snap !== null && held.snap.kind === 'stack') {
        current = held.snap.pair;
      }
      const view = this.view;
      const pair = findStackPair(committed, this.parts, part, floatingPose, moving, current, function toScreen(point: Vec3) {
        return view.toScreen(point);
      });
      if (pair !== null) {
        snap = { kind: 'stack', pair: pair };
        const target = worldFace(this.parts, requirePlaced(committed, pair.targetId), pair.targetFace);
        pose = mateFaces(part.attachFaces[pair.ownFace], floatingPose, target.centre, target.normal, held.roll);
      } else if (faceIndex >= 0 && this.pointerInside) {
        const hit = pickPart(committed, this.parts, ray.origin, ray.direction, moving);
        if (hit !== null) {
          snap = { kind: 'surface', targetId: hit.placedId, point: hit.point, normal: hit.normal };
          pose = attachToSurface(part.attachFaces[faceIndex], middle, floatingPose, hit.point, hit.normal, held.roll);
        }
      }
    }
    held.snap = snap;
    held.pose = pose;

    // Build the preview exactly as a drop would.
    const preview = this.placementResult(held, pose, snap);
    this.shown = preview.doc;
    held.shownIds = preview.movingIds;
    this.view.canvas.style.cursor = 'grabbing';
    this.syncScene();
  }

  // The document a drop would commit, and the ids that move with the held part.
  private placementResult(held: Held, pose: RigidTransform, snap: Snap | null): { doc: AssemblyDocument; movingIds: string[]; addedIds: string[] } {
    const committed = this.history.document;
    let parentId: string | null = null;
    let joint: Joint | null = null;
    if (snap !== null && snap.kind === 'stack') {
      parentId = snap.pair.targetId;
      joint = { ownFace: snap.pair.ownFace, parentFace: snap.pair.targetFace };
    } else if (snap !== null && snap.kind === 'surface') {
      parentId = snap.targetId;
      joint = { ownFace: this.attachFaceOf(held.partId), parentFace: null };
    }
    if (held.pickedId === null) {
      const count = this.copiesFor(snap, held, pose);
      let transforms: RigidTransform[] = [pose];
      if (count > 1) {
        transforms = symmetryTransforms(pose, count);
      }
      const added = addParts(committed, { partId: held.partId, transforms: transforms, parentId: parentId, joint: joint });
      return { doc: added.doc, movingIds: added.ids, addedIds: added.ids };
    }
    const moved = movePart(committed, held.pickedId, pose);
    const members = symmetryMembers(moved, held.pickedId);
    const movingIds: string[] = [];
    for (let m = 0; m < members.length; m++) {
      const member = members[m];
      member.parentId = parentId;
      member.joint = null;
      if (joint !== null) {
        member.joint = { ownFace: joint.ownFace, parentFace: joint.parentFace };
      }
      const subtree = subtreeIds(moved, member.id);
      for (let k = 0; k < subtree.length; k++) {
        movingIds.push(subtree[k]);
      }
    }
    if (snap !== null && snap.kind === 'root') {
      moved.rootId = held.pickedId;
    }
    return { doc: moved, movingIds: movingIds, addedIds: [] };
  }

  private dropHeld(): void {
    const held = this.held;
    if (held === null) {
      return;
    }
    // Recompute from the latest pointer position, so a quick click drops
    // where the cursor is now.
    this.updateHeld();
    const result = this.placementResult(held, held.pose, held.snap);
    this.held = null;
    if (held.pickedId !== null) {
      this.selectedId = held.pickedId;
    } else if (result.addedIds.length > 0) {
      this.selectedId = result.addedIds[0];
    }
    this.commit(result.doc);
    this.updateHover();
  }

  private turnHeld(axis: Vec3, angle: number): void {
    const held = this.held;
    if (held === null) {
      return;
    }
    if (held.snap !== null) {
      // Snapped: turn about the joint (Q/E style roll).
      held.roll = held.roll + angle;
    } else {
      held.floatingRotation = multiplyQuat(quatFromAxisAngle(axis, angle), held.floatingRotation);
    }
    this.updateHeld();
  }

  // -------------------------------------------------------------------------
  // Hover and cursor.

  private updateHover(): void {
    let hoverId: string | null = null;
    let hoverFace: FaceRef | null = null;
    let cursor = 'default';
    if (this.pointerInside && !this.gizmo.dragging) {
      const ray = this.view.rayAt(this.pointerX, this.pointerY);
      if (this.tool === 'face') {
        hoverFace = pickFace(this.shown, this.parts, ray.origin, ray.direction, this.offeredFaces());
      }
      const hit = pickPart(this.shown, this.parts, ray.origin, ray.direction, new Set<string>());
      if (hit !== null) {
        hoverId = hit.placedId;
      }
      if (this.gizmo.hovered()) {
        cursor = this.tool === 'move' ? 'move' : 'grab';
        hoverId = null;
      } else if (hoverFace !== null) {
        cursor = 'pointer';
        hoverId = null;
      } else if (hoverId !== null) {
        if (this.tool === 'place' && hoverId !== this.history.document.rootId) {
          cursor = 'grab';
        } else {
          cursor = 'pointer';
        }
      }
    }
    if (this.gizmo.dragging) {
      cursor = this.tool === 'move' ? 'move' : 'grabbing';
    }
    if (this.press !== null && this.press.moved && this.press.button !== 0) {
      cursor = 'move';
    }
    this.view.canvas.style.cursor = cursor;
    const changed = hoverId !== this.hoverId || !sameFace(hoverFace, this.hoverFace);
    this.hoverId = hoverId;
    this.hoverFace = hoverFace;
    if (changed) {
      this.updateHighlights();
      this.updatePatches();
      this.view.requestRender();
    }
  }

  // -------------------------------------------------------------------------
  // Pointer.

  private onPointerDown(event: PointerEvent): void {
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.pointerInside = true;
    this.setModifiers(event.shiftKey, event.ctrlKey || event.metaKey);
    let onPart: string | null = null;
    if (event.button === 0 && this.held === null) {
      // The gizmo handles its own presses.
      if (this.gizmo.hovered()) {
        // The orbit controls must not turn the view while a handle is dragged.
        this.view.controls.enabled = false;
        this.press = { x: event.clientX, y: event.clientY, button: event.button, onPart: null, moved: true };
        return;
      }
      const ray = this.view.rayAt(event.clientX, event.clientY);
      const hit = pickPart(this.shown, this.parts, ray.origin, ray.direction, new Set<string>());
      if (hit !== null) {
        onPart = hit.placedId;
      }
      let faceUnder: FaceRef | null = null;
      if (this.tool === 'face') {
        faceUnder = pickFace(this.shown, this.parts, ray.origin, ray.direction, this.offeredFaces());
      }
      // A press on a part in place mode may become a drag that carries it,
      // so the camera must not orbit.
      const grabbable = this.tool === 'place' && onPart !== null && onPart !== this.history.document.rootId;
      if (grabbable || faceUnder !== null) {
        this.view.controls.enabled = false;
      }
    }
    if (event.button === 0 && this.held !== null) {
      // A click drops the held part; it must not start an orbit.
      this.view.controls.enabled = false;
    }
    this.press = { x: event.clientX, y: event.clientY, button: event.button, onPart: onPart, moved: false };
  }

  private onPointerMove(event: PointerEvent): void {
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    const rect = this.view.canvas.getBoundingClientRect();
    const overCanvas = event.target === this.view.canvas;
    const inRect = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    this.pointerInside = overCanvas && inRect;
    this.setModifiers(event.shiftKey, event.ctrlKey || event.metaKey);
    this.gizmo.moveLabel(event.clientX, event.clientY);
    const press = this.press;
    if (press !== null && !press.moved) {
      const travelled = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (travelled > clickSlop) {
        press.moved = true;
        // Press and drag on a part in place mode: carry it, drop on release.
        const grabbable = this.tool === 'place' && press.button === 0 && press.onPart !== null && press.onPart !== this.history.document.rootId;
        if (grabbable && this.held === null && press.onPart !== null) {
          this.pickUp(press.onPart, true);
        }
      }
    }
    this.queueUpdate();
  }

  private onPointerUp(event: PointerEvent): void {
    const press = this.press;
    this.press = null;
    this.view.controls.enabled = !this.gizmo.dragging;
    const overCanvas = event.target === this.view.canvas;
    if (press === null) {
      // The press began outside the view (a part dragged in from the list).
      if (this.held !== null && overCanvas && event.button === 0) {
        this.pointerX = event.clientX;
        this.pointerY = event.clientY;
        this.dropHeld();
      }
      return;
    }
    const click = !press.moved;
    if (press.button === 2) {
      // Right click (not a pan): cancel what is held, or the face choice.
      if (click) {
        this.cancel();
      }
      return;
    }
    if (press.button !== 0) {
      return;
    }
    if (this.held !== null) {
      if (click || this.held.dragging) {
        this.dropHeld();
      }
      return;
    }
    if (!click) {
      return;
    }
    this.onClick(event.clientX, event.clientY, press.onPart);
  }

  private onClick(clientX: number, clientY: number, onPart: string | null): void {
    if (this.tool === 'face') {
      this.faceClick(clientX, clientY, onPart);
      return;
    }
    if (this.tool === 'place' && onPart !== null && onPart !== this.history.document.rootId) {
      // Click a placed part: it comes off and follows the cursor.
      this.pickUp(onPart, false);
      return;
    }
    this.select(onPart);
  }

  select(placedId: string | null): void {
    this.selectedId = placedId;
    this.chosenFace = null;
    this.syncScene();
    this.notify();
  }

  // Escape or right click: put what is held back where it came from, or
  // forget the chosen face, or clear the selection.
  private cancel(): void {
    if (this.held !== null) {
      this.cancelHeld();
    } else if (this.chosenFace !== null) {
      this.chosenFace = null;
      this.syncScene();
    } else if (this.selectedId !== null) {
      this.select(null);
    }
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Place on face.

  private faceClick(clientX: number, clientY: number, onPart: string | null): void {
    const ray = this.view.rayAt(clientX, clientY);
    const doc = this.history.document;
    const faceUnder = pickFace(this.shown, this.parts, ray.origin, ray.direction, this.offeredFaces());
    let selected = null;
    if (this.selectedId !== null) {
      selected = findPlaced(doc, this.selectedId);
    }
    if (selected === null) {
      this.select(onPart);
      return;
    }
    if (faceUnder !== null && faceUnder.placedId === selected.id) {
      if (selected.id === doc.rootId) {
        // The root needs nothing else: that face becomes its aft face.
        this.chosenFace = null;
        this.commit(rootOnFace(doc, this.parts, selected.id, faceUnder.face));
        return;
      }
      this.chosenFace = faceUnder.face;
      this.syncScene();
      this.notify();
      return;
    }
    if (this.chosenFace === null) {
      // Nothing chosen yet: clicking another part selects it instead.
      this.select(onPart);
      return;
    }
    const ownFace = this.chosenFace;
    this.chosenFace = null;
    if (faceUnder !== null) {
      this.commit(faceOnFace(doc, this.parts, selected.id, ownFace, faceUnder.placedId, faceUnder.face));
      return;
    }
    if (onPart !== null && onPart !== selected.id) {
      const moving = new Set<string>(subtreeIds(doc, selected.id));
      const hit: PartHit | null = pickPart(doc, this.parts, ray.origin, ray.direction, moving);
      if (hit !== null) {
        this.commit(faceOnSurface(doc, this.parts, selected.id, ownFace, hit.placedId, hit.point, hit.normal));
        return;
      }
    }
    // Clicked nothing useful: the choice is dropped.
    this.syncScene();
    this.notify();
  }

  // -------------------------------------------------------------------------
  // Gizmo.

  private gizmoPreview(motion: RigidTransform): void {
    if (this.selectedId === null) {
      return;
    }
    if (this.gizmoStartPose === null) {
      this.gizmoStartPose = requirePlaced(this.history.document, this.selectedId).transform;
    }
    const pose = compose(motion, this.gizmoStartPose);
    this.shown = movePart(this.history.document, this.selectedId, pose);
    this.syncScene();
    this.notify();
  }

  private gizmoCommit(motion: RigidTransform): void {
    const start = this.gizmoStartPose;
    this.gizmoStartPose = null;
    if (this.selectedId === null || start === null) {
      return;
    }
    const pose = compose(motion, start);
    this.commit(movePart(this.history.document, this.selectedId, pose));
  }

  private setModifiers(shift: boolean, ctrl: boolean): void {
    this.gizmo.setModifiers(shift, ctrl);
    if (!this.gizmo.dragging) {
      this.gizmoStartPose = null;
    }
  }

  // Numeric entry from the inspector: the selected part's middle goes to
  // `pivot`, turned to `rotation`.
  setSelectedPlacement(pivot: Vec3, rotation: Quat): void {
    if (this.selectedId === null) {
      return;
    }
    const placed = requirePlaced(this.history.document, this.selectedId);
    const middle = partCentre(requirePart(this.parts, placed.partId));
    const position = sub(pivot, rotateVector(rotation, middle));
    this.commit(movePart(this.history.document, this.selectedId, { position: position, rotation: rotation }));
  }

  // -------------------------------------------------------------------------
  // Commands (toolbar, keys, panels).

  setTool(tool: Tool): void {
    this.cancelHeld();
    this.tool = tool;
    this.chosenFace = null;
    this.syncScene();
    this.notify();
  }

  setSymmetry(count: number): void {
    this.symmetryCount = count;
    // On a selected placed part off the axis, change its set.
    if (this.held === null && this.selectedId !== null) {
      this.resymmetrise(this.selectedId, count);
    }
    if (this.held !== null) {
      this.updateHeld();
    }
    this.notify();
  }

  // Replace a placed part's symmetry set by one of `count` copies. Only
  // parts off the axis, without children (copies of children are not made).
  private resymmetrise(placedId: string, count: number): void {
    const doc = this.history.document;
    const placed = requirePlaced(doc, placedId);
    const members = symmetryMembers(doc, placedId);
    if (members.length === count) {
      return;
    }
    const middle = applyToPoint(placed.transform, partCentre(requirePart(this.parts, placed.partId)));
    if (distanceFromAxis(middle) < 0.5) {
      return;
    }
    for (let m = 0; m < members.length; m++) {
      if (subtreeIds(doc, members[m].id).length > 1) {
        return;
      }
    }
    const first = members[0];
    const ids = memberIds(doc, placedId);
    const without = removeParts(doc, ids);
    let transforms: RigidTransform[] = [first.transform];
    if (count > 1) {
      transforms = symmetryTransforms(first.transform, count);
    }
    const added = addParts(without, { partId: first.partId, transforms: transforms, parentId: first.parentId, joint: first.joint });
    this.selectedId = added.ids[0];
    this.commit(added.doc);
  }

  stepSymmetry(direction: number): void {
    let index = symmetryChoices.indexOf(this.symmetryCount);
    if (index < 0) {
      index = 0;
    }
    index = (index + direction + symmetryChoices.length) % symmetryChoices.length;
    this.setSymmetry(symmetryChoices[index]);
  }

  toggleHidden(placedId: string): void {
    const placed = requirePlaced(this.history.document, placedId);
    this.commit(setHidden(this.history.document, placedId, !placed.hidden));
  }

  deleteSelected(): void {
    if (this.held !== null) {
      const picked = this.held.pickedId;
      this.held = null;
      if (picked !== null) {
        this.commit(removeParts(this.history.document, memberIds(this.history.document, picked)));
      } else {
        this.showCommitted();
      }
      return;
    }
    if (this.selectedId === null) {
      return;
    }
    const ids = memberIds(this.history.document, this.selectedId);
    this.selectedId = null;
    this.commit(removeParts(this.history.document, ids));
  }

  setView(preset: PresetView | 'fit'): void {
    const bounds = this.visibleBounds();
    let centre: Vec3 = [-150, 0, 0];
    let size = 700;
    if (bounds !== null) {
      centre = scale(add(bounds.min, bounds.max), 0.5);
      const extent = sub(bounds.max, bounds.min);
      size = Math.max(100, extent[0], extent[1], extent[2]);
    }
    // Along the axis the rocket is small; frame its diameter.
    if ((preset === 'nose' || preset === 'tail') && bounds !== null) {
      const extent = sub(bounds.max, bounds.min);
      size = Math.max(60, Math.hypot(extent[1], extent[2]) * 1.3);
    }
    if (preset === 'fit') {
      this.view.fit(centre, size);
      return;
    }
    this.view.setPreset(preset, centre, size);
  }

  private visibleBounds(): { min: Vec3; max: Vec3 } | null {
    let min: Vec3 = [Infinity, Infinity, Infinity];
    let max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (let i = 0; i < this.shown.placed.length; i++) {
      const placed = this.shown.placed[i];
      if (placed.hidden) {
        continue;
      }
      const part = requirePart(this.parts, placed.partId);
      for (let corner = 0; corner < 8; corner++) {
        const local: Vec3 = [
          corner & 1 ? part.boundsMax[0] : part.boundsMin[0],
          corner & 2 ? part.boundsMax[1] : part.boundsMin[1],
          corner & 4 ? part.boundsMax[2] : part.boundsMin[2],
        ];
        const world = applyToPoint(placed.transform, local);
        min = [Math.min(min[0], world[0]), Math.min(min[1], world[1]), Math.min(min[2], world[2])];
        max = [Math.max(max[0], world[0]), Math.max(max[1], world[1]), Math.max(max[2], world[2])];
        any = true;
      }
    }
    if (!any) {
      return null;
    }
    return { min: min, max: max };
  }

  // -------------------------------------------------------------------------
  // Keys.

  private onKeyDown(event: KeyboardEvent): void {
    this.setModifiers(event.shiftKey, event.ctrlKey || event.metaKey);
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      return;
    }
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    if (command && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      this.undo();
      return;
    }
    if (command && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      this.redo();
      return;
    }
    if (command) {
      return;
    }
    if (key === 'escape') {
      this.cancel();
      return;
    }
    if (key === 'delete' || key === 'backspace') {
      event.preventDefault();
      this.deleteSelected();
      return;
    }
    if (key === '1') {
      this.setTool('place');
    } else if (key === '2' || key === 'g') {
      this.setTool('move');
    } else if (key === '3' || key === 'r') {
      this.setTool('rotate');
    } else if (key === '4' || key === 'f') {
      this.setTool('face');
    } else if (key === 'x') {
      this.stepSymmetry(event.shiftKey ? -1 : 1);
    } else if (this.held !== null) {
      // KSP keys turn the held part: 90 degrees, 15 with Shift.
      const step = ((event.shiftKey ? 15 : 90) * Math.PI) / 180;
      if (key === 'q') {
        this.turnHeld(NOSE_DIRECTION, step);
      } else if (key === 'e') {
        this.turnHeld(NOSE_DIRECTION, -step);
      } else if (key === 'w') {
        this.turnHeld([0, 0, 1], step);
      } else if (key === 's') {
        this.turnHeld([0, 0, 1], -step);
      } else if (key === 'a') {
        this.turnHeld(WORLD_UP, step);
      } else if (key === 'd') {
        this.turnHeld(WORLD_UP, -step);
      }
    }
  }

  isRoot(placedId: string): boolean {
    return this.history.document.rootId === placedId;
  }

  // For the test hook: a placed part's attach face in the world.
  worldFaceOf(placedId: string, face: number): { centre: Vec3; normal: Vec3; radius: number | null } {
    const placed = requirePlaced(this.shown, placedId);
    const world = worldFace(this.parts, placed, face);
    return { centre: world.centre, normal: world.normal, radius: world.radius };
  }
}

function memberIds(doc: AssemblyDocument, placedId: string): string[] {
  const members = symmetryMembers(doc, placedId);
  const ids: string[] = [];
  for (let i = 0; i < members.length; i++) {
    ids.push(members[i].id);
  }
  return ids;
}
