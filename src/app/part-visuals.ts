// three.js objects for parts: one shared geometry per source part, one
// lightweight object per placed part (so a part placed four times costs one
// geometry).

import * as THREE from 'three';
import type { Part, AttachFace } from '../geometry/part.ts';
import type { RigidTransform } from '../geometry/transform.ts';

export const accent = 0xe64097;
const partColour = 0x9b9ba0;
const edgeColour = 0x2a2a2e;

export interface PartGeometry {
  mesh: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
}

export function makePartGeometry(part: Part): PartGeometry {
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  mesh.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
  mesh.setIndex(new THREE.BufferAttribute(part.indices, 1));
  mesh.computeBoundingSphere();

  // CAD edges as line segments: each polyline becomes consecutive pairs.
  let segmentCount = 0;
  for (let e = 0; e < part.edges.length; e++) {
    const pointCount = part.edges[e].points.length / 3;
    if (pointCount >= 2) {
      segmentCount = segmentCount + pointCount - 1;
    }
  }
  const linePositions = new Float32Array(segmentCount * 6);
  let cursor = 0;
  for (let e = 0; e < part.edges.length; e++) {
    const points = part.edges[e].points;
    const pointCount = points.length / 3;
    for (let i = 0; i + 1 < pointCount; i++) {
      for (let k = 0; k < 6; k++) {
        linePositions[cursor + k] = points[3 * i + k];
      }
      cursor = cursor + 6;
    }
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  return { mesh: mesh, edges: edges };
}

export function applyTransform(object: THREE.Object3D, transform: RigidTransform): void {
  object.position.set(transform.position[0], transform.position[1], transform.position[2]);
  object.quaternion.set(transform.rotation[0], transform.rotation[1], transform.rotation[2], transform.rotation[3]);
  object.updateMatrixWorld(true);
}

export type Highlight = 'none' | 'hover' | 'selected';

// The visual of one placed (or held) part.
export class PartVisual {
  readonly group: THREE.Group;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly edgeMaterial: THREE.LineBasicMaterial;
  private highlight: Highlight = 'none';
  private floating = false;

  constructor(geometry: PartGeometry) {
    this.material = new THREE.MeshStandardMaterial({
      color: partColour,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: edgeColour });
    const mesh = new THREE.Mesh(geometry.mesh, this.material);
    const lines = new THREE.LineSegments(geometry.edges, this.edgeMaterial);
    this.group = new THREE.Group();
    this.group.add(mesh);
    this.group.add(lines);
  }

  setHighlight(highlight: Highlight): void {
    if (highlight === this.highlight) {
      return;
    }
    this.highlight = highlight;
    this.refresh();
  }

  // A held part that is not attached to anything is drawn see-through, so it
  // is obvious when it has snapped on (it turns solid).
  setFloating(floating: boolean): void {
    if (floating === this.floating) {
      return;
    }
    this.floating = floating;
    this.refresh();
  }

  private refresh(): void {
    if (this.highlight === 'selected') {
      this.material.emissive.setHex(accent);
      this.material.emissiveIntensity = 0.22;
      this.edgeMaterial.color.setHex(accent);
    } else if (this.highlight === 'hover') {
      this.material.emissive.setHex(0xffffff);
      this.material.emissiveIntensity = 0.12;
      this.edgeMaterial.color.setHex(edgeColour);
    } else {
      this.material.emissive.setHex(0x000000);
      this.material.emissiveIntensity = 0;
      this.edgeMaterial.color.setHex(edgeColour);
    }
    this.material.transparent = this.floating;
    this.material.opacity = this.floating ? 0.45 : 1;
    this.material.depthWrite = !this.floating;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.material.dispose();
    this.edgeMaterial.dispose();
  }
}

// A translucent patch for one attach face (place on face).
export class FacePatch {
  readonly group: THREE.Group;
  private readonly fill: THREE.MeshBasicMaterial;
  private readonly line: THREE.LineBasicMaterial;

  constructor(face: AttachFace) {
    // The outline is convex: a fan from its first point covers it. Lift it a
    // hair off the face along the normal so it does not fight the surface.
    const lift = 0.05;
    const points: number[] = [];
    for (let i = 0; i < face.outline.length; i++) {
      const p = face.outline[i];
      points.push(p[0] + face.normal[0] * lift, p[1] + face.normal[1] * lift, p[2] + face.normal[2] * lift);
    }
    const indices: number[] = [];
    for (let i = 1; i + 1 < face.outline.length; i++) {
      indices.push(0, i, i + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
    geometry.setIndex(indices);
    this.fill = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, this.fill);
    mesh.renderOrder = 10;
    const lineGeometry = new THREE.BufferGeometry();
    const loop = points.concat(points.slice(0, 3));
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(loop), 3));
    this.line = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.9 });
    const outline = new THREE.Line(lineGeometry, this.line);
    outline.renderOrder = 11;
    this.group = new THREE.Group();
    this.group.add(mesh);
    this.group.add(outline);
  }

  // 'idle' = offered, 'dim' = offered on another part, 'hover', 'chosen'.
  setState(state: 'idle' | 'dim' | 'hover' | 'chosen'): void {
    if (state === 'idle') {
      this.fill.opacity = 0.28;
      this.line.opacity = 0.9;
    } else if (state === 'dim') {
      this.fill.opacity = 0.14;
      this.line.opacity = 0.5;
    } else if (state === 'hover') {
      this.fill.opacity = 0.6;
      this.line.opacity = 1;
    } else {
      this.fill.opacity = 0.75;
      this.line.opacity = 1;
    }
  }

  dispose(): void {
    this.group.traverse(function free(object) {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose();
      }
    });
    this.fill.dispose();
    this.line.dispose();
  }
}

// Screen-sized round markers (attach nodes while a part is held).
export class Markers {
  readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;

  constructor(sizePixels: number, filled: boolean, colour: number) {
    this.material = new THREE.PointsMaterial({
      size: sizePixels * window.devicePixelRatio,
      sizeAttenuation: false,
      map: markerTexture(filled),
      color: colour,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.renderOrder = 20;
    this.points.frustumCulled = false;
  }

  setPositions(positions: number[]): void {
    this.points.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.points.geometry = geometry;
    this.points.visible = positions.length > 0;
  }
}

const markerTextures = new Map<string, THREE.Texture>();

// A ring (or a dot with a dark rim) drawn on a canvas, white so the
// material colour tints it.
function markerTexture(filled: boolean): THREE.Texture {
  const key = filled ? 'filled' : 'ring';
  const cached = markerTextures.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('markerTexture: no 2D canvas context');
  }
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2 - 6, 0, 2 * Math.PI);
  if (filled) {
    context.fillStyle = '#ffffff';
    context.fill();
  }
  context.lineWidth = 8;
  context.strokeStyle = '#ffffff';
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  markerTextures.set(key, texture);
  return texture;
}
