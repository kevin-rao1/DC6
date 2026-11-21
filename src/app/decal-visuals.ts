// three.js objects for decals: the draped mesh with the artwork as its
// texture, and the selection outline with its handles.
//
// The draped mesh is the mapped grid (decal-map.ts) lifted a hair off the
// surface along the normal, drawn with polygon offset and a per-layer depth
// bias so layers stack in order without z-fighting. It does not write
// depth, so decals never hide one another by depth; their draw order is
// their layer order, and within one decal later grid cells draw over
// earlier ones (a band that wraps round overlaps itself cleanly).
//
// Texture resolution: the artwork is drawn into a canvas at 24 px per mm of
// its size on the rocket, between 256 and 4096 px on its long side, rounded
// up to the next power-of-two size class so scaling a decal re-draws it
// only now and then. 24 px/mm keeps edges clean down to about 40 mm across
// the 1400 px wide view, closer than the rocket is normally worked on; a
// decal longer than 170 mm gets fewer px per mm (a 300 mm band: 13 px/mm).
// Mipmaps and anisotropic filtering keep it clean at grazing angles.

import * as THREE from 'three';
import type { Artwork } from '../geometry/artwork.ts';
import type { DecalGrid } from '../geometry/decal-map.ts';
import type { Vec3 } from '../geometry/vec3.ts';

// How far the decal sits off the surface, mm. A grid cell spanning a facet
// edge of the tessellation dips below the facets by up to half a cell times
// the facet angle (0.1 rad): 0.05 mm for the 2 mm cells used while dragging.
const lift = 0.1;
const pixelsPerMillimetre = 24;

// Draw the artwork's shapes, in painting order, in their vinyl colours.
export function drawArtwork(context: CanvasRenderingContext2D, artwork: Artwork, colourMap: Record<string, string>, scale: number): void {
  for (let s = 0; s < artwork.shapes.length; s++) {
    const shape = artwork.shapes[s];
    const path = new Path2D();
    for (let k = 0; k < shape.subpaths.length; k++) {
      const subpath = shape.subpaths[k];
      path.moveTo(subpath.start[0] * scale, subpath.start[1] * scale);
      for (let i = 0; i < subpath.segments.length; i++) {
        const segment = subpath.segments[i];
        if (segment.kind === 'line') {
          path.lineTo(segment.to[0] * scale, segment.to[1] * scale);
        } else {
          path.bezierCurveTo(segment.c1[0] * scale, segment.c1[1] * scale, segment.c2[0] * scale, segment.c2[1] * scale, segment.to[0] * scale, segment.to[1] * scale);
        }
      }
      path.closePath();
    }
    const mapped = colourMap[shape.colour];
    context.fillStyle = mapped === undefined ? shape.colour : mapped;
    context.fill(path, shape.fillRule);
  }
}

// The texture's long side in px for a decal whose long side is `longest` mm.
export function textureSize(longest: number): number {
  let sizeClass = 16;
  while (sizeClass < longest && sizeClass < 1 << 20) {
    sizeClass = sizeClass * 2;
  }
  const wanted = sizeClass * pixelsPerMillimetre;
  return Math.max(256, Math.min(4096, wanted));
}

export function rasterise(artwork: Artwork, colourMap: Record<string, string>, longSide: number): HTMLCanvasElement {
  const scale = longSide / Math.max(artwork.width, artwork.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(4, Math.ceil(artwork.width * scale));
  canvas.height = Math.max(4, Math.ceil(artwork.height * scale));
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('rasterise: no 2D canvas context');
  }
  drawArtwork(context, artwork, colourMap, scale);
  return canvas;
}

