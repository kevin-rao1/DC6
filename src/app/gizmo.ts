// The move and rotate gizmos on the selected part.
//
// Move works like the offset tool of the KSP editor: by default the part
// slides along the rocket axis only, in whole millimetres (Shift: 0.1 mm).
// Holding Ctrl shows the other two directions as well. Rotate turns about
// the three world axes in 15 degree steps (Shift: 1 degree). While dragging,
// a small label beside the cursor says how far, in mm or degrees.
//
// The gizmo sits on a stand-in object (the proxy) at the part's pivot: the
// middle of its bounding box. A part's own origin is wherever its CAD file
// put it, often nowhere near the part, so it is no use as a pivot.
// What the editor gets back is the motion since the drag began, as a rigid
// transform; it applies that to the part (and the part's children).

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Vec3 } from '../geometry/vec3.ts';
import { dot, scale, sub } from '../geometry/vec3.ts';
import type { Quat, RigidTransform } from '../geometry/transform.ts';
import { quatAngle, rotateVector } from '../geometry/transform.ts';
import { AFT_DIRECTION } from '../geometry/rocket-axis.ts';
import type { View } from './view.ts';

export type GizmoMode = 'move' | 'rotate';

export interface GizmoEvents {
  // The motion so far, while dragging.
  preview(motion: RigidTransform): void;
  // The drag ended with this motion (not called when nothing moved).
  commit(motion: RigidTransform): void;
}

// The gizmo shows world axes, and the axis it offers by default is world X.
// That is only right while the rocket axis is world X.
if (Math.abs(Math.abs(AFT_DIRECTION[0]) - 1) > 1e-12) {
  throw new Error('gizmo.ts expects the rocket axis along world X; AFT_DIRECTION is ' + String(AFT_DIRECTION));
}

const cerise = 0xe64097;

export class PartGizmo {
  private readonly view: View;
  private readonly events: GizmoEvents;
  private readonly controls: TransformControls;
  private readonly proxy = new THREE.Object3D();
  private readonly label: HTMLDivElement;
  private pivot: Vec3 = [0, 0, 0];
  private mode: GizmoMode = 'move';
  private fine = false;
  private free = false;
  private lastMotion: RigidTransform | null = null;

  // What the gizmo adds to the scene (hidden for a picture of the view).
  sceneObjects(): THREE.Object3D[] {
    return [this.proxy, this.controls.getHelper()];
  }

  constructor(view: View, labelParent: HTMLElement, events: GizmoEvents) {
    this.view = view;
    this.events = events;
    this.controls = new TransformControls(view.camera, view.canvas);
    this.controls.setSpace('world');
    this.controls.setSize(0.8);
    // The rocket axis in the accent colour, the other two quiet.
    this.controls.setColors(cerise, 0x8a8a92, 0x5a5a62, 0xffffff);
    view.scene.add(this.proxy);
    view.scene.add(this.controls.getHelper());

    this.label = document.createElement('div');
    this.label.className = 'gizmo-label';
    labelParent.appendChild(this.label);

    const self = this;
    this.controls.addEventListener('dragging-changed', function onDragging(event) {
      const dragging = (event as unknown as { value: boolean }).value;
      view.controls.enabled = !dragging;
      if (dragging) {
        self.lastMotion = null;
      } else {
        self.finishDrag();
      }
    });
    this.controls.addEventListener('objectChange', function onChange() {
      self.dragged();
    });
    this.controls.addEventListener('change', function onRedraw() {
      view.requestRender();
    });
    this.applyModifiers();
  }

  get dragging(): boolean {
    return this.controls.dragging;
  }

  // True when the cursor is over a handle (so a press belongs to the gizmo).
  hovered(): boolean {
    return this.controls.object !== undefined && this.controls.axis !== null;
  }

  // Where the gizmo is, in world coordinates (for the test hook).
  pivotPoint(): Vec3 {
    return [this.pivot[0], this.pivot[1], this.pivot[2]];
  }

  show(mode: GizmoMode, pivot: Vec3): void {
    if (this.controls.dragging) {
      return;
    }
    this.mode = mode;
    this.pivot = [pivot[0], pivot[1], pivot[2]];
    this.controls.setMode(mode === 'move' ? 'translate' : 'rotate');
    this.resetProxy();
    if (this.controls.object !== this.proxy) {
      this.controls.attach(this.proxy);
    }
    this.applyModifiers();
  }

