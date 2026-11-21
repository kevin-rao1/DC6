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

import type * as THREE from 'three';
import type { Part } from '../geometry/part.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import { add, cross, dot, scale, sub } from '../geometry/vec3.ts';
import type { Quat, RigidTransform } from '../geometry/transform.ts';
import { applyToPoint, compose, multiplyQuat, quatAngle, quatFromAxisAngle, quatFromUnitVectors, rotateVector, rotationAboutLine } from '../geometry/transform.ts';
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
import { DecalTool } from './decal-tool.ts';
import type { ReattachReport } from '../model/replace-part.ts';
import { reattachDecals, reseatChildren, swapPart } from '../model/replace-part.ts';
import type { Decal } from '../model/decals.ts';
import type { SurfacePoint } from '../geometry/geodesic.ts';

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
  // The press went to the decal tool.
  decal: boolean;
}

// The direction "sideways" completes the rocket frame: along the rocket
// (towards the tail), up, and sideways (towards the viewer in the side view).
export const SIDE_DIRECTION: Vec3 = cross(AFT_DIRECTION, WORLD_UP);

// The last move or rotate made with a gizmo, which the user can adjust by
// typing exact values, as in Blender's "Adjust Last Operation" panel. The
// values are that operation's own: how far it moved along each rocket
// direction, or how far it turned about which one; not coordinates.
export type LastOperation =
  | {
      kind: 'move';
      placedId: string;
      // The document before the operation, and the part's pose in it.
      before: AssemblyDocument;
      startPose: RigidTransform;
      along: number;
      up: number;
      side: number;
    }
  | {
      kind: 'rotate';
      placedId: string;
      before: AssemblyDocument;
      startPose: RigidTransform;
      pivot: Vec3;
      axis: 'along' | 'up' | 'side';
      degrees: number;
    }
  // Decal operations: how far the decal moved along and around the rocket
  // (mm on the surface), its angle from upright, its new size.
  | { kind: 'decal-move'; decalId: string; before: AssemblyDocument; start: Decal; along: number; around: number }
  | { kind: 'decal-rotate'; decalId: string; before: AssemblyDocument; start: Decal; degrees: number }
  | { kind: 'decal-scale'; decalId: string; before: AssemblyDocument; start: Decal; width: number; height: number };

export interface EditorEvents {
  // Something the panels show has changed.
  changed(): void;
  // Only what is drawn changed (a decal being dragged): the views redraw,
  // the panels (which show the committed document) need not.
  previewed?(): void;
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
  // The point the pointer is over on the flat page, shown in 3D.
  private readonly linkedMarker = new Markers(9, true, 0xffffff);
  // The surface point under the pointer in the 3D view, for the page to
  // show (null when the pointer is elsewhere).
  hoverPoint: SurfacePoint | null = null;
  // Where the linked marker is (world), for the test hook.
  linkedPoint: Vec3 | null = null;
  private readonly hoverListeners: Array<() => void> = [];

  readonly gizmo: PartGizmo;
  readonly decals: DecalTool;
  // Shift is down (free rotation and roll angle, finer steps).
  private shiftDown = false;
  lastOperation: LastOperation | null = null;
  // The committed pose of the selected part when a gizmo drag began.
  private gizmoStartPose: RigidTransform | null = null;

  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private press: Press | null = null;
  private updateQueued = false;
  private readonly listeners: EditorEvents[] = [];
  private readonly reporters: Array<(text: string) => void> = [];