export class DecalVisual {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private texture: THREE.CanvasTexture | null = null;
  textureKey = '';
  gridKey = '';

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.MeshStandardMaterial({
      roughness: 0.45,
      metalness: 0,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  setTexture(canvas: HTMLCanvasElement, key: string, anisotropy: number): void {
    if (this.texture !== null) {
      this.texture.dispose();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = anisotropy;
    texture.premultiplyAlpha = true;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    this.texture = texture;
    this.material.map = texture;
    this.material.needsUpdate = true;
    this.textureKey = key;
  }

  // Layer 0 is the bottom. Each layer is pulled a little further towards
  // the viewer and drawn later.
  setLayer(layer: number): void {
    this.material.polygonOffsetUnits = -4 - 4 * layer;
    this.mesh.renderOrder = 100 + layer;
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
  }

  // Build the mesh from the mapped grid. u, v: where each grid point is in
  // the artwork, after flips (v = 1 at the artwork's top).
  setGrid(grid: DecalGrid, width: number, height: number, flipX: boolean, flipY: boolean, key: string): void {
    const count = grid.columns * grid.rows;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    for (let j = 0; j < grid.rows; j++) {
      for (let i = 0; i < grid.columns; i++) {
        const index = j * grid.columns + i;
        const nx = grid.normals[3 * index];
        const ny = grid.normals[3 * index + 1];
        const nz = grid.normals[3 * index + 2];
        positions[3 * index] = grid.positions[3 * index] + nx * lift;
        positions[3 * index + 1] = grid.positions[3 * index + 1] + ny * lift;
        positions[3 * index + 2] = grid.positions[3 * index + 2] + nz * lift;
        normals[3 * index] = nx;
        normals[3 * index + 1] = ny;
        normals[3 * index + 2] = nz;
        let x = grid.xs[i];
        let y = grid.ys[j];
        if (flipX) {
          x = -x;
        }
        if (flipY) {
          y = -y;
        }
        uvs[2 * index] = (x + width / 2) / width;
        uvs[2 * index + 1] = (y + height / 2) / height;
      }
    }
    // Two triangles per cell with all four corners on the surface, one
    // where three are (the edge of a hole or of the surface).
    const indices: number[] = [];
    for (let j = 0; j + 1 < grid.rows; j++) {
      for (let i = 0; i + 1 < grid.columns; i++) {
        const a = j * grid.columns + i;
        const b = a + 1;
        const c = a + grid.columns + 1;
        const d = a + grid.columns;
        const pa = grid.present[a] === 1;
        const pb = grid.present[b] === 1;
        const pc = grid.present[c] === 1;
        const pd = grid.present[d] === 1;
        // Counterclockwise seen from outside: x right, y up.
        if (pa && pb && pc && pd) {
          indices.push(a, b, c, a, c, d);
        } else if (pa && pb && pc) {
          indices.push(a, b, c);
        } else if (pa && pc && pd) {
          indices.push(a, c, d);
        } else if (pa && pb && pd) {
          indices.push(a, b, d);
        } else if (pb && pc && pd) {
          indices.push(b, c, d);
        }
      }
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(indices);
    this.geometry.computeBoundingSphere();
    this.gridKey = key;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    if (this.texture !== null) {
      this.texture.dispose();
    }
  }
}

// The selection: a white outline along the decal's edge on the surface,
// square handles at the corners (scale) and a round one above the top
// (rotate), with a stalk to it. The handles are white with a dark rim, so
// they read on black vinyl, on cerise and on the grey parts.
export class DecalHandles {
  readonly group: THREE.Group;
  private readonly outline: THREE.LineSegments;
  private readonly outlineMaterial: THREE.LineBasicMaterial;
  private readonly corners: THREE.Points;
  private readonly rotate: THREE.Points;

  constructor() {
    this.group = new THREE.Group();
    this.outlineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: true });
    this.outline = new THREE.LineSegments(new THREE.BufferGeometry(), this.outlineMaterial);
    this.outline.renderOrder = 300;
    this.outline.frustumCulled = false;
    this.corners = makeHandlePoints('square');
    this.rotate = makeHandlePoints('round');
    this.group.add(this.outline);
    this.group.add(this.corners);
    this.group.add(this.rotate);
    this.group.visible = false;
  }

  // segments: pairs of world points along the decal's edge (and the stalk);
  // corners and rotate: handle positions (only those facing the viewer).
  set(segments: number[], corners: number[], rotate: number[]): void {
    replacePositions(this.outline, segments);
    replacePositions(this.corners, corners);
    replacePositions(this.rotate, rotate);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}

function replacePositions(object: THREE.LineSegments | THREE.Points, values: number[]): void {
  object.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(values), 3));
  object.geometry = geometry;
  object.visible = values.length > 0;
}

export const handlePixels = 8;

function makeHandlePoints(shape: 'square' | 'round'): THREE.Points {
  const material = new THREE.PointsMaterial({
    size: handlePixels * window.devicePixelRatio,
    sizeAttenuation: false,
    map: handleTexture(shape),
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(new THREE.BufferGeometry(), material);
  points.renderOrder = 310;
  points.frustumCulled = false;
  return points;
}

function handleTexture(shape: 'square' | 'round'): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('handleTexture: no 2D canvas context');
  }
  const inset = 6;
  context.beginPath();
  if (shape === 'square') {
    context.rect(inset, inset, size - 2 * inset, size - 2 * inset);
  } else {
    context.arc(size / 2, size / 2, size / 2 - inset, 0, 2 * Math.PI);
  }
  context.fillStyle = '#ffffff';
  context.fill();
  context.lineWidth = 9;
  context.strokeStyle = '#1a1a1d';
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A point lifted off the surface along its normal.
export function lifted(p: Vec3, n: Vec3, amount: number): Vec3 {
  return [p[0] + n[0] * amount, p[1] + n[1] * amount, p[2] + n[2] * amount];
}