  hide(): void {
    if (this.controls.object !== undefined) {
      this.controls.detach();
    }
    this.label.style.display = 'none';
  }

  // Shift: finer steps. Ctrl: move in any direction, not only along the axis.
  setModifiers(fine: boolean, free: boolean): void {
    if (fine === this.fine && free === this.free) {
      return;
    }
    this.fine = fine;
    this.free = free;
    this.applyModifiers();
  }

  moveLabel(clientX: number, clientY: number): void {
    const rect = this.label.parentElement === null ? null : this.label.parentElement.getBoundingClientRect();
    if (rect === null) {
      return;
    }
    this.label.style.left = String(clientX - rect.left + 16) + 'px';
    this.label.style.top = String(clientY - rect.top + 14) + 'px';
  }

  private applyModifiers(): void {
    const degrees = this.fine ? 1 : 15;
    this.controls.setRotationSnap((degrees * Math.PI) / 180);
    // Translation snap is done here, on the distance moved, not by the
    // controls (they would round the absolute position).
    this.controls.setTranslationSnap(null);
    const offerAll = this.mode === 'rotate' || this.free;
    this.controls.showX = true;
    this.controls.showY = offerAll;
    this.controls.showZ = offerAll;
    this.view.requestRender();
  }

  private resetProxy(): void {
    this.proxy.position.set(this.pivot[0], this.pivot[1], this.pivot[2]);
    this.proxy.quaternion.set(0, 0, 0, 1);
    this.proxy.updateMatrixWorld(true);
  }

  private dragged(): void {
    let motion: RigidTransform;
    let text = '';
    if (this.mode === 'move') {
      const position: Vec3 = [this.proxy.position.x, this.proxy.position.y, this.proxy.position.z];
      const moved = sub(position, this.pivot);
      const step = this.fine ? 0.1 : 1;
      let snapped: Vec3;
      if (this.free) {
        snapped = [roundTo(moved[0], step), roundTo(moved[1], step), roundTo(moved[2], step)];
      } else {
        // Along the rocket axis only.
        const along = roundTo(dot(moved, AFT_DIRECTION), step);
        snapped = scale(AFT_DIRECTION, along);
      }
      this.proxy.position.set(this.pivot[0] + snapped[0], this.pivot[1] + snapped[1], this.pivot[2] + snapped[2]);
      motion = { position: snapped, rotation: [0, 0, 0, 1] };
      // Positive towards the tail (screen right in the side view).
      const aft = dot(snapped, AFT_DIRECTION);
      text = formatSigned(aft, this.fine ? 1 : 0) + ' mm';
    } else {
      const q = this.proxy.quaternion;
      const rotation: Quat = [q.x, q.y, q.z, q.w];
      motion = aboutPivot(this.pivot, rotation);
      const degrees = (quatAngle(rotation) * 180) / Math.PI;
      text = degrees.toFixed(this.fine ? 1 : 0) + '°';
    }
    this.lastMotion = motion;
    this.label.textContent = text;
    this.label.style.display = 'block';
    this.events.preview(motion);
  }

  private finishDrag(): void {
    this.label.style.display = 'none';
    const motion = this.lastMotion;
    this.lastMotion = null;
    this.resetProxy();
    if (motion === null) {
      return;
    }
    const still = Math.hypot(motion.position[0], motion.position[1], motion.position[2]) < 1e-9 && quatAngle(motion.rotation) < 1e-9;
    if (still) {
      // Let the editor drop its preview.
      this.events.preview(motion);
      return;
    }
    this.events.commit(motion);
  }
}

// A rotation about a point, as a rigid transform: p -> R (p - pivot) + pivot.
function aboutPivot(pivot: Vec3, rotation: Quat): RigidTransform {
  const rotatedPivot = rotateVector(rotation, pivot);
  const position = sub(pivot, rotatedPivot);
  return { position: position, rotation: rotation };
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function formatSigned(value: number, decimals: number): string {
  const text = Math.abs(value).toFixed(decimals);
  if (Number(text) === 0) {
    return text;
  }
  if (value > 0) {
    return '+' + text;
  }
  return '−' + text;
}
