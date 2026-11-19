// The 3D view: three.js scene, orbit/pan/zoom, preset views.
//
// The view only displays; it computes nothing about the geometry. It is given
// a DcModel and the set of shown triangles, and draws those.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DcModel, RocketAxis, Vec3 } from '../geometry/types.ts';
import { perpendicularFrame } from '../geometry/vec3.ts';

export type PresetView = 'side' | 'top' | 'nose' | 'tail';

const surfaceColour = new THREE.Color('#c9c9cf');
const highlightColour = new THREE.Color('#e64097');
const edgeColour = new THREE.Color('#5a5a62');
const accent = new THREE.Color('#e64097');
const backColour = new THREE.Color('#1c1c21');

export class Viewer {
  container: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  modelGroup: THREE.Group;
  surface: THREE.Mesh | null;
  edges: THREE.LineSegments | null;
  axisLine: THREE.Group | null;
  // Shown triangle ids in the order they were written to the geometry, so a
  // part can be highlighted by colouring its run of vertices.
  shownTriangles: Int32Array;
  model: DcModel | null;
  // The model is drawn shifted so its centre is at the origin, which keeps
  // float32 positions precise and makes orbiting natural.
  centre: Vec3;
  radius: number;
  // Largest distance of a shown vertex from the rocket axis: frames the
  // nose-on and tail-on views, which see the rocket end-on.
  radialExtent: number;
  showEdges: boolean;
  needsRender: boolean;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 100000);
    this.camera.position.set(0, -2000, 600);
    this.camera.up.set(0, 0, 1);

    // Neutral lighting: soft sky/ground fill, plus a key light that follows
    // the camera so the side facing the user is always lit.
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x303034, 1.2);
    this.scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.4, 0.6, 1);
    this.camera.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(-1, -0.3, -0.6);
    this.camera.add(rim);
    this.scene.add(this.camera);

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    const viewer = this;
    this.controls.addEventListener('change', function onChange(): void {
      viewer.needsRender = true;
    });

    this.surface = null;
    this.edges = null;
    this.axisLine = null;
    this.shownTriangles = new Int32Array(0);
    this.model = null;
    this.centre = [0, 0, 0];
    this.radius = 1000;
    this.radialExtent = 100;
    this.showEdges = true;
    this.needsRender = true;

    const resizeObserver = new ResizeObserver(function onResize(): void {
      viewer.resize();
    });
    resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = width + 'px';
    this.renderer.domElement.style.height = height + 'px';
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  loop(): void {
    const viewer = this;
    function frame(): void {
      // update() returns true while damping is still moving the camera.
      const moving = viewer.controls.update();
      if (moving || viewer.needsRender) {
        viewer.renderer.render(viewer.scene, viewer.camera);
        viewer.needsRender = false;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  clearModel(): void {
    while (this.modelGroup.children.length > 0) {
      const child = this.modelGroup.children[0];
      this.modelGroup.remove(child);
      disposeObject(child);
    }
    this.surface = null;
    this.edges = null;
    this.axisLine = null;
  }

  // Draw the model. `included` marks the shown triangles.
  setModel(model: DcModel, included: Uint8Array, frameView: boolean): void {
    this.clearModel();
    this.model = model;
    const mesh = model.mesh;

    // Bounding box of the shown triangles, for centring and framing.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let shownCount = 0;
    const triangleCount = mesh.triangleFace.length;
    for (let t = 0; t < triangleCount; t++) {
      if (included[t] === 0) {
        continue;
      }
      shownCount = shownCount + 1;
      for (let corner = 0; corner < 3; corner++) {
        const v = mesh.triangles[3 * t + corner];
        const x = mesh.positions[3 * v];
        const y = mesh.positions[3 * v + 1];
        const z = mesh.positions[3 * v + 2];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
    }
    if (shownCount === 0) {
      this.needsRender = true;
      return;
    }
    this.centre = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    this.radius = Math.max(1, 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz));
    this.radialExtent = radialExtentOf(model, included);

    // Non-indexed geometry: three vertices per triangle, so each corner keeps
    // its own CAD normal (smooth within a face, sharp across face edges).
    const positions = new Float32Array(shownCount * 9);
    const normals = new Float32Array(shownCount * 9);
    const colours = new Float32Array(shownCount * 9);
    this.shownTriangles = new Int32Array(shownCount);
    let written = 0;
    for (let t = 0; t < triangleCount; t++) {
      if (included[t] === 0) {
        continue;
      }
      this.shownTriangles[written] = t;
      for (let corner = 0; corner < 3; corner++) {
        const v = mesh.triangles[3 * t + corner];
        const out = 9 * written + 3 * corner;
        positions[out] = mesh.positions[3 * v] - this.centre[0];
        positions[out + 1] = mesh.positions[3 * v + 1] - this.centre[1];
        positions[out + 2] = mesh.positions[3 * v + 2] - this.centre[2];
        normals[out] = mesh.cornerNormals[9 * t + 3 * corner];
        normals[out + 1] = mesh.cornerNormals[9 * t + 3 * corner + 1];
        normals[out + 2] = mesh.cornerNormals[9 * t + 3 * corner + 2];
        colours[out] = surfaceColour.r;
        colours[out + 1] = surfaceColour.g;
        colours[out + 2] = surfaceColour.b;
      }
      written = written + 1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.surface = new THREE.Mesh(geometry, material);
    this.modelGroup.add(this.surface);
    // Shown faces are oriented outwards. Where the user looks into an opening
    // (the open tail) they see the back of the skin; draw it flat dark so it
    // reads as "inside" rather than as more surface.
    const backMaterial = new THREE.MeshBasicMaterial({
      color: backColour,
      side: THREE.BackSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const backs = new THREE.Mesh(geometry, backMaterial);
    this.modelGroup.add(backs);

    this.edges = this.makeFeatureEdges(model, included);
    this.edges.visible = this.showEdges;
    this.modelGroup.add(this.edges);

    this.axisLine = this.makeAxisLine(model.axis);
    this.modelGroup.add(this.axisLine);

    if (frameView) {
      this.setPresetView('side');
    }
    this.needsRender = true;
  }

  // CAD face boundaries among the shown triangles: edges whose two triangles
  // belong to different faces, and open edges.
  makeFeatureEdges(model: DcModel, included: Uint8Array): THREE.LineSegments {
    const mesh = model.mesh;
    const topology = model.topology;
    const points: number[] = [];
    const triangleCount = mesh.triangleFace.length;
    for (let t = 0; t < triangleCount; t++) {
      if (included[t] === 0) {
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const other = topology.neighbours[3 * t + k];
        let draw = false;
        if (other < 0) {
          draw = true;
        } else if (other > t && mesh.triangleFace[other] !== mesh.triangleFace[t]) {
          draw = true;
        }
        if (!draw) {
          continue;
        }
        const a = mesh.triangles[3 * t + k];
        const b = mesh.triangles[3 * t + ((k + 1) % 3)];
        points.push(mesh.positions[3 * a] - this.centre[0]);
        points.push(mesh.positions[3 * a + 1] - this.centre[1]);
        points.push(mesh.positions[3 * a + 2] - this.centre[2]);
        points.push(mesh.positions[3 * b] - this.centre[0]);
        points.push(mesh.positions[3 * b + 1] - this.centre[1]);
        points.push(mesh.positions[3 * b + 2] - this.centre[2]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
    const material = new THREE.LineBasicMaterial({ color: edgeColour, transparent: true, opacity: 0.7 });
    return new THREE.LineSegments(geometry, material);
  }

  // A thin accent line along the detected axis, from tail to a little past
  // the nose, with a small cone pointing to the nose.
  makeAxisLine(axis: RocketAxis): THREE.Group {
    const group = new THREE.Group();
    const length = axis.stationMax - axis.stationMin;
    const overshoot = 0.06 * length;
    const start = new THREE.Vector3(
      axis.origin[0] - this.centre[0] - axis.direction[0] * overshoot,
      axis.origin[1] - this.centre[1] - axis.direction[1] * overshoot,
      axis.origin[2] - this.centre[2] - axis.direction[2] * overshoot,
    );
    const endDistance = length + overshoot;
    const end = new THREE.Vector3(
      axis.origin[0] - this.centre[0] + axis.direction[0] * endDistance,
      axis.origin[1] - this.centre[1] + axis.direction[1] * endDistance,
      axis.origin[2] - this.centre[2] + axis.direction[2] * endDistance,
    );
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setFromPoints([start, end]);
    const lineMaterial = new THREE.LineDashedMaterial({
      color: accent,
      dashSize: length / 60,
      gapSize: length / 90,
      transparent: true,
      opacity: 0.85,
    });
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.computeLineDistances();
    line.renderOrder = 10;
    group.add(line);
    const coneHeight = length * 0.025;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(coneHeight * 0.35, coneHeight, 16),
      new THREE.MeshBasicMaterial({ color: accent }),
    );
    // ConeGeometry points along +Y; turn it to the axis direction.
    const direction = new THREE.Vector3(axis.direction[0], axis.direction[1], axis.direction[2]);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    cone.position.copy(end);
    cone.renderOrder = 10;
    group.add(cone);
    return group;
  }

  setEdgesVisible(visible: boolean): void {
    this.showEdges = visible;
    if (this.edges !== null) {
      this.edges.visible = visible;
    }
    this.needsRender = true;
  }

  // Colour the triangles of one part in the accent colour (or none: -1).
  highlightPart(partId: number): void {
    if (this.surface === null || this.model === null) {
      return;
    }
    const geometry = this.surface.geometry;
    const colourAttribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    const colours = colourAttribute.array as Float32Array;
    const faces = this.model.faces;
    const triangleFace = this.model.mesh.triangleFace;
    for (let i = 0; i < this.shownTriangles.length; i++) {
      const t = this.shownTriangles[i];
      const part = faces[triangleFace[t]].part;
      let colour = surfaceColour;
      if (part === partId) {
        colour = highlightColour;
      }
      for (let corner = 0; corner < 3; corner++) {
        const out = 9 * i + 3 * corner;
        colours[out] = colour.r;
        colours[out + 1] = colour.g;
        colours[out + 2] = colour.b;
      }
    }
    colourAttribute.needsUpdate = true;
    this.needsRender = true;
  }

  // Orbit controls turn about the camera's "up" direction, fixed when they are
  // made. Up is the rocket axis (nose up, like the 2D page), so dragging
  // sideways spins the rocket about its own axis. Remade when the axis changes.
  makeControls(up: THREE.Vector3): void {
    const target = this.controls.target.clone();
    this.controls.dispose();
    this.camera.up.copy(up);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.target.copy(target);
    const viewer = this;
    this.controls.addEventListener('change', function onChange(): void {
      viewer.needsRender = true;
    });
  }

  // Preset views relative to the rocket axis, so "side" means side-on to the
  // rocket whichever way the file had it.
  setPresetView(view: PresetView): void {
    if (this.model === null) {
      return;
    }
    const axis = this.model.axis;
    const frame = perpendicularFrame(axis.direction);
    const d = new THREE.Vector3(axis.direction[0], axis.direction[1], axis.direction[2]);
    const u = new THREE.Vector3(frame.u[0], frame.u[1], frame.u[2]);
    const v = new THREE.Vector3(frame.v[0], frame.v[1], frame.v[2]);
    this.makeControls(d);
    // Distance so the bounding sphere fits the narrower field of view.
    const verticalFov = (this.camera.fov * Math.PI) / 180;
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const fov = Math.min(verticalFov, horizontalFov);
    let framedRadius = this.radius;
    if (view === 'nose' || view === 'tail') {
      framedRadius = this.radialExtent * 1.15;
    }
    // From an end, the rocket's length is along the view direction; keep the
    // camera beyond the near end.
    let distance = (framedRadius / Math.sin(fov / 2)) * 1.05;
    if (view === 'nose' || view === 'tail') {
      distance = distance + this.radius;
    }
    let eye = new THREE.Vector3();
    if (view === 'side') {
      eye = u.clone();
      eye.multiplyScalar(distance);
    } else if (view === 'top') {
      eye = v.clone();
      eye.multiplyScalar(distance);
    } else {
      // Straight down the axis is a singular direction for orbit controls
      // (up and view parallel), so look from a hair off the axis.
      let alongAxis = distance;
      if (view === 'tail') {
        alongAxis = -distance;
      }
      const offAxis = u.clone();
      offAxis.multiplyScalar(distance * 0.001);
      eye = d.clone();
      eye.multiplyScalar(alongAxis);
      eye.add(offAxis);
    }
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(eye);
    this.camera.near = Math.max(0.1, distance / 1000);
    this.camera.far = distance * 10;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
    this.needsRender = true;
  }
}

function radialExtentOf(model: DcModel, included: Uint8Array): number {
  const axis = model.axis;
  const mesh = model.mesh;
  let largest = 0;
  for (let t = 0; t < mesh.triangleFace.length; t++) {
    if (included[t] === 0) {
      continue;
    }
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.triangles[3 * t + corner];
      const ox = mesh.positions[3 * v] - axis.origin[0];
      const oy = mesh.positions[3 * v + 1] - axis.origin[1];
      const oz = mesh.positions[3 * v + 2] - axis.origin[2];
      const along = ox * axis.direction[0] + oy * axis.direction[1] + oz * axis.direction[2];
      const rx = ox - along * axis.direction[0];
      const ry = oy - along * axis.direction[1];
      const rz = oz - along * axis.direction[2];
      const radius = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radius > largest) {
        largest = radius;
      }
    }
  }
  return Math.max(1, largest);
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse(function dispose(child: THREE.Object3D): void {
    const withGeometry = child as THREE.Mesh;
    if (withGeometry.geometry !== undefined) {
      withGeometry.geometry.dispose();
    }
    const material = withGeometry.material;
    if (material !== undefined) {
      if (Array.isArray(material)) {
        for (let i = 0; i < material.length; i++) {
          material[i].dispose();
        }
      } else {
        material.dispose();
      }
    }
  });
}
