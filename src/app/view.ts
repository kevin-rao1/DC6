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

    this.setPreset('side', [-150, 0, 0], 700);
    const resizeObserver = new ResizeObserver(function onResize() {
      self.resize();
    });
    resizeObserver.observe(container);
    this.resize();
  }

  onBeforeRender(callback: () => void): void {
    this.beforeRender.push(callback);
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
      self.renderer.render(self.scene, self.camera);
      const elapsed = performance.now() - start;
      self.frameTimes.push(elapsed);
      if (self.frameTimes.length > 240) {
        self.frameTimes.shift();
      }
    });
  }

  // Look at `centre` from a preset direction, from far enough to see `size` mm.
  setPreset(preset: PresetView, centre: Vec3, size: number): void {
    // Distance at which `size` fits the narrower of the two view angles.
    const verticalAngle = (this.camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.2, this.camera.aspect);
    const horizontalAngle = 2 * Math.atan(Math.tan(verticalAngle / 2) * aspect);
    const fitAngle = Math.min(verticalAngle, horizontalAngle);
    const distance = (size / 2 / Math.tan(fitAngle / 2)) * 1.1;
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
    this.controls.target.set(centre[0], centre[1], centre[2]);
    this.camera.position.set(centre[0] + direction[0] * distance, centre[1] + direction[1] * distance, centre[2] + direction[2] * distance);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.requestRender();
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
    const distance = this.camera.position.distanceTo(new THREE.Vector3(point[0], point[1], point[2]));
    const height = this.canvas.getBoundingClientRect().height;
    const viewHeight = 2 * distance * Math.tan((this.camera.fov * Math.PI) / 360);
    return viewHeight / Math.max(1, height);
  }
}
