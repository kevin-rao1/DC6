// The 3D view: renderer, camera, orbit controls, lights, preset views.
// Renders on demand (requestRender), not every frame: a still view costs
// nothing.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vec3 } from '../geometry/vec3.ts';
import { NOSE_DIRECTION, WORLD_UP } from '../geometry/rocket-axis.ts';

export type PresetView = 'side' | 'top' | 'nose' | 'tail';

export class View {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  // Parts live here; overlays (patches, markers) in their own group above.
  readonly partsGroup: THREE.Group;
  readonly overlayGroup: THREE.Group;
  private renderPending = false;
  private beforeRender: Array<() => void> = [];
  // Time spent in the last few renders, for the e2e frame-rate check.
  readonly frameTimes: number[] = [];
  // How far the camera is turned about the rocket axis from the presets
  // (radians, from the side facing the side view towards the top). The flat
  // page shows the side the camera faces along the middle of its strip, so
  // rolling the page rolls this, and a preset view puts both back to 0.
  roll = 0;
  private readonly rollListeners: Array<() => void> = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 1);
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    // A narrow field of view: less perspective distortion on a long rocket,
    // closer to what CAD shows.
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 20000);
    this.camera.up.set(WORLD_UP[0], WORLD_UP[1], WORLD_UP[2]);

    // Light that follows the camera, plus a soft fill from the sky.
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x303034, 1.6);
    this.scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(0.4, 0.8, 1);
    this.camera.add(key);
    this.scene.add(this.camera);

    this.partsGroup = new THREE.Group();
    this.scene.add(this.partsGroup);
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.overlayGroup);

    this.controls = new OrbitControls(this.camera, this.canvas);
    // As in the slicers: left drag orbits, right or middle drag pans, wheel zooms.
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.screenSpacePanning = true;
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    const self = this;
    this.controls.addEventListener('change', function onCameraChange() {
      self.requestRender();
    });

    this.setPreset('side', [-500, -100, -100], [200, 100, 100]);
    const resizeObserver = new ResizeObserver(function onResize() {
      self.resize();
    });
    resizeObserver.observe(container);
    this.resize();
  }

  onBeforeRender(callback: () => void): void {
    this.beforeRender.push(callback);
  }

  onRoll(callback: () => void): void {
    this.rollListeners.push(callback);
  }

  // Turn the camera (and its sense of up) about the rocket axis so that it
  // faces the side at roll angle `angle`, as if the rocket were turned on
  // its axis. Orbiting afterwards turns about that rolled up.
  setRoll(angle: number): void {
    const turn = angle - this.roll;
    if (turn === 0) {
      return;
    }
    const axis = new THREE.Vector3(NOSE_DIRECTION[0], NOSE_DIRECTION[1], NOSE_DIRECTION[2]);
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, turn);
    this.camera.position.applyQuaternion(rotation);
    this.controls.target.applyQuaternion(rotation);
    this.camera.up.applyQuaternion(rotation);
    this.useCameraUp();
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.roll = angle;
    for (let i = 0; i < this.rollListeners.length; i++) {
      this.rollListeners[i]();
    }
    this.requestRender();
  }

  // The orbit controls keep the "up" they were made with in a private
  // quaternion; when the camera's up changes it has to be told. (Doubt:
  // this reaches into OrbitControls' internals, as of three 0.187.)
  private useCameraUp(): void {
    const internals = this.controls as unknown as { _quat: THREE.Quaternion; _quatInverse: THREE.Quaternion };
    internals._quat.setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
    internals._quatInverse.copy(internals._quat).invert();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (parent === null) {
      return;
    }
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    this.renderer.setSize(width, height, false);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender(): void {
    if (this.renderPending) {
      return;
    }
    this.renderPending = true;
    const self = this;
    requestAnimationFrame(function frame() {
      self.renderPending = false;
      const start = performance.now();
      for (let i = 0; i < self.beforeRender.length; i++) {
        self.beforeRender[i]();
      }
      self.fitDepthRange();
      self.renderer.render(self.scene, self.camera);
      const elapsed = performance.now() - start;
      self.frameTimes.push(elapsed);
      if (self.frameTimes.length > 240) {
        self.frameTimes.shift();
      }
    });
  }

  // Look at the box from min to max from a preset direction, from far
  // enough to see all of it.
  setPreset(preset: PresetView, min: Vec3, max: Vec3): void {
    let direction: Vec3 = [0, 0, 1];
    if (preset === 'side') {
      // From the side, a little above: the axis still runs straight across
      // the screen because it is square to the view direction.
      const elevation = (12 * Math.PI) / 180;
      direction = [0, Math.sin(elevation), Math.cos(elevation)];
    } else if (preset === 'top') {
      // Straight down would leave the orbit controls without a sense of up;
      // a hair off vertical keeps the nose pointing the same way on screen.
      direction = [0, 1, 0.0001];
    } else if (preset === 'nose') {
      direction = [NOSE_DIRECTION[0], NOSE_DIRECTION[1], NOSE_DIRECTION[2]];
    } else {
      direction = [-NOSE_DIRECTION[0], -NOSE_DIRECTION[1], -NOSE_DIRECTION[2]];
    }
    this.camera.up.set(WORLD_UP[0], WORLD_UP[1], WORLD_UP[2]);
    this.useCameraUp();
    const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const towardsCamera = new THREE.Vector3(direction[0], direction[1], direction[2]).normalize();
    const distance = this.distanceToFitBox(min, max, towardsCamera.clone().negate());
    this.controls.target.set(centre[0], centre[1], centre[2]);
    this.camera.position.set(centre[0] + direction[0] * distance, centre[1] + direction[1] * distance, centre[2] + direction[2] * distance);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    if (this.roll !== 0) {
      this.roll = 0;
      for (let i = 0; i < this.rollListeners.length; i++) {
        this.rollListeners[i]();
      }
    }
    this.requestRender();
  }

  // Fit the camera's near and far planes tightly around what is drawn. With
  // a loose range (1 mm to 20 m) the depth buffer cannot tell apart surfaces
  // a few millimetres apart at the usual viewing distance, and edges and
  // internals behind a thin wall speckle through it. Done every frame, as
  // the camera and the parts move.
  private fitDepthRange(): void {
    const box = new THREE.Box3();
    box.expandByObject(this.partsGroup);
    box.expandByObject(this.overlayGroup);
    if (box.isEmpty()) {
      return;
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = this.camera.position.distanceTo(sphere.center);
    // A margin for the gizmo, which can reach a little outside the parts.
    const radius = sphere.radius * 1.2 + 10;
    const near = Math.max(0.5, distance - radius);
    const far = distance + radius;
    if (near === this.camera.near && far === this.camera.far) {
      return;
    }
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  // Keep the current view direction, and frame the box from min to max.
  fit(min: Vec3, max: Vec3): void {
    const direction = this.viewDirection();
    const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const distance = this.distanceToFitBox(min, max, new THREE.Vector3(direction[0], direction[1], direction[2]));
    this.controls.target.set(centre[0], centre[1], centre[2]);
    this.camera.position.set(centre[0] - direction[0] * distance, centre[1] - direction[1] * distance, centre[2] - direction[2] * distance);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.requestRender();
  }

  // Distance from the box's centre, looking along `forward` with the
  // camera's up, at which the whole box fits the view: its extent across
  // the screen against the horizontal view angle and its extent up the
  // screen against the vertical one. (The view is wide and short now that
  // the page is below it; fitting the box's diagonal left a long rocket
  // small in the middle.)
  private distanceToFitBox(min: Vec3, max: Vec3, forward: THREE.Vector3): number {
    const verticalAngle = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.2, this.camera.aspect);
    const horizontalAngle = 2 * Math.atan(Math.tan(verticalAngle / 2) * aspect);
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    let across = 0;
    let upward = 0;
    let depth = 0;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? max[0] - min[0] : 0;
      const y = corner & 2 ? max[1] - min[1] : 0;
      const z = corner & 4 ? max[2] - min[2] : 0;
      const offset = new THREE.Vector3(x - (max[0] - min[0]) / 2, y - (max[1] - min[1]) / 2, z - (max[2] - min[2]) / 2);
      across = Math.max(across, Math.abs(offset.dot(right)));
      upward = Math.max(upward, Math.abs(offset.dot(up)));
      depth = Math.max(depth, Math.abs(offset.dot(forward)));
    }
    const forWidth = across / Math.tan(horizontalAngle / 2);
    const forHeight = upward / Math.tan(verticalAngle / 2);
    return Math.max(forWidth, forHeight) * 1.15 + depth;
  }

  // Ray through a point given in client (page) pixels.
  rayAt(clientX: number, clientY: number): { origin: Vec3; direction: Vec3 } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const near = new THREE.Vector3(x, y, -1).unproject(this.camera);
    const far = new THREE.Vector3(x, y, 1).unproject(this.camera);
    const direction = far.sub(near).normalize();
    const origin = this.camera.position.clone();
    return { origin: [origin.x, origin.y, origin.z], direction: [direction.x, direction.y, direction.z] };
  }

  // A world point in client pixels; `inFront` is false behind the camera.
  toScreen(point: Vec3): { x: number; y: number; inFront: boolean } {
    const rect = this.canvas.getBoundingClientRect();
    const projected = new THREE.Vector3(point[0], point[1], point[2]).project(this.camera);
    const x = rect.left + ((projected.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - projected.y) / 2) * rect.height;
    return { x: x, y: y, inFront: projected.z < 1 };
  }

  viewDirection(): Vec3 {
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    return [direction.x, direction.y, direction.z];
  }

  // Millimetres per pixel at a world point, for screen-sized things.
  millimetresPerPixel(point: Vec3): number {
    // Depth along the view direction, not straight-line distance: off the
    // centre of the view the two differ, and only depth sets the scale.
    const toPoint = new THREE.Vector3(point[0], point[1], point[2]).sub(this.camera.position);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const distance = toPoint.dot(forward);
    const height = this.canvas.getBoundingClientRect().height;
    const viewHeight = 2 * distance * Math.tan((this.camera.fov * Math.PI) / 360);
    return viewHeight / Math.max(1, height);
  }
}