  constructor(container: HTMLElement) {
    this.view = new View(container);
    this.view.overlayGroup.add(this.targetMarkers.points);
    this.view.overlayGroup.add(this.heldMarkers.points);
    this.view.overlayGroup.add(this.activeMarker.points);
    this.view.overlayGroup.add(this.linkedMarker.points);

    const self = this;
    this.gizmo = new PartGizmo(this.view, container, {
      preview: function preview(motion: RigidTransform) {
        self.gizmoPreview(motion);
      },
      commit: function commit(motion: RigidTransform) {
        self.gizmoCommit(motion);
      },
    });

    this.decals = new DecalTool(this, container);

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

  onHoverPoint(callback: () => void): void {
    this.hoverListeners.push(callback);
  }

  // The page's pointer, shown in 3D as a small dot (null hides it).
  showLinkedPoint(world: Vec3 | null): void {
    this.linkedPoint = world;
    if (world === null) {
      this.linkedMarker.setPositions([]);
    } else {
      this.linkedMarker.setPositions([world[0], world[1], world[2]]);
    }
    this.view.requestRender();
  }

  notify(): void {
    for (let i = 0; i < this.listeners.length; i++) {
      this.listeners[i].changed();
    }
  }

  // Something the user should be told in a few words (a toast).
  onReport(callback: (text: string) => void): void {
    this.reporters.push(callback);
  }

  report(text: string): void {
    for (let i = 0; i < this.reporters.length; i++) {
      this.reporters[i](text);
    }
  }

  // -------------------------------------------------------------------------
  // Parts and documents.

  // A loaded part. Listed in the parts list unless `listed` is false (a
  // part a project still uses, replaced in the list by a revised file).
  addPart(part: Part, listed = true): void {
    this.parts.set(part.id, part);
    if (listed && this.partOrder.indexOf(part.id) < 0) {
      this.partOrder.push(part.id);
    }
    this.geometries.set(part.id, makePartGeometry(part));
    this.notify();
  }

  // Forget everything: parts, artwork, the document and its history (New,
  // or before a project is opened).
  clearAll(): void {
    this.held = null;
    this.decals.reset();
    this.lastOperation = null;
    this.selectedId = null;
    this.chosenFace = null;
    this.hoverId = null;
    this.hoverFace = null;
    this.parts.clear();
    this.partOrder.length = 0;
    this.geometries.clear();
    const self = this;
    this.visuals.forEach(function remove(entry) {
      self.view.partsGroup.remove(entry.visual.group);
      entry.visual.dispose();
    });
    this.visuals.clear();
    this.history.reset(emptyDocument());
    this.tool = 'place';
    this.symmetryCount = 1;
    this.showCommitted();
  }

  // Show an opened project's document, with nothing to undo.
  loadDocument(doc: AssemblyDocument): void {
    this.history.reset(doc);
    this.lastOperation = null;
    this.selectedId = null;
    this.showCommitted();
  }

  // Replace a loaded part by a revised one (one undo step): every placed
  // part made from it keeps its place and takes the new geometry, and the
  // decals on them are put on the new surface. Returns what the user
  // should check.
  replacePart(oldPartId: string, newPart: Part): ReattachReport[] {
    const oldPart = requirePart(this.parts, oldPartId);
    this.cancelHeld();
    this.decals.cancel();
    // A fresh id, so undo can go back to the old part (kept loaded).
    let id = newPart.id;
    let suffix = 2;
    while (this.parts.has(id)) {
      id = newPart.id + '~' + String(suffix);
      suffix = suffix + 1;
    }
    newPart.id = id;
    this.parts.set(id, newPart);
    this.geometries.set(id, makePartGeometry(newPart));
    const listed = this.partOrder.indexOf(oldPartId);
    if (listed >= 0) {
      this.partOrder[listed] = id;
    } else {
      this.partOrder.push(id);
    }
    const before = this.history.document;
    const oldSurface = this.decals.surfaceFor(before);
    const swapped = swapPart(before, oldPartId, id, oldPart, newPart);
    const moved = new Set<string>();
    for (let i = 0; i < swapped.placed.length; i++) {
      if (swapped.placed[i].partId === id) {
        moved.add(swapped.placed[i].id);
      }
    }
    const newSurface = this.decals.surfaceFor(swapped);
    // What hangs on it stays attached where it was on it (a longer tube
    // pushes the part on its far end out).
    const reseated = reseatChildren(before, swapped, oldPartId, oldPart, newPart, this.parts, oldSurface, newSurface);
    const result = reattachDecals(reseated.doc, oldSurface, newSurface, moved);
    this.commit(result.doc);
    return result.report;
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

  // Every edit is one undo step. Any edit other than adjusting it ends the
  // last operation's panel.
  private commit(next: AssemblyDocument): void {
    this.lastOperation = null;
    this.decals.refreshAnchors(next);
    this.history.commit(next);
    this.showCommitted();
  }

  // For the decal tool: commit an edit (one undo step), with the operation
  // the adjust panel offers for it, if any.
  commitDocument(next: AssemblyDocument, operation: LastOperation | null): void {
    this.commit(next);
    this.lastOperation = operation;
    this.notify();
  }

  // Show a document without committing it (a decal being dragged).
  previewDocument(doc: AssemblyDocument): void {
    this.shown = doc;
    this.syncScene();
    for (let i = 0; i < this.listeners.length; i++) {
      const previewed = this.listeners[i].previewed;
      if (previewed !== undefined) {
        previewed.call(this.listeners[i]);
      }
    }
  }

  // Redraw from the committed document (after a cancelled drag, a new selection).
  redraw(): void {
    this.showCommitted();
  }

  // Select a placed part without touching the decal selection logic.
  selectPartOnly(placedId: string | null): void {
    this.selectedId = placedId;
    this.chosenFace = null;
  }

  // A decal was picked up from the list or duplicated: nothing else is held
  // or selected.
  decalHoldStarted(): void {
    this.lastOperation = null;
    if (this.held !== null) {
      this.held = null;
    }
    this.selectedId = null;
    this.chosenFace = null;
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
    this.lastOperation = null;
    this.cancelHeld();
    this.decals.cancelActive();
    if (this.history.undo()) {
      this.showCommitted();
    }
  }

  redo(): void {
    this.lastOperation = null;
    this.cancelHeld();
    this.decals.cancelActive();
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
        entry = { visual: new PartVisual(geometry, depthBiasOf(placed.id)), partId: placed.partId };
        this.visuals.set(placed.id, entry);
        this.view.partsGroup.add(entry.visual.group);
      }
      applyTransform(entry.visual.group, placed.transform);
      const colour = this.shown.partColours[placed.id];
      entry.visual.setColour(colour === undefined ? null : colour);
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
    this.decals.sync(this.shown);
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
      // The held part's own nodes, except while it stands on a surface,
      // where they mean nothing and only crowd the cursor.
      const onSurface = held.snap !== null && held.snap.kind === 'surface';
      if (heldPlaced !== null && !onSurface) {
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
    if (this.tool === 'face' && this.held === null && this.decals.selectedId !== null) {
      // A decal is centred on any visible part's face.
      for (let i = 0; i < this.shown.placed.length; i++) {
        const other = this.shown.placed[i];
        if (other.hidden) {
          continue;
        }
        const otherPart = requirePart(this.parts, other.partId);
        for (let f = 0; f < otherPart.attachFaces.length; f++) {
          wanted.push({ placedId: other.id, face: f });
        }
      }
      return wanted;
    }
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
      if (this.decals.selectedId !== null) {
        patch.setState(hovered ? 'hover' : 'idle');
      } else if (onSelected && this.chosenFace === ref.face) {
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
    this.lastOperation = null;
    this.cancelHeld();
    this.decals.cancelHeld();
    this.decals.selectedId = null;
    this.chosenFace = null;
    // While a new part is held nothing else is selected (as in KSP).
    this.selectedId = null;
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
    this.lastOperation = null;
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
      if (self.decals.isBusy()) {
        self.decals.pointerMove(self.decals.view3d, self.pointerX, self.pointerY, self.shiftDown);
        self.updateHover();
      } else if (self.held !== null) {
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
        let hit = pickPart(committed, this.parts, ray.origin, ray.direction, moving);
        if (hit !== null && !this.shiftDown) {
          hit = this.snapRoll(hit, moving);
        }
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

  // KSP's angle snap for parts on the side of another: the roll angle about
  // the rocket axis goes to the nearest 15 degrees from straight up. The
  // point is found again by casting a ray at the axis from that angle, at
  // the same station, so it lands on the surface whatever its shape. If that
  // ray finds nothing on the same part, the unsnapped point stands.
  private snapRoll(hit: PartHit, moving: Set<string>): PartHit {
    const relative = sub(hit.point, AXIS_ORIGIN);
    const station = dot(relative, AFT_DIRECTION);
    const radial = sub(relative, scale(AFT_DIRECTION, station));
    const radius = Math.hypot(radial[0], radial[1], radial[2]);
    if (radius < 1e-6) {
      return hit;
    }
    // Angle from straight up, turning about the aft direction.
    const side = cross(AFT_DIRECTION, WORLD_UP);
    const angle = Math.atan2(dot(radial, side), dot(radial, WORLD_UP));
    const step = (15 * Math.PI) / 180;
    const snapped = Math.round(angle / step) * step;
    const outward = add(scale(WORLD_UP, Math.cos(snapped)), scale(side, Math.sin(snapped)));
    const axisPoint = add(AXIS_ORIGIN, scale(AFT_DIRECTION, station));
    const far = radius + 1000;
    const origin = add(axisPoint, scale(outward, far));
    const inward = scale(outward, -1);
    const again = pickPart(this.history.document, this.parts, origin, inward, moving);
    if (again === null || again.placedId !== hit.placedId) {
      return hit;
    }
    return again;
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
      let decalCursor: string | null = null;
      if (this.tool !== 'face' && !this.gizmo.hovered()) {
        decalCursor = this.decals.cursorAt(this.decals.view3d, this.pointerX, this.pointerY);
      }
      if (this.gizmo.hovered()) {
        cursor = this.tool === 'move' ? 'move' : 'grab';
        hoverId = null;
      } else if (decalCursor !== null) {
        cursor = decalCursor;
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
    let hoverPoint: SurfacePoint | null = null;
    if (this.pointerInside) {
      hoverPoint = this.decals.surfaceUnder3d(this.pointerX, this.pointerY);
    }
    if (hoverPoint !== null || this.hoverPoint !== null) {
      this.hoverPoint = hoverPoint;
      for (let i = 0; i < this.hoverListeners.length; i++) {
        this.hoverListeners[i]();
      }
    }
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
    if (event.button === 0 && this.held === null && this.tool !== 'face' && !this.gizmo.hovered()) {
      // Decals first: they lie on top of the parts.
      if (this.decals.pointerDown(this.decals.view3d, event.clientX, event.clientY)) {
        this.view.controls.enabled = false;
        this.press = { x: event.clientX, y: event.clientY, button: event.button, onPart: null, moved: false, decal: true };
        this.notify();
        return;
      }
    }
    if (event.button === 0 && this.held === null) {
      // The gizmo handles its own presses.
      if (this.gizmo.hovered()) {
        // The orbit controls must not turn the view while a handle is dragged.
        this.view.controls.enabled = false;
        this.press = { x: event.clientX, y: event.clientY, button: event.button, onPart: null, moved: true, decal: false };
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
    this.press = { x: event.clientX, y: event.clientY, button: event.button, onPart: onPart, moved: false, decal: false };
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
        const grabbable = this.tool === 'place' && press.button === 0 && !press.decal && press.onPart !== null && press.onPart !== this.history.document.rootId;
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
    if (event.button === 0 && (this.decals.isBusy() || (press !== null && press.decal))) {
      this.pointerX = event.clientX;
      this.pointerY = event.clientY;
      // Bring a drag up to the release point before letting go.
      this.decals.pointerMove(this.decals.view3d, event.clientX, event.clientY, event.shiftKey);
      if (this.decals.pointerUp(this.decals.view3d, event.clientX, event.clientY, overCanvas)) {
        this.updateHover();
        this.notify();
        return;
      }
    }
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
    this.lastOperation = null;
    this.decals.selectedId = null;
    this.selectedId = placedId;
    this.chosenFace = null;
    this.syncScene();
    this.notify();
  }

  // Escape or right click: put what is held back where it came from, or
  // forget the chosen face, or clear the selection.
  private cancel(): void {
    if (this.decals.cancel()) {
      this.notify();
      return;
    }
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
    if (this.decals.selectedId !== null) {
      // Place on face for a decal: one click, the decal is centred there.
      if (faceUnder !== null) {
        this.decals.centreOnFace(faceUnder.placedId, faceUnder.face);
      } else {
        const decalHit = this.decals.decalUnder(clientX, clientY);
        if (decalHit !== null) {
          this.decals.select(decalHit.id);
        } else {
          this.select(onPart);
        }
      }
      return;
    }
    const decalHit = this.decals.decalUnder(clientX, clientY);
    if (decalHit !== null && this.chosenFace === null) {
      this.decals.select(decalHit.id);
      this.notify();
      return;
    }
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
    const placedId = this.selectedId;
    const before = this.history.document;
    const pose = compose(motion, start);
    this.commit(movePart(before, placedId, pose));
    this.lastOperation = describeOperation(this.tool, placedId, before, start, motion, this.gizmo.pivotPoint());
    this.notify();
  }

  // Re-do the last operation with exact values typed by the user: for a
  // move [along, up, side] in mm, for a rotate [degrees]. It replaces the
  // operation (one undo step), it does not add to it.
  adjustLastOperation(values: number[], axis?: 'along' | 'up' | 'side'): void {
    const operation = this.lastOperation;
    if (operation === null) {
      return;
    }
    if (operation.kind === 'decal-move' || operation.kind === 'decal-rotate' || operation.kind === 'decal-scale') {
      const next = this.decals.adjust(operation, values);
      if (next !== null) {
        this.decals.refreshAnchors(next);
        this.history.replace(next);
        this.showCommitted();
      }
      return;
    }
    let motion: RigidTransform;
    if (operation.kind === 'move') {
      if (values.length !== 3) {
        throw new Error('adjustLastOperation: a move takes 3 values, got ' + String(values.length));
      }
      operation.along = values[0];
      operation.up = values[1];
      operation.side = values[2];
      const alongPart = scale(AFT_DIRECTION, values[0]);
      const upPart = scale(WORLD_UP, values[1]);
      const sidePart = scale(SIDE_DIRECTION, values[2]);
      motion = { position: add(add(alongPart, upPart), sidePart), rotation: [0, 0, 0, 1] };
    } else {
      if (values.length !== 1) {
        throw new Error('adjustLastOperation: a rotate takes 1 value, got ' + String(values.length));
      }
      operation.degrees = values[0];
      if (axis !== undefined) {
        // As Blender's panel: the axis can be changed after the fact.
        operation.axis = axis;
      }
      const direction = rocketDirection(operation.axis);
      motion = rotationAboutLine(operation.pivot, direction, (values[0] * Math.PI) / 180);
    }
    const pose = compose(motion, operation.startPose);
    this.history.replace(movePart(operation.before, operation.placedId, pose));
    this.showCommitted();
  }

  private setModifiers(shift: boolean, ctrl: boolean): void {
    this.shiftDown = shift;
    this.gizmo.setModifiers(shift, ctrl);
    if (!this.gizmo.dragging) {
      this.gizmoStartPose = null;
    }
  }

  // -------------------------------------------------------------------------
  // Commands (toolbar, keys, panels).

  setTool(tool: Tool): void {
    this.lastOperation = null;
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
    if (this.decals.selectedId !== null && this.held === null && !this.decals.isBusy()) {
      // With a decal selected, ×N is the decal's: copies round the rocket.
      this.decals.stepSymmetry(direction);
      return;
    }
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
    let min: Vec3 = [-500, -100, -100];
    let max: Vec3 = [200, 100, 100];
    if (bounds !== null) {
      // At least 100 mm each way, so a single small part is not filled edge to edge.
      const centre = scale(add(bounds.min, bounds.max), 0.5);
      const half = scale(sub(bounds.max, bounds.min), 0.5);
      const reach: Vec3 = [Math.max(50, half[0]), Math.max(50, half[1]), Math.max(50, half[2])];
      min = sub(centre, reach);
      max = add(centre, reach);
    }
    if (preset === 'fit') {
      this.view.fit(min, max);
      return;
    }
    this.view.setPreset(preset, min, max);
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
    if (command && key === 'd') {
      // Duplicate the selected decal: the copy follows the cursor.
      event.preventDefault();
      this.decals.duplicateSelected();
      this.notify();
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
      if (!this.decals.deleteSelected()) {
        this.deleteSelected();
      }
      return;
    }
    if (this.decals.selectedId !== null && key === 'm') {
      // Mirror the selected decal to the other side (or stop mirroring it).
      this.decals.toggleMirror();
      return;
    }
    if (this.decals.selectedId !== null && (key === 'h' || key === 'v')) {
      // Flip horizontally or vertically (Inkscape's keys).
      this.decals.flipSelected(key === 'h' ? 'x' : 'y');
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

  // The visible parts as they are drawn: mesh, pose and preview colour
  // (for the model export).
  visibleMeshes(): Array<{ geometry: PartGeometry['mesh']; transform: RigidTransform; colour: string | null }> {
    const result: Array<{ geometry: PartGeometry['mesh']; transform: RigidTransform; colour: string | null }> = [];
    const doc = this.history.document;
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      const geometry = this.geometries.get(placed.partId);
      if (placed.hidden || geometry === undefined) {
        continue;
      }
      const colour = doc.partColours[placed.id];
      result.push({ geometry: geometry.mesh, transform: placed.transform, colour: colour === undefined ? null : colour });
    }
    return result;
  }

  // A PNG of the 3D view without handles, markers or the gizmo.
  viewPicture(scale: number, transparent: boolean): Promise<Blob> {
    const hide: THREE.Object3D[] = [this.view.overlayGroup];
    const gizmoObjects = this.gizmo.sceneObjects();
    for (let i = 0; i < gizmoObjects.length; i++) {
      hide.push(gizmoObjects[i]);
    }
    return this.view.snapshot(scale, transparent, hide);
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

// A fixed depth bias per placed part, from its id ("p12" -> 12 mod 4), so it
// never changes from frame to frame.
function depthBiasOf(placedId: string): number {
  const number = parseInt(placedId.replace(/\D/g, ''), 10);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return number % 4;
}

function rocketDirection(name: 'along' | 'up' | 'side'): Vec3 {
  if (name === 'along') {
    return AFT_DIRECTION;
  }
  if (name === 'up') {
    return WORLD_UP;
  }
  return SIDE_DIRECTION;
}

// What a finished gizmo drag did, in the rocket's own terms.
function describeOperation(
  tool: Tool,
  placedId: string,
  before: AssemblyDocument,
  startPose: RigidTransform,
  motion: RigidTransform,
  pivot: Vec3,
): LastOperation {
  if (tool === 'move') {
    const offset = motion.position;
    return {
      kind: 'move',
      placedId: placedId,
      before: before,
      startPose: startPose,
      along: dot(offset, AFT_DIRECTION),
      up: dot(offset, WORLD_UP),
      side: dot(offset, SIDE_DIRECTION),
    };
  }
  // The gizmo turns about one world axis at a time; find which, and the
  // signed angle about the matching rocket direction.
  const q = motion.rotation;
  const angle = quatAngle(q);
  const names: Array<'along' | 'up' | 'side'> = ['along', 'up', 'side'];
  let bestName: 'along' | 'up' | 'side' = 'along';
  let bestComponent = 0;
  for (let i = 0; i < names.length; i++) {
    const direction = rocketDirection(names[i]);
    const component = q[0] * direction[0] + q[1] * direction[1] + q[2] * direction[2];
    if (Math.abs(component) > Math.abs(bestComponent)) {
      bestComponent = component;
      bestName = names[i];
    }
  }
  // quatAngle uses |w|; the sign of the vector part along the axis (times
  // the sign of w) says which way round.
  let sign = bestComponent >= 0 ? 1 : -1;
  if (q[3] < 0) {
    sign = -sign;
  }
  return {
    kind: 'rotate',
    placedId: placedId,
    before: before,
    startPose: startPose,
    pivot: pivot,
    axis: bestName,
    degrees: (sign * angle * 180) / Math.PI,
  };
}

function memberIds(doc: AssemblyDocument, placedId: string): string[] {
  const members = symmetryMembers(doc, placedId);
  const ids: string[] = [];
  for (let i = 0; i < members.length; i++) {
    ids.push(members[i].id);
  }
  return ids;
}
