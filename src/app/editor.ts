// The assembly editor: what happens when the user points, clicks, drags and
// presses keys in the 3D view. Behaviour follows the KSP vehicle editor
// (pick a part, it follows the cursor, it snaps on, click drops it) and the
// slicers' "place on face" tool.
//
// State lives in two places:
//   - history.document: the committed assembly (what undo steps through);
//   - shown: what is drawn right now. While a part is held or a gizmo is
//     dragged, `shown` is a preview made from the committed document by the
//     same operations a drop would commit, so what you see is what you get.

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { AttachFace, Part } from '../geometry/part.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import { add, cross, dot, length, normalize, scale, sub } from '../geometry/vec3.ts';
import type { Quat, RigidTransform } from '../geometry/transform.ts';
import {
  applyToDirection,
  applyToPoint,
  invert,
  multiplyQuat,
  quatFromAxisAngle,
  quatFromUnitVectors,
  rotateVector,
} from '../geometry/transform.ts';
import { attachToSurface, distanceFromAxis, mateFaces, placeRoot, symmetryTransforms } from '../geometry/mating.ts';
import { AFT_DIRECTION, NOSE_DIRECTION } from '../geometry/rocket-axis.ts';
import { raycast } from '../geometry/bvh.ts';
import type { AssemblyDocument, Joint, PlacedPart } from '../model/document.ts';
import {
  addParts,
  cloneDocument,
  emptyDocument,
  findPlaced,
  movePart,
  rememberAttachFace,
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

export type Tool = 'place' | 'move' | 'rotate' | 'face';

export const symmetryChoices = [1, 2, 3, 4, 6, 8];

// Screen distances for stack snapping, in CSS pixels. A node pair snaps
// when the held node comes within snapEnter of a free node, and stays
// snapped until it is moved farther than snapExit (hysteresis: no flicker at
// the edge).
const snapEnter = 30;
const snapExit = 55;
// A press that moves less than this is a click, not a drag.
const clickSlop = 5;

type Snap =
  | { kind: 'root' }
  | { kind: 'stack'; targetId: string; targetFace: number; ownFace: number }
  | { kind: 'surface'; targetId: string; point: Vec3; normal: Vec3 };

interface Held {
  partId: string;
  // When an existing part was picked up: its id. Null for a new part.
  pickedId: string | null;
  // Orientation while floating (the user can turn it with Q/E/W/S/A/D).
  floatingRotation: Quat;
  // From the cursor's point on the work plane to the attach face centre.
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

interface PartHit {
  placedId: string;
  point: Vec3;
  normal: Vec3;
  distance: number;
}

interface PatchRef {
  placedId: string;
  face: number;
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
  angleSnap = true;
  selectedId: string | null = null;
  private held: Held | null = null;
  // Place on face: the face chosen on the selected part, waiting for a target.
  private chosenFace: number | null = null;

  private hoverId: string | null = null;
  private hoverPatch: PatchRef | null = null;
  private readonly patches = new Map<string, FacePatch>();
  private readonly targetMarkers = new Markers(13, false, accent);
  private readonly heldMarkers = new Markers(9, false, 0xffffff);
  private readonly activeMarker = new Markers(17, true, accent);

  private readonly gizmo: TransformControls;
  private readonly gizmoProxy = new THREE.Object3D();
  private gizmoStart: RigidTransform | null = null;

  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private press: { x: number; y: number; button: number; onPart: string | null; moved: boolean } | null = null;
  private shiftDown = false;
  private ctrlDown = false;
  private updateQueued = false;
  private readonly listeners: EditorEvents[] = [];

  constructor(container: HTMLElement) {
    this.view = new View(container);
    this.view.overlayGroup.add(this.targetMarkers.points);
    this.view.overlayGroup.add(this.heldMarkers.points);
    this.view.overlayGroup.add(this.activeMarker.points);

    this.gizmo = new TransformControls(this.view.camera, this.view.canvas);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(0.8);
    this.view.scene.add(this.gizmoProxy);
    this.view.scene.add(this.gizmo.getHelper());
    this.applyAngleSnap();
    const self = this;
    this.gizmo.addEventListener('dragging-changed', function onDragging(event) {
      const dragging = (event as unknown as { value: boolean }).value;
      self.view.controls.enabled = !dragging;
      if (dragging) {
        self.gizmoStart = self.proxyTransform();
      } else {
        self.finishGizmoDrag();
      }
    });
    this.gizmo.addEventListener('objectChange', function onGizmoMove() {
      self.gizmoMoved();
    });
    this.gizmo.addEventListener('change', function onGizmoChange() {
      self.view.requestRender();
    });

    const canvas = this.view.canvas;
    // Capture phase: these run before the orbit controls' own listeners, so
    // a press that picks or drops a part can switch orbiting off first.
    canvas.addEventListener('pointerdown', function down(event) {
      self.onPointerDown(event);
    }, true);
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
      self.shiftDown = event.shiftKey;
      self.ctrlDown = event.ctrlKey || event.metaKey;
      self.applyAngleSnap();
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

  heldPartId(): string | null {
    if (this.held === null) {
      return null;
    }
    return this.held.partId;
  }

  private requirePart(partId: string): Part {
    const part = this.parts.get(partId);
    if (part === undefined) {
      throw new Error('expected a loaded part with id ' + partId);
    }
    return part;
  }

  // The attach face of a source part: the user's choice, else the guess.
  attachFaceOf(partId: string): number {
    const chosen = this.history.document.attachFaceByPart[partId];
    if (chosen !== undefined) {
      return chosen;
    }
    return this.requirePart(partId).guessedAttachFace;
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

  private updateHighlights(): void {
    const selected = new Set<string>();
    if (this.selectedId !== null && findPlaced(this.shown, this.selectedId) !== null && this.held === null) {
      const members = symmetryMembers(this.shown, this.selectedId);
      for (let i = 0; i < members.length; i++) {
        selected.add(members[i].id);
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
    const hoverId = this.hoverId;
    const shown = this.shown;
    this.visuals.forEach(function setHighlight(entry, id) {
      let highlight: Highlight = 'none';
      if (selected.has(id)) {
        highlight = 'selected';
      } else if (hoverId !== null && id === hoverId) {
        highlight = 'hover';
      }
      // Hover lights the whole symmetry set, as selection does.
      if (highlight === 'none' && hoverId !== null && findPlaced(shown, hoverId) !== null) {
        const placed = findPlaced(shown, id);
        const hovered = findPlaced(shown, hoverId);
        if (placed !== null && hovered !== null && placed.symmetry !== null && hovered.symmetry !== null) {
          if (placed.symmetry.group === hovered.symmetry.group) {
            highlight = 'hover';
          }
        }
      }
      entry.visual.setHighlight(highlight);
      entry.visual.setFloating(heldIds.has(id) && floating);
    });
  }

  // The world position of a placed part's attach face.
  worldFace(placed: PlacedPart, faceIndex: number): AttachFace {
    const part = this.requirePart(placed.partId);
    const face = part.attachFaces[faceIndex];
    const outline: Vec3[] = [];
    for (let i = 0; i < face.outline.length; i++) {
      outline.push(applyToPoint(placed.transform, face.outline[i]));
    }
    return {
      normal: applyToDirection(placed.transform, face.normal),
      centre: applyToPoint(placed.transform, face.centre),
      outline: outline,
      area: face.area,
      radius: face.radius,
      longDirection: applyToDirection(placed.transform, face.longDirection),
    };
  }

  // Attach faces already used by a joint, per placed part.
  private usedFaces(doc: AssemblyDocument): Map<string, Set<number>> {
    const used = new Map<string, Set<number>>();
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      if (placed.joint === null) {
        continue;
      }
      const own = used.get(placed.id) ?? new Set<number>();
      own.add(placed.joint.ownFace);
      used.set(placed.id, own);
      if (placed.parentId !== null && placed.joint.parentFace !== null) {
        const parentSet = used.get(placed.parentId) ?? new Set<number>();
        parentSet.add(placed.joint.parentFace);
        used.set(placed.parentId, parentSet);
      }
    }
    return used;
  }

  // Free attach nodes of visible parts that are not moving with the held part.
  private freeNodes(): PatchRef[] {
    const nodes: PatchRef[] = [];
    const doc = this.shown;
    const used = this.usedFaces(doc);
    const excluded = new Set<string>();
    if (this.held !== null) {
      for (let i = 0; i < this.held.shownIds.length; i++) {
        excluded.add(this.held.shownIds[i]);
      }
    }
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      if (placed.hidden || excluded.has(placed.id)) {
        continue;
      }
      const part = this.requirePart(placed.partId);
      const usedHere = used.get(placed.id);
      for (let f = 0; f < part.attachFaces.length; f++) {
        if (usedHere !== undefined && usedHere.has(f)) {
          continue;
        }
        nodes.push({ placedId: placed.id, face: f });
      }
    }
    return nodes;
  }

  private updateMarkers(): void {
    const targets: number[] = [];
    const heldPoints: number[] = [];
    const active: number[] = [];
    // Nodes show only while a part is held, and not for the root (it has
    // nothing to attach to).
    const heldSnap = this.held === null ? null : this.held.snap;
    const placingRoot = heldSnap !== null && heldSnap.kind === 'root';
    if (this.held !== null && !placingRoot) {
      const nodes = this.freeNodes();
      for (let i = 0; i < nodes.length; i++) {
        const placed = requirePlaced(this.shown, nodes[i].placedId);
        const centre = this.worldFace(placed, nodes[i].face).centre;
        targets.push(centre[0], centre[1], centre[2]);
      }
      const heldPlaced = findPlaced(this.shown, this.held.shownIds[0]);
      if (heldPlaced !== null) {
        const part = this.requirePart(heldPlaced.partId);
        for (let f = 0; f < part.attachFaces.length; f++) {
          const centre = this.worldFace(heldPlaced, f).centre;
          heldPoints.push(centre[0], centre[1], centre[2]);
        }
      }
      const snap = this.held.snap;
      if (snap !== null && snap.kind === 'stack') {
        const target = requirePlaced(this.shown, snap.targetId);
        const centre = this.worldFace(target, snap.targetFace).centre;
        active.push(centre[0], centre[1], centre[2]);
      }
    }
    this.targetMarkers.setPositions(targets);
    this.heldMarkers.setPositions(heldPoints);
    this.activeMarker.setPositions(active);
  }

  // The face patches place on face shows.
  private wantedPatches(): PatchRef[] {
    const wanted: PatchRef[] = [];
    if (this.tool !== 'face' || this.held !== null || this.selectedId === null) {
      return wanted;
    }
    const selected = findPlaced(this.shown, this.selectedId);
    if (selected === null || selected.hidden) {
      return wanted;
    }
    const part = this.requirePart(selected.partId);
    for (let f = 0; f < part.attachFaces.length; f++) {
      wanted.push({ placedId: selected.id, face: f });
    }
    if (this.chosenFace !== null) {
      // Targets: faces of every other visible part not moving with this one.
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
        const otherPart = this.requirePart(other.partId);
        for (let f = 0; f < otherPart.attachFaces.length; f++) {
          wanted.push({ placedId: other.id, face: f });
        }
      }
    }
    return wanted;
  }

  private updatePatches(): void {
    const wanted = this.wantedPatches();
    const keep = new Set<string>();
    for (let i = 0; i < wanted.length; i++) {
      const ref = wanted[i];
      const placed = requirePlaced(this.shown, ref.placedId);
      // The key includes the pose, so a moved part gets fresh patches.
      const key = ref.placedId + ':' + String(ref.face) + ':' + JSON.stringify(placed.transform);
      keep.add(key);
      let patch = this.patches.get(key);
      if (patch === undefined) {
        patch = new FacePatch(this.worldFace(placed, ref.face));
        this.patches.set(key, patch);
        this.view.overlayGroup.add(patch.group);
      }
      const onSelected = ref.placedId === this.selectedId;
      const hovered = this.hoverPatch !== null && this.hoverPatch.placedId === ref.placedId && this.hoverPatch.face === ref.face;
      if (onSelected && this.chosenFace === ref.face) {
        patch.setState('chosen');
      } else if (hovered) {
        patch.setState('hover');
      } else if (onSelected) {
        patch.setState(this.chosenFace === null ? 'idle' : 'dim');
      } else {
        patch.setState('dim');
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

  private updateGizmo(): void {
    const show = (this.tool === 'move' || this.tool === 'rotate') && this.held === null && this.selectedId !== null;
    if (!show || this.selectedId === null) {
      this.gizmo.detach();
      return;
    }
    const placed = findPlaced(this.shown, this.selectedId);
    if (placed === null || placed.hidden) {
      this.gizmo.detach();
      return;
    }
    if (this.gizmo.dragging) {
      return;
    }
    this.gizmo.setMode(this.tool === 'move' ? 'translate' : 'rotate');
    applyTransform(this.gizmoProxy, placed.transform);
    if (this.gizmo.object !== this.gizmoProxy) {
      this.gizmo.attach(this.gizmoProxy);
    }
  }

  // -------------------------------------------------------------------------
  // Picking.

  private pickPart(origin: Vec3, direction: Vec3, exclude: Set<string>): PartHit | null {
    let best: PartHit | null = null;
    for (let i = 0; i < this.shown.placed.length; i++) {
      const placed = this.shown.placed[i];
      if (placed.hidden || exclude.has(placed.id)) {
        continue;
      }
      const part = this.requirePart(placed.partId);
      // Into the part's frame; rigid, so distances are unchanged.
      const toLocal = invert(placed.transform);
      const localOrigin = applyToPoint(toLocal, origin);
      const localDirection = applyToDirection(toLocal, direction);
      const limit = best === null ? Infinity : best.distance;
      const hit = raycast(part.bvh, part.positions, part.indices, localOrigin, localDirection, limit);
      if (hit === null) {
        continue;
      }
      // Smooth normal: the CAD normals at the triangle's corners, averaged.
      const t = hit.triangle;
      let normal: Vec3 = [0, 0, 0];
      for (let corner = 0; corner < 3; corner++) {
        const vertex = part.indices[3 * t + corner];
        normal = add(normal, [part.normals[3 * vertex], part.normals[3 * vertex + 1], part.normals[3 * vertex + 2]]);
      }
      if (length(normal) === 0) {
        continue;
      }
      let worldNormal = normalize(applyToDirection(placed.transform, normal));
      // Facing the viewer: on a thin wall the ray may hit the inside.
      if (dot(worldNormal, direction) > 0) {
        worldNormal = scale(worldNormal, -1);
      }
      const point = add(origin, scale(direction, hit.distance));
      best = { placedId: placed.id, point: point, normal: worldNormal, distance: hit.distance };
    }
    return best;
  }

  // The nearest offered patch under the ray.
  private pickPatch(origin: Vec3, direction: Vec3, refs: PatchRef[]): PatchRef | null {
    let best: PatchRef | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < refs.length; i++) {
      const placed = requirePlaced(this.shown, refs[i].placedId);
      const face = this.worldFace(placed, refs[i].face);
      const along = dot(direction, face.normal);
      if (Math.abs(along) < 1e-6) {
        continue;
      }
      const distance = dot(sub(face.centre, origin), face.normal) / along;
      if (distance <= 0 || distance >= bestDistance) {
        continue;
      }
      const point = add(origin, scale(direction, distance));
      if (insideConvex(face.outline, face.normal, point)) {
        best = refs[i];
        bestDistance = distance;
      }
    }
    return best;
  }

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

  // -------------------------------------------------------------------------
  // Holding parts.

  // The orientation a new part is held in: a section (attach face round)
  // with its attach face aft, so it lines up with the rocket; anything else
  // (a fin) standing on its attach face with its long side along the axis.
  private holdingRotation(partId: string): Quat {
    const part = this.requirePart(partId);
    const faceIndex = this.attachFaceOf(partId);
    if (faceIndex < 0) {
      return [0, 0, 0, 1];
    }
    const face = part.attachFaces[faceIndex];
    if (face.radius !== null) {
      return quatFromUnitVectors(face.normal, AFT_DIRECTION);
    }
    const down: Vec3 = [0, -1, 0];
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
    this.held = {
      partId: partId,
      pickedId: null,
      floatingRotation: this.holdingRotation(partId),
      grabOffset: [0, 0, 0],
      roll: 0,
      snap: null,
      dragging: false,
      shownIds: [],
      pose: { position: [0, 0, 0], rotation: this.holdingRotation(partId) },
    };
    this.updateHeld();
    this.notify();
  }

  // Pick up a placed part (and its children, and its symmetry set).
  private pickUp(placedId: string, dragging: boolean): void {
    const placed = requirePlaced(this.history.document, placedId);
    const faceIndex = this.attachFaceOf(placed.partId);
    let anchor = placed.transform.position;
    if (faceIndex >= 0) {
      anchor = this.worldFace(placed, faceIndex).centre;
    }
    const ray = this.view.rayAt(this.pointerX, this.pointerY);
    const onPlane = this.workPlanePoint(ray.origin, ray.direction);
    // Keep the part where it is under the cursor: the anchor stays at the
    // same offset from the cursor's point on the work plane.
    const grabOffset = sub(anchor, onPlane);
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

  // How many copies a placement makes.
  private copiesFor(snap: Snap | null, held: Held): number {
    if (held.pickedId !== null) {
      return 1; // movePart carries the symmetry set of a picked-up part
    }
    if (snap === null || snap.kind === 'root') {
      return 1;
    }
    if (snap.kind === 'stack') {
      const target = requirePlaced(this.history.document, snap.targetId);
      const centre = this.worldFace(target, snap.targetFace).centre;
      // A section stacked on the axis has nowhere to put copies.
      if (distanceFromAxis(centre) < 0.5) {
        return 1;
      }
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
    const part = this.requirePart(held.partId);
    const faceIndex = this.attachFaceOf(held.partId);
    let attachCentre: Vec3 = [
      (part.boundsMin[0] + part.boundsMax[0]) / 2,
      (part.boundsMin[1] + part.boundsMax[1]) / 2,
      (part.boundsMin[2] + part.boundsMax[2]) / 2,
    ];
    if (faceIndex >= 0) {
      attachCentre = part.attachFaces[faceIndex].centre;
    }
    const ray = this.view.rayAt(this.pointerX, this.pointerY);
    const onPlane = add(this.workPlanePoint(ray.origin, ray.direction), held.grabOffset);
    const floatingPose: RigidTransform = {
      rotation: held.floatingRotation,
      position: sub(onPlane, rotateVector(held.floatingRotation, attachCentre)),
    };

    // The parts the held part can attach to: committed, visible, and not
    // moving with it.
    const moving = new Set<string>();
    if (held.pickedId !== null) {
      const members = symmetryMembers(committed, held.pickedId);
      for (let m = 0; m < members.length; m++) {
        const subtree = subtreeIds(committed, members[m].id);
        for (let k = 0; k < subtree.length; k++) {
          moving.add(subtree[k]);
        }
      }
    }
    const becomesRoot = committed.rootId === null || committed.rootId === held.pickedId;

    let snap: Snap | null = null;
    let pose = floatingPose;
    if (becomesRoot) {
      snap = { kind: 'root' };
      if (faceIndex >= 0) {
        pose = placeRoot(part.attachFaces[faceIndex], floatingPose, held.roll);
      }
    } else {
      snap = this.findStackSnap(held, floatingPose, moving);
      if (snap !== null && snap.kind === 'stack') {
        const target = requirePlaced(committed, snap.targetId);
        const targetFace = this.worldFace(target, snap.targetFace);
        pose = mateFaces(part.attachFaces[snap.ownFace], floatingPose, targetFace.centre, targetFace.normal, held.roll);
      } else if (faceIndex >= 0 && this.pointerInside) {
        const hit = this.pickPart(ray.origin, ray.direction, moving);
        if (hit !== null) {
          snap = { kind: 'surface', targetId: hit.placedId, point: hit.point, normal: hit.normal };
          pose = attachToSurface(part.attachFaces[faceIndex], partCentre(part), floatingPose, hit.point, hit.normal, held.roll);
        }
      }
    }
    held.snap = snap;
    held.pose = pose;

    // Build the preview exactly as a drop would.
    const preview = this.placementResult(held, pose, snap);
    this.shown = preview.doc;
    held.shownIds = preview.movingIds;
    this.syncScene();
  }

  // Stack snap: the held part's attach nodes against the free nodes of the
  // rocket, by distance on screen. A pair whose discs have the same radius
  // (a nose base onto a tube end) is preferred over one that does not (the
  // nose's shoulder end onto the tube end), so sections join the way they
  // are meant to.
  private findStackSnap(held: Held, floatingPose: RigidTransform, moving: Set<string>): Snap | null {
    const part = this.requirePart(held.partId);
    if (part.attachFaces.length === 0) {
      return null;
    }
    const committed = this.history.document;
    const used = this.usedFaces(committed);
    interface Pair {
      targetId: string;
      targetFace: number;
      ownFace: number;
      distance: number;
      matched: boolean;
    }
    const pairs: Pair[] = [];
    const heldScreen: Array<{ x: number; y: number; inFront: boolean }> = [];
    for (let f = 0; f < part.attachFaces.length; f++) {
      heldScreen.push(this.view.toScreen(applyToPoint(floatingPose, part.attachFaces[f].centre)));
    }
    for (let i = 0; i < committed.placed.length; i++) {
      const target = committed.placed[i];
      if (target.hidden || moving.has(target.id)) {
        continue;
      }
      const targetPart = this.requirePart(target.partId);
      const usedHere = used.get(target.id);
      for (let t = 0; t < targetPart.attachFaces.length; t++) {
        if (usedHere !== undefined && usedHere.has(t)) {
          continue;
        }
        const targetFace = targetPart.attachFaces[t];
        const screen = this.view.toScreen(applyToPoint(target.transform, targetFace.centre));
        if (!screen.inFront) {
          continue;
        }
        for (let f = 0; f < part.attachFaces.length; f++) {
          const own = part.attachFaces[f];
          const distance = Math.hypot(heldScreen[f].x - screen.x, heldScreen[f].y - screen.y);
          let matched = false;
          if (own.radius !== null && targetFace.radius !== null) {
            matched = Math.abs(own.radius - targetFace.radius) <= 0.02 * targetFace.radius;
          }
          pairs.push({ targetId: target.id, targetFace: t, ownFace: f, distance: distance, matched: matched });
        }
      }
    }
    // Hysteresis: keep the current pair while it is within snapExit, unless
    // a better kind of pair (matched radius) has come within snapEnter.
    const current = held.snap;
    let kept: Pair | null = null;
    if (current !== null && current.kind === 'stack') {
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        if (pair.targetId === current.targetId && pair.targetFace === current.targetFace && pair.ownFace === current.ownFace) {
          if (pair.distance < snapExit) {
            kept = pair;
          }
        }
      }
    }
    let best: Pair | null = null;
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      if (pair.distance > snapEnter) {
        continue;
      }
      if (best === null) {
        best = pair;
      } else if (pair.matched && !best.matched) {
        best = pair;
      } else if (pair.matched === best.matched && pair.distance < best.distance) {
        best = pair;
      }
    }
    let chosen: Pair | null = kept;
    if (best !== null) {
      if (kept === null) {
        chosen = best;
      } else if (best.matched && !kept.matched) {
        chosen = best;
      }
    }
    if (chosen === null) {
      return null;
    }
    return { kind: 'stack', targetId: chosen.targetId, targetFace: chosen.targetFace, ownFace: chosen.ownFace };
  }

  // The document a drop would commit, and the ids that move with the held part.
  private placementResult(held: Held, pose: RigidTransform, snap: Snap | null): { doc: AssemblyDocument; movingIds: string[]; addedIds: string[] } {
    const committed = this.history.document;
    let parentId: string | null = null;
    let joint: Joint | null = null;
    const faceIndex = this.attachFaceOf(held.partId);
    if (snap !== null && snap.kind === 'stack') {
      parentId = snap.targetId;
      joint = { ownFace: snap.ownFace, parentFace: snap.targetFace };
    } else if (snap !== null && snap.kind === 'surface') {
      parentId = snap.targetId;
      joint = { ownFace: faceIndex, parentFace: null };
    } else if (snap !== null && snap.kind === 'root' && faceIndex >= 0) {
      joint = null;
    }
    if (held.pickedId === null) {
      const count = this.copiesFor(snap, held);
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
      member.joint = joint === null ? null : { ownFace: joint.ownFace, parentFace: joint.parentFace };
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
  // Hover.

  private updateHover(): void {
    let hoverId: string | null = null;
    let hoverPatch: PatchRef | null = null;
    let cursor = 'default';
    if (this.pointerInside && !this.gizmo.dragging) {
      const ray = this.view.rayAt(this.pointerX, this.pointerY);
      if (this.tool === 'face') {
        hoverPatch = this.pickPatch(ray.origin, ray.direction, this.wantedPatches());
      }
      const hit = this.pickPart(ray.origin, ray.direction, new Set<string>());
      if (hit !== null) {
        hoverId = hit.placedId;
      }
      if (this.gizmo.axis !== null && this.gizmo.object !== undefined) {
        cursor = 'move';
        hoverId = null;
      } else if (hoverPatch !== null) {
        cursor = 'pointer';
        hoverId = null;
      } else if (hoverId !== null) {
        if (this.tool === 'place' && hoverId !== this.history.document.rootId) {
          cursor = 'grab';
        } else if (this.tool === 'face' && this.chosenFace !== null) {
          cursor = hoverId === this.selectedId ? 'not-allowed' : 'crosshair';
        } else {
          cursor = 'pointer';
        }
      }
    }
    if (this.press !== null && this.press.button !== 0) {
      cursor = 'move';
    }
    this.view.canvas.style.cursor = cursor;
    const changed = hoverId !== this.hoverId || !samePatch(hoverPatch, this.hoverPatch);
    this.hoverId = hoverId;
    this.hoverPatch = hoverPatch;
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
    this.shiftDown = event.shiftKey;
    this.ctrlDown = event.ctrlKey || event.metaKey;
    let onPart: string | null = null;
    if (event.button === 0 && this.held === null) {
      // The gizmo handles its own presses.
      if (this.gizmo.object !== undefined && this.gizmo.axis !== null) {
        this.view.controls.enabled = false;
        this.press = { x: event.clientX, y: event.clientY, button: event.button, onPart: null, moved: true };
        return;
      }
      const ray = this.view.rayAt(event.clientX, event.clientY);
      const hit = this.pickPart(ray.origin, ray.direction, new Set<string>());
      if (hit !== null) {
        onPart = hit.placedId;
      }
      const patchUnder = this.tool === 'face' ? this.pickPatch(ray.origin, ray.direction, this.wantedPatches()) : null;
      // A press on a part in place mode may become a drag that carries it,
      // so the camera must not orbit.
      const grabbable = this.tool === 'place' && onPart !== null && onPart !== this.history.document.rootId;
      if (grabbable || patchUnder !== null) {
        this.view.controls.enabled = false;
      }
    }
    if (event.button === 0 && this.held !== null && this.held.dragging) {
      this.view.controls.enabled = false;
    }
    this.press = { x: event.clientX, y: event.clientY, button: event.button, onPart: onPart, moved: false };
  }

  private onPointerMove(event: PointerEvent): void {
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    const rect = this.view.canvas.getBoundingClientRect();
    const overCanvas = event.target === this.view.canvas;
    this.pointerInside = overCanvas && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    this.ctrlDown = event.ctrlKey || event.metaKey;
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
    this.view.controls.enabled = true;
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
        if (this.held !== null) {
          this.cancelHeld();
          this.notify();
        } else if (this.chosenFace !== null) {
          this.chosenFace = null;
          this.syncScene();
        }
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

  // -------------------------------------------------------------------------
  // Place on face.

  private faceClick(clientX: number, clientY: number, onPart: string | null): void {
    const ray = this.view.rayAt(clientX, clientY);
    const patch = this.pickPatch(ray.origin, ray.direction, this.wantedPatches());
    const selected = this.selectedId === null ? null : findPlaced(this.history.document, this.selectedId);
    if (selected === null) {
      this.select(onPart);
      return;
    }
    if (patch !== null && patch.placedId === selected.id) {
      // A face of the selected part.
      if (selected.id === this.history.document.rootId) {
        // The root needs nothing else: that face becomes its aft face, on the axis.
        const face = this.requirePart(selected.partId).attachFaces[patch.face];
        const pose = placeRoot(face, selected.transform, 0);
        let next = movePart(this.history.document, selected.id, pose);
        next = rememberAttachFace(next, selected.partId, patch.face);
        this.chosenFace = null;
        this.commit(next);
        return;
      }
      this.chosenFace = patch.face;
      this.syncScene();
      this.notify();
      return;
    }
    if (this.chosenFace === null) {
      // Nothing chosen yet: clicking another part selects it instead.
      this.select(onPart);
      return;
    }
    const ownFace = this.requirePart(selected.partId).attachFaces[this.chosenFace];
    if (patch !== null) {
      // Face onto face: centred, normals opposed.
      const target = requirePlaced(this.history.document, patch.placedId);
      const targetFace = this.worldFace(target, patch.face);
      const pose = mateFaces(ownFace, selected.transform, targetFace.centre, targetFace.normal, 0);
      this.finishFacePlacement(selected, pose, patch.placedId, { ownFace: this.chosenFace, parentFace: patch.face });
      return;
    }
    if (onPart !== null && onPart !== selected.id) {
      // Face onto a point of another part's surface: attached there, standing
      // out along the surface normal, long side along the axis.
      const moving = new Set<string>(subtreeIds(this.history.document, selected.id));
      const hit = this.pickPart(ray.origin, ray.direction, moving);
      if (hit !== null) {
        const part = this.requirePart(selected.partId);
        const pose = attachToSurface(ownFace, partCentre(part), selected.transform, hit.point, hit.normal, 0);
        this.finishFacePlacement(selected, pose, hit.placedId, { ownFace: this.chosenFace, parentFace: null });
        return;
      }
    }
    // Clicked nothing useful: drop the choice.
    this.chosenFace = null;
    this.syncScene();
    this.notify();
  }

  private finishFacePlacement(selected: PlacedPart, pose: RigidTransform, parentId: string, joint: Joint): void {
    let next = movePart(this.history.document, selected.id, pose);
    const members = symmetryMembers(next, selected.id);
    for (let m = 0; m < members.length; m++) {
      members[m].parentId = parentId;
      members[m].joint = { ownFace: joint.ownFace, parentFace: joint.parentFace };
    }
    next = rememberAttachFace(next, selected.partId, joint.ownFace);
    this.chosenFace = null;
    this.commit(next);
  }

  // -------------------------------------------------------------------------
  // Gizmo.

  private proxyTransform(): RigidTransform {
    const p = this.gizmoProxy.position;
    const q = this.gizmoProxy.quaternion;
    return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
  }

  private applyAngleSnap(): void {
    if (!this.angleSnap) {
      this.gizmo.setRotationSnap(null);
      return;
    }
    // 15 degrees; hold Shift for 1 degree.
    const degrees = this.shiftDown ? 1 : 15;
    this.gizmo.setRotationSnap((degrees * Math.PI) / 180);
  }

  private gizmoMoved(): void {
    if (this.selectedId === null || this.gizmoStart === null) {
      return;
    }
    let pose = this.proxyTransform();
    if (this.tool === 'move' && this.ctrlDown) {
      // Ctrl: move in whole millimetres from where the drag began.
      const start = this.gizmoStart.position;
      const delta = sub(pose.position, start);
      const snapped: Vec3 = [Math.round(delta[0]), Math.round(delta[1]), Math.round(delta[2])];
      pose = { position: add(start, snapped), rotation: pose.rotation };
      applyTransform(this.gizmoProxy, pose);
    }
    this.shown = movePart(this.history.document, this.selectedId, pose);
    this.syncScene();
    this.notify();
  }

  private finishGizmoDrag(): void {
    const start = this.gizmoStart;
    this.gizmoStart = null;
    if (start === null || this.selectedId === null) {
      return;
    }
    const pose = this.proxyTransform();
    const moved = length(sub(pose.position, start.position)) > 1e-9 || Math.abs(dot4(pose.rotation, start.rotation)) < 1 - 1e-12;
    if (!moved) {
      return;
    }
    this.commit(movePart(this.history.document, this.selectedId, pose));
  }

  // Numeric entry from the inspector.
  setSelectedTransform(transform: RigidTransform): void {
    if (this.selectedId === null) {
      return;
    }
    this.commit(movePart(this.history.document, this.selectedId, transform));
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
    // On a selected placed part (not on the axis), change its set.
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
    if (distanceFromAxis(applyToPoint(placed.transform, partCentre(this.requirePart(placed.partId)))) < 0.5) {
      return;
    }
    for (let m = 0; m < members.length; m++) {
      if (subtreeIds(doc, members[m].id).length > 1) {
        return;
      }
    }
    const first = members[0];
    const ids: string[] = [];
    for (let m = 0; m < members.length; m++) {
      ids.push(members[m].id);
    }
    const without = removeParts(doc, ids);
    let transforms: RigidTransform[] = [first.transform];
    if (count > 1) {
      transforms = symmetryTransforms(first.transform, count);
    }
    const added = addParts(without, { partId: first.partId, transforms: transforms, parentId: first.parentId, joint: first.joint });
    if (doc.rootId === first.id) {
      added.doc.rootId = added.ids[0];
    }
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

  setAngleSnap(on: boolean): void {
    this.angleSnap = on;
    this.applyAngleSnap();
    this.notify();
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
        const ids = symmetryMembers(this.history.document, picked).map(memberId);
        this.commit(removeParts(this.history.document, ids));
      } else {
        this.showCommitted();
      }
      return;
    }
    if (this.selectedId === null) {
      return;
    }
    const ids = symmetryMembers(this.history.document, this.selectedId).map(memberId);
    this.selectedId = null;
    this.commit(removeParts(this.history.document, ids));
  }

  setView(preset: PresetView | 'fit'): void {
    const bounds = this.visibleBounds();
    let centre: Vec3 = [-150, 0, 0];
    let size = 700;
    if (bounds !== null) {
      centre = scale(add(bounds.min, bounds.max), 0.5);
      size = Math.max(100, length(sub(bounds.max, bounds.min)));
    }
    if (preset === 'fit') {
      // Keep the current direction, frame everything.
      const direction = this.view.viewDirection();
      const verticalAngle = (this.view.camera.fov * Math.PI) / 180;
      const distance = (size / 2 / Math.tan(verticalAngle / 2)) * 1.05;
      this.view.controls.target.set(centre[0], centre[1], centre[2]);
      this.view.camera.position.set(centre[0] - direction[0] * distance, centre[1] - direction[1] * distance, centre[2] - direction[2] * distance);
      this.view.controls.update();
      this.view.requestRender();
      return;
    }
    // Along the axis the rocket is small; frame its diameter.
    if (preset === 'nose' || preset === 'tail') {
      if (bounds !== null) {
        const extent = sub(bounds.max, bounds.min);
        size = Math.max(60, Math.hypot(extent[1], extent[2]) * 1.3);
      }
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
      const part = this.requirePart(placed.partId);
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
    this.shiftDown = event.shiftKey;
    this.ctrlDown = event.ctrlKey || event.metaKey;
    this.applyAngleSnap();
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
      if (this.held !== null) {
        this.cancelHeld();
      } else if (this.chosenFace !== null) {
        this.chosenFace = null;
        this.syncScene();
      } else {
        this.select(null);
      }
      this.notify();
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
    } else if (key === 'c') {
      this.setAngleSnap(!this.angleSnap);
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
        this.turnHeld([0, 1, 0], step);
      } else if (key === 'd') {
        this.turnHeld([0, 1, 0], -step);
      }
    }
  }

  // For the panels and the test hook.
  isRoot(placedId: string): boolean {
    return this.history.document.rootId === placedId;
  }

  partOfPlaced(placedId: string): Part {
    return this.requirePart(requirePlaced(this.shown, placedId).partId);
  }
}

function memberId(placed: PlacedPart): string {
  return placed.id;
}

function samePatch(a: PatchRef | null, b: PatchRef | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.placedId === b.placedId && a.face === b.face;
}

function dot4(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

// Centre of the part's bounding box, in its frame.
function partCentre(part: Part): Vec3 {
  return [
    (part.boundsMin[0] + part.boundsMax[0]) / 2,
    (part.boundsMin[1] + part.boundsMax[1]) / 2,
    (part.boundsMin[2] + part.boundsMax[2]) / 2,
  ];
}

// Is a point (in the plane) inside a convex outline? Same side of every edge.
function insideConvex(outline: Vec3[], normal: Vec3, point: Vec3): boolean {
  let sign = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const side = dot(cross(sub(b, a), sub(point, a)), normal);
    if (Math.abs(side) < 1e-12) {
      continue;
    }
    const s = side > 0 ? 1 : -1;
    if (sign === 0) {
      sign = s;
    } else if (s !== sign) {
      return false;
    }
  }
  return true;
}
