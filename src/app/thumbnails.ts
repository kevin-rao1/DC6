// Small pictures of parts for the parts list, drawn once per part with a
// separate little renderer.

import * as THREE from 'three';
import type { Part } from '../geometry/part.ts';
import type { RigidTransform } from '../geometry/transform.ts';
import { makePartGeometry, PartVisual, applyTransform } from './part-visuals.ts';

let renderer: THREE.WebGLRenderer | null = null;
const size = 112;

export function renderThumbnail(part: Part, orientation: RigidTransform): string {
  if (renderer === null) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(size, size, false);
    renderer.setClearColor(0x000000, 0);
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x303034, 1.6));
  const geometry = makePartGeometry(part);
  const visual = new PartVisual(geometry);
  applyTransform(visual.group, orientation);
  scene.add(visual.group);

  const box = new THREE.Box3().setFromObject(visual.group);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100000);
  const distance = (sphere.radius / Math.sin((15 * Math.PI) / 180)) * 1.02;
  const elevation = (20 * Math.PI) / 180;
  const azimuth = (25 * Math.PI) / 180;
  camera.position.set(
    sphere.center.x + distance * Math.cos(elevation) * Math.sin(azimuth),
    sphere.center.y + distance * Math.sin(elevation),
    sphere.center.z + distance * Math.cos(elevation) * Math.cos(azimuth),
  );
  camera.lookAt(sphere.center);
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(0.4, 0.8, 1);
  camera.add(key);
  scene.add(camera);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  geometry.mesh.dispose();
  geometry.edges.dispose();
  visual.dispose();
  return url;
}
