// Decals in the 3D view: picking one up from the list and dropping it on the
// surface, sliding a placed one over the surface, scaling and turning it
// with handles drawn round it, and drawing them all.
//
// It works like the parts (pick up, follow the cursor, click to drop) and,
// once placed, like a 2D object in any drawing program: press and drag to
// move, corner handles to scale, the round handle above to turn (15 degree
// steps, Shift for free).
//
// The surface the decals walk on is every visible placed part (hidden parts
// take no decals). Mapping is done with a coarse grid while something is
// being dragged and the full grid when it is let go.
//
// The pointer can be in the 3D view or on the flat page. Both answer the
// same questions (DecalPointer: which surface point, decal or handle is
// under the pointer), so placing, sliding, turning and scaling a decal is
// this one piece of code whichever view it is done in.

import * as THREE from 'three';
import type { Artwork } from '../geometry/artwork.ts';
import type { Part } from '../geometry/part.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import { add, cross, dot, length, normalize, scale, sub } from '../geometry/vec3.ts';
import type { Surface, SurfacePiece, SurfacePoint } from '../geometry/geodesic.ts';
import { makePiece, nearestOnPiece, pieceIndex, raycastSurface, startWalk, walk, worldNormal, worldPoint } from '../geometry/geodesic.ts';
import type { DecalFrame, DecalGrid } from '../geometry/decal-map.ts';
import { anchorOf, angleInPlane, cellSizeFor, defaultRight, followCursor, frameAt, frameOf, gridNormal, gridPoint, mapDecal, rotateInPlane, upOf, walkFrame } from '../geometry/decal-map.ts';
import type { SurfaceMesh } from '../geometry/surface-mesh.ts';
import { buildSurfaceMesh } from '../geometry/surface-mesh.ts';
import { importSvg } from '../geometry/svg-import.ts';
import { AFT_DIRECTION } from '../geometry/rocket-axis.ts';
import type { AssemblyDocument } from '../model/document.ts';
import { findPlaced } from '../model/document.ts';
import type { Decal, NewDecal } from '../model/decals.ts';
import { addDecal, decalGroup, duplicateDecal, findDecal, removeDecalGroup, reorderDecals, requireDecal, setDecalColour, setPartColour, updateDecal } from '../model/decals.ts';
import { decalSymmetryChoices, makeDecalUnique, setDecalSymmetry, syncDecalGroup } from '../model/decal-symmetry.ts';
import { symmetryMembers } from '../model/document.ts';
import type { Editor, LastOperation } from './editor.ts';
import { DecalHandles, DecalVisual, lifted, rasterise, textureSize } from './decal-visuals.ts';
import { pickPart, worldFace } from './picking.ts';

// Screen distance (CSS px) within which the cursor is on a handle.
const handleReach = 9;
// The rotate handle sits this far (CSS px) above the decal's top edge.
const rotateHandleOffset = 26;
// A press that moves less than this (CSS px) is a click.
const clickSlop = 5;

export type Handle = 'scale' | 'rotate';

// What a view tells the decal tool about the pointer (x, y: client pixels).
export interface DecalPointer {
  // On the page, sliding a decal off one island onto another moves it there
  // (its anchor jumps to the other surface); in 3D it stops at the edge.
  readonly jumps: boolean;
  // The surface point under the pointer, on surfaceFor(document), or null.
  surfaceUnder(x: number, y: number): SurfacePoint | null;
  // The topmost pickable decal under the pointer, and the point in its own
  // frame (mm from its centre).
  decalUnder(x: number, y: number): { id: string; x: number; y: number } | null;
  handleUnder(x: number, y: number): Handle | null;
  // The world direction a new decal's right takes here, so it is upright as
  // this view shows it; null for the default (artwork up is world up).
  rightAt(x: number, y: number): Vec3 | null;
  // The selected decal's plane as this view shows it, when a handle drag
  // begins at (x, y): it turns pointer positions into mm along the decal's
  // right and up from its centre.
  planeOf(decalId: string, frame: DecalFrame, x: number, y: number): DecalPlane | null;
  // The distance or angle beside the cursor during a handle drag.
  showLabel(x: number, y: number, text: string): void;
  hideLabel(): void;
}

export interface DecalPlane {
  coordinates(x: number, y: number): [number, number] | null;
}

interface Held {
  artworkId: string;
  // A duplicate carries the original's settings; a new decal has none.
  template: NewDecal | null;
  frame: DecalFrame | null;
}

interface Drag {
  pointer: DecalPointer;
  decalId: string;
  before: AssemblyDocument;
  start: Decal;
  // Where the decal was grabbed, in its own frame (mm from its centre).
  grabX: number;
  grabY: number;
  // The frame at the cursor, carried along from step to step.
  cursor: DecalFrame | null;
  pressX: number;
  pressY: number;
  moved: boolean;
  latest: { anchor: Decal['anchor']; rotation: number } | null;
}

interface HandleDrag {
  pointer: DecalPointer;
  handle: Handle;
  decalId: string;
  before: AssemblyDocument;
  start: Decal;
  // The decal's plane when the drag began, and where the cursor was on it
  // (mm along the decal's right and up from its centre).
  plane: DecalPlane;
  from: [number, number];
  latest: Partial<NewDecal> | null;
}

export class DecalTool {
  private readonly editor: Editor;
  readonly artworks = new Map<string, Artwork>();
  readonly artworkOrder: string[] = [];
  // The SVG text each artwork was read from (the project file keeps it).
  readonly artworkSources = new Map<string, { fileName: string; text: string }>();
  private nextArtwork = 1;
  selectedId: string | null = null;

  private held: Held | null = null;
  private drag: Drag | null = null;
  private handleDrag: HandleDrag | null = null;

  private readonly group = new THREE.Group();
  private readonly visuals = new Map<string, DecalVisual>();
  private heldVisual: DecalVisual | null = null;
  private readonly handles = new DecalHandles();
  // The latest grid of each decal drawn (by id), for picking and handles.
  private readonly grids = new Map<string, DecalGrid>();
  // By part object, not id: a project opened later may reuse an id.
  private readonly meshes = new WeakMap<Part, SurfaceMesh>();
  private surfaceKey = '';
  private surface: Surface = { pieces: [] };
  // Screen-space handles of the selected decal: where they are in the world.
  private handlePoints: Array<{ handle: Handle; point: Vec3; normal: Vec3 }> = [];
  private readonly label: HTMLDivElement;
  // Milliseconds per decal re-map while dragging, and per whole drag step
  // (finding the place, re-mapping, drawing the 3D scene), for the e2e report.
  readonly mapTimes: number[] = [];
  readonly dragStepTimes: number[] = [];
  private shift = false;
  // The 3D view as a pointer source.
  readonly view3d: DecalPointer;
  // The grid of the decal being held, for the page to draw too.
  heldGrid: DecalGrid | null = null;

  constructor(editor: Editor, labelParent: HTMLElement) {
    this.editor = editor;
    editor.view.scene.add(this.group);
    editor.view.overlayGroup.add(this.handles.group);
    this.label = document.createElement('div');
    this.label.className = 'decal-label';
    labelParent.appendChild(this.label);
    const self = this;
    this.view3d = {
      jumps: false,
      surfaceUnder: function surfaceUnder(x: number, y: number): SurfacePoint | null {
        return self.surfaceUnder3d(x, y);
      },
      decalUnder: function decalUnder(x: number, y: number) {
        return self.decalUnder(x, y);
      },
      handleUnder: function handleUnder(x: number, y: number): Handle | null {
        return self.handleUnder(x, y);
      },
      // In 3D a new decal stands upright in the world (see defaultUp).
      rightAt: function rightAt(): Vec3 | null {
        return null;
      },
      // (The 3D plane is the decal's tangent plane; which decal is in the frame.)
      planeOf: function planeOf(_decalId: string, frame: DecalFrame): DecalPlane | null {
        return self.plane3d(frame);
      },
      showLabel: function showLabel(x: number, y: number, text: string): void {
        self.label.textContent = text;
        self.label.style.display = 'block';
        const parent = self.label.parentElement;
        if (parent !== null) {
          const rect = parent.getBoundingClientRect();
          self.label.style.left = String(x - rect.left + 16) + 'px';
          self.label.style.top = String(y - rect.top + 14) + 'px';
        }
      },
      hideLabel: function hideLabel(): void {
        self.label.style.display = 'none';
      },
    };
    // The handles keep a constant size on screen, so they follow the camera.
    editor.view.onBeforeRender(function placeHandles() {
      self.updateHandles();
    });
  }

  // ---------------------------------------------------------------------------
  // Artwork.

  // Read an SVG file into the artwork list. Returns notices for the user.
  addArtwork(text: string, fileName: string): { artwork: Artwork | null; notices: string[] } {
    const id = 'a' + String(this.nextArtwork);
    this.nextArtwork = this.nextArtwork + 1;
    return this.readArtwork(id, text, fileName, true);
  }

  // Artwork from a project, under the id it had. `listed`: shown in the
  // artwork list (artwork replaced by an edited file is kept, unlisted,
  // for undo).
  restoreArtwork(id: string, text: string, fileName: string, listed: boolean): { artwork: Artwork | null; notices: string[] } {
    const number = parseInt(id.replace(/\D/g, ''), 10);
    if (Number.isFinite(number) && number >= this.nextArtwork) {
      this.nextArtwork = number + 1;
    }
    return this.readArtwork(id, text, fileName, listed);
  }

  private readArtwork(id: string, text: string, fileName: string, listed: boolean): { artwork: Artwork | null; notices: string[] } {
    const name = fileName.replace(/\.svg$/i, '');
    const result = importSvg(text, name, id);
    if (result.artwork !== null) {
      this.artworks.set(id, result.artwork);
      this.artworkSources.set(id, { fileName: fileName, text: text });
      if (listed) {
        this.artworkOrder.push(id);
      }
    }
    return { artwork: result.artwork, notices: result.notices };
  }

  // Forget all artwork and decal state (New, or a project opened).
  reset(): void {
    this.held = null;
    this.drag = null;
    this.handleDrag = null;
    this.heldGrid = null;
    this.selectedId = null;
    this.artworks.clear();
    this.artworkSources.clear();
    this.artworkOrder.length = 0;
    this.nextArtwork = 1;
  }

  requireArtwork(id: string): Artwork {
    const artwork = this.artworks.get(id);
    if (artwork === undefined) {
      throw new Error('expected an artwork with id ' + id);
    }
    return artwork;
  }

  // Put new artwork into an existing decal, keeping where it is, how it is
  // turned and its scale (mm on the rocket per mm of artwork), and the
  // colour choices for colours that are still there.
  replaceArtwork(decalId: string, artwork: Artwork): void {
    const doc = this.editor.document;
    const decal = requireDecal(doc, decalId);
    const old = this.requireArtwork(decal.artworkId);
    const scaleX = decal.width / old.width;
    const scaleY = decal.height / old.height;
    const colourMap: Record<string, string> = {};
    for (let i = 0; i < artwork.colours.length; i++) {
      const kept = decal.colourMap[artwork.colours[i]];
      if (kept !== undefined) {
        colourMap[artwork.colours[i]] = kept;
      }
    }
    const next = updateDecal(doc, decalId, {
      artworkId: artwork.id,
      width: artwork.width * scaleX,
      height: artwork.height * scaleY,
      colourMap: colourMap,
    });
    this.editor.commitDocument(this.linked(next, decalId), null);
  }

  // ---------------------------------------------------------------------------
  // The surface.

  private meshOf(part: Part): SurfaceMesh {
    let mesh = this.meshes.get(part);
    if (mesh === undefined) {
      mesh = buildSurfaceMesh(part);
      this.meshes.set(part, mesh);
    }
    return mesh;
  }

  // The visible placed parts of a document as one surface (rebuilt only
  // when parts move, appear, or are hidden).
  surfaceFor(doc: AssemblyDocument): Surface {
    const keyParts: unknown[] = [];
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      if (!placed.hidden) {
        keyParts.push(placed.id, placed.partId, placed.transform);
      }
    }
    const key = JSON.stringify(keyParts);
    if (key === this.surfaceKey) {
      return this.surface;
    }
    const pieces: SurfacePiece[] = [];
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      if (placed.hidden) {
        continue;
      }
      const part = this.editor.parts.get(placed.partId);
      if (part === undefined) {
        continue;
      }
      pieces.push(makePiece(placed.id, this.meshOf(part), part.bvh, part.positions, part.indices, placed.transform));
    }
    this.surface = { pieces: pieces };
    this.surfaceKey = key;
    return this.surface;
  }

  // Re-derive each anchor's world position and normal (they are kept for
  // re-attachment later, and go stale when a part moves).
  refreshAnchors(doc: AssemblyDocument): void {
    const surface = this.surfaceFor(doc);
    for (let i = 0; i < doc.decals.length; i++) {
      const decal = doc.decals[i];
      const frame = frameOf(surface, decal.anchor, decal.rotation);
      if (frame === null) {
        continue;
      }
      decal.anchor.position = worldPoint(surface, frame.at);
      decal.anchor.normal = worldNormal(surface, frame.at);
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing.

  isBusy(): boolean {
    return this.held !== null || this.drag !== null || this.handleDrag !== null;
  }

  isHolding(): boolean {
    return this.held !== null;
  }

  // The decals being dragged or handled right now (with their linked copies).
  movingIds(): Set<string> {
    const ids = new Set<string>();
    let id: string | null = null;
    if (this.drag !== null) {
      id = this.drag.decalId;
    } else if (this.handleDrag !== null) {
      id = this.handleDrag.decalId;
    }
    if (id === null || findDecal(this.editor.document, id) === null) {
      return ids;
    }
    const members = decalGroup(this.editor.document, id);
    for (let i = 0; i < members.length; i++) {
      ids.add(members[i].id);
    }
    return ids;
  }

  heldArtworkId(): string | null {
    return this.held === null ? null : this.held.artworkId;
  }

  private timedMap(surface: Surface, frame: DecalFrame, width: number, height: number, fine: boolean): DecalGrid {
    const start = performance.now();
    const grid = mapDecal(surface, frame, width, height, cellSizeFor(width, height, fine));
    if (!fine) {
      this.mapTimes.push(performance.now() - start);
      if (this.mapTimes.length > 400) {
        this.mapTimes.shift();
      }
    }
    return grid;
  }

  private dressVisual(visual: DecalVisual, artworkId: string, colourMap: Record<string, string>, width: number, height: number): void {
    const artwork = this.requireArtwork(artworkId);
    const size = textureSize(Math.max(width, height));
    const key = artworkId + '|' + JSON.stringify(colourMap) + '|' + String(size);
    if (visual.textureKey !== key) {
      const anisotropy = this.editor.view.renderer.capabilities.getMaxAnisotropy();
      visual.setTexture(rasterise(artwork, colourMap, size), key, anisotropy);
    }
  }

  // Make the drawn decals match a document (the shown one).
  sync(doc: AssemblyDocument): void {
    const surface = this.surfaceFor(doc);
    const fine = !this.isBusy();
    const present = new Set<string>();
    for (let layer = 0; layer < doc.decals.length; layer++) {
      const decal = doc.decals[layer];
      if (decal.hidden || !this.artworks.has(decal.artworkId)) {
        continue;
      }
      let visual = this.visuals.get(decal.id);
      if (visual === undefined) {
        visual = new DecalVisual();
        this.visuals.set(decal.id, visual);
        this.group.add(visual.mesh);
      }
      present.add(decal.id);
      const key = JSON.stringify([decal.anchor.placedId, decal.anchor.triangle, decal.anchor.barycentric, decal.rotation, decal.width, decal.height, decal.flipX, decal.flipY, fine, this.surfaceKey]);
      if (visual.gridKey !== key) {
        const frame = frameOf(surface, decal.anchor, decal.rotation);
        if (frame === null) {
          visual.mesh.visible = false;
          this.grids.delete(decal.id);
          continue;
        }
        const grid = this.timedMap(surface, frame, decal.width, decal.height, fine);
        visual.setGrid(grid, decal.width, decal.height, decal.flipX, decal.flipY, key);
        this.grids.set(decal.id, grid);
      }
      visual.mesh.visible = true;
      this.dressVisual(visual, decal.artworkId, decal.colourMap, decal.width, decal.height);
      visual.setLayer(layer);
    }
    const self = this;
    this.visuals.forEach(function removeStale(visual, id) {
      if (!present.has(id)) {
        self.group.remove(visual.mesh);
        visual.dispose();
        self.visuals.delete(id);
        self.grids.delete(id);
      }
    });
    this.syncHeld(doc);
    if (this.selectedId !== null && findDecal(doc, this.selectedId) === null) {
      this.selectedId = null;
    }
    this.updateHandles();
    this.editor.view.requestRender();
  }

  private syncHeld(doc: AssemblyDocument): void {
    const held = this.held;
    if (held === null || held.frame === null) {
      this.heldGrid = null;
      if (this.heldVisual !== null) {
        this.heldVisual.mesh.visible = false;
      }
      return;
    }
    if (this.heldVisual === null) {
      this.heldVisual = new DecalVisual();
      this.group.add(this.heldVisual.mesh);
    }
    const settings = this.heldSettings(held);
    const surface = this.surfaceFor(doc);
    const grid = this.timedMap(surface, held.frame, settings.width, settings.height, false);
    this.heldGrid = grid;
    this.heldVisual.setGrid(grid, settings.width, settings.height, settings.flipX, settings.flipY, '');
    this.dressVisual(this.heldVisual, held.artworkId, settings.colourMap, settings.width, settings.height);
    this.heldVisual.setLayer(doc.decals.length);
    this.heldVisual.mesh.visible = true;
  }

  // The settings of the decal being held, or null.
  heldSettingsNow(): NewDecal | null {
    if (this.held === null) {
      return null;
    }
    return this.heldSettings(this.held);
  }

  private heldSettings(held: Held): NewDecal {
    if (held.template !== null) {
      return held.template;
    }
    const artwork = this.requireArtwork(held.artworkId);
    return {
      name: artwork.name,
      artworkId: artwork.id,
      anchor: { placedId: '', triangle: 0, barycentric: [1, 0, 0], position: [0, 0, 0], normal: [0, 0, 1] },
      rotation: 0,
      width: artwork.width,
      height: artwork.height,
      flipX: false,
      flipY: false,
      hidden: false,
      locked: false,
      colourMap: {},
      symmetry: null,
    };
  }

  // The selection outline and handles of the selected decal.
  private updateHandles(): void {
    this.handlePoints = [];
    const id = this.selectedId;
    const doc = this.editor.shownDocument;
    const decal = id === null ? null : findDecal(doc, id);
    const grid = id === null ? undefined : this.grids.get(id);
    if (decal === null || grid === undefined || decal.hidden || this.held !== null || this.drag !== null) {
      this.handles.hide();
      return;
    }
    const view = this.editor.view;
    const cameraPosition: Vec3 = [view.camera.position.x, view.camera.position.y, view.camera.position.z];
    const segments: number[] = [];
    const outlineLift = 0.2;
    // Round the edge of the grid: bottom, right, top, left.
    const edge: Array<[number, number]> = [];
    for (let i = 0; i < grid.columns; i++) {
      edge.push([i, 0]);
    }
    for (let j = 1; j < grid.rows; j++) {
      edge.push([grid.columns - 1, j]);
    }
    for (let i = grid.columns - 2; i >= 0; i--) {
      edge.push([i, grid.rows - 1]);
    }
    for (let j = grid.rows - 2; j >= 0; j--) {
      edge.push([0, j]);
    }
    for (let k = 0; k < edge.length; k++) {
      const a = edge[k];
      const b = edge[(k + 1) % edge.length];
      const pa = gridPoint(grid, a[0], a[1]);
      const pb = gridPoint(grid, b[0], b[1]);
      if (pa === null || pb === null) {
        continue;
      }
      const la = lifted(pa, gridNormal(grid, a[0], a[1]), outlineLift);
      const lb = lifted(pb, gridNormal(grid, b[0], b[1]), outlineLift);
      segments.push(la[0], la[1], la[2], lb[0], lb[1], lb[2]);
    }
    const corners: number[] = [];
    const cornerCells: Array<[number, number]> = [
      [0, 0],
      [grid.columns - 1, 0],
      [grid.columns - 1, grid.rows - 1],
      [0, grid.rows - 1],
    ];
    for (let k = 0; k < cornerCells.length; k++) {
      const p = gridPoint(grid, cornerCells[k][0], cornerCells[k][1]);
      if (p === null) {
        continue;
      }
      const n = gridNormal(grid, cornerCells[k][0], cornerCells[k][1]);
      if (dot(n, sub(cameraPosition, p)) <= 0) {
        continue; // facing away
      }
      const l = lifted(p, n, outlineLift);
      corners.push(l[0], l[1], l[2]);
      this.handlePoints.push({ handle: 'scale', point: l, normal: n });
    }
    // The rotate handle: walk up from the top edge's middle by a fixed
    // screen distance, drawing the stalk as it goes.
    const rotate: number[] = [];
    const surface = this.surfaceFor(doc);
    const frame = frameOf(surface, decal.anchor, decal.rotation);
    if (frame !== null) {
      const anchorWorld = worldPoint(surface, frame.at);
      const extra = rotateHandleOffset * view.millimetresPerPixel(anchorWorld);
      const walker = startWalk(surface, frame.at, upOf(surface, frame));
      if (walker !== null) {
        walk(surface, walker, decal.height / 2);
        const steps = 6;
        let previous: Vec3 | null = null;
        for (let s = 0; s <= steps && walker.alive; s++) {
          if (s > 0) {
            walk(surface, walker, extra / steps);
          }
          if (!walker.alive) {
            break;
          }
          const p = worldPoint(surface, walker);
          const n = worldNormal(surface, walker);
          const l = lifted(p, n, outlineLift);
          if (previous !== null) {
            segments.push(previous[0], previous[1], previous[2], l[0], l[1], l[2]);
          }
          previous = l;
          if (s === steps && dot(n, sub(cameraPosition, p)) > 0) {
            rotate.push(l[0], l[1], l[2]);
            this.handlePoints.push({ handle: 'rotate', point: l, normal: n });
          }
        }
      }
    }
    this.handles.set(segments, corners, rotate);
  }

  // ---------------------------------------------------------------------------
  // Picking.

  // The topmost unlocked visible decal under a ray: its id, the point's
  // coordinates in the decal's own frame, and the distance along the ray.
  pickDecal(origin: Vec3, direction: Vec3): { id: string; x: number; y: number; distance: number } | null {
    const doc = this.editor.shownDocument;
    let best: { id: string; x: number; y: number; distance: number } | null = null;
    for (let layer = doc.decals.length - 1; layer >= 0; layer--) {
      const decal = doc.decals[layer];
      if (decal.hidden || decal.locked) {
        continue;
      }
      const grid = this.grids.get(decal.id);
      if (grid === undefined) {
        continue;
      }
      const hit = raycastGrid(grid, origin, direction);
      if (hit === null) {
        continue;
      }
      // A lower layer only wins if it is clearly nearer (not the same spot).
      if (best === null || hit.distance < best.distance - 0.5) {
        best = { id: decal.id, x: hit.x, y: hit.y, distance: hit.distance };
      }
    }
    return best;
  }

  // Is a decal (not hidden by a part in front of it) under the cursor?
  decalUnder(clientX: number, clientY: number): { id: string; x: number; y: number } | null {
    const ray = this.editor.view.rayAt(clientX, clientY);
    const hit = this.pickDecal(ray.origin, ray.direction);
    if (hit === null) {
      return null;
    }
    const part = pickPart(this.editor.shownDocument, this.editor.parts, ray.origin, ray.direction, new Set<string>());
    if (part !== null && part.distance < hit.distance - 1) {
      return null; // a part is in front
    }
    return hit;
  }

  handleUnder(clientX: number, clientY: number): Handle | null {
    const view = this.editor.view;
    let best: Handle | null = null;
    let bestDistance = handleReach;
    for (let i = 0; i < this.handlePoints.length; i++) {
      const screen = view.toScreen(this.handlePoints[i].point);
      const d = Math.hypot(screen.x - clientX, screen.y - clientY);
      if (d <= bestDistance) {
        bestDistance = d;
        best = this.handlePoints[i].handle;
      }
    }
    return best;
  }

  // Where the cursor ray meets the surface (visible parts), or null; null
  // off the 3D view (over the page, say).
  surfaceUnder3d(clientX: number, clientY: number): SurfacePoint | null {
    const rect = this.editor.view.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    const ray = this.editor.view.rayAt(clientX, clientY);
    const surface = this.surfaceFor(this.editor.document);
    const hit = raycastSurface(surface, ray.origin, ray.direction);
    if (hit === null) {
      return null;
    }
    return hit.at;
  }

  // The cursor shape over the 3D view, or null if decals have nothing to say.
  cursorAt(pointer: DecalPointer, clientX: number, clientY: number): string | null {
    if (this.held !== null || this.drag !== null) {
      return 'grabbing';
    }
    if (this.handleDrag !== null) {
      return this.handleDrag.handle === 'scale' ? 'nwse-resize' : 'grabbing';
    }
    const handle = pointer.handleUnder(clientX, clientY);
    if (handle === 'scale') {
      return 'nwse-resize';
    }
    if (handle === 'rotate') {
      return 'grab';
    }
    if (pointer.decalUnder(clientX, clientY) !== null) {
      return 'move';
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Holding a new decal.

  pickArtwork(artworkId: string): void {
    this.requireArtwork(artworkId);
    this.held = { artworkId: artworkId, template: null, frame: null };
    this.selectedId = null;
    this.editor.decalHoldStarted();
  }

  // Ctrl+D: a copy of the selected decal follows the cursor.
  duplicateSelected(): void {
    if (this.selectedId === null) {
      return;
    }
    const decal = findDecal(this.editor.document, this.selectedId);
    if (decal === null) {
      return;
    }
    const template: NewDecal = JSON.parse(JSON.stringify(decal)) as NewDecal;
    delete (template as Partial<Decal>).id;
    template.name = decal.name + ' copy';
    template.locked = false;
    template.hidden = false;
    template.symmetry = null;
    this.held = { artworkId: decal.artworkId, template: template, frame: null };
    this.selectedId = null;
    this.editor.decalHoldStarted();
  }

  cancelHeld(): boolean {
    if (this.held === null) {
      return false;
    }
    this.held = null;
    this.heldGrid = null;
    this.editor.redraw();
    return true;
  }

  // Follow the cursor: stuck to the surface under it at true size, upright.
  updateHeld(pointer: DecalPointer, clientX: number, clientY: number): void {
    const held = this.held;
    if (held === null) {
      return;
    }
    const at = pointer.surfaceUnder(clientX, clientY);
    held.frame = null;
    if (at !== null) {
      const surface = this.surfaceFor(this.editor.document);
      const normal = worldNormal(surface, at);
      const rotation = held.template === null ? 0 : held.template.rotation;
      let right = rotateInPlane(defaultRight(normal), normal, rotation);
      const viewRight = pointer.rightAt(clientX, clientY);
      if (held.template === null && viewRight !== null) {
        right = viewRight;
      }
      held.frame = frameAt(surface, at, right);
    }
    this.syncHeld(this.editor.shownDocument);
    this.editor.view.requestRender();
  }

  // Click: drop the held decal where it is.
  dropHeld(pointer: DecalPointer, clientX: number, clientY: number): void {
    const held = this.held;
    if (held === null) {
      return;
    }
    this.updateHeld(pointer, clientX, clientY);
    if (held.frame === null) {
      return; // not over the rocket: keep holding
    }
    const surface = this.surfaceFor(this.editor.document);
    const stored = anchorOf(surface, held.frame);
    const settings = this.heldSettings(held);
    settings.anchor = stored.anchor;
    settings.rotation = stored.rotation;
    const added = addDecal(this.editor.document, settings);
    this.held = null;
    this.heldGrid = null;
    this.selectedId = added.id;
    this.editor.commitDocument(added.doc, null);
  }

  // A new decal of this artwork at a surface point (an SVG file dropped
  // onto the page), with its right along `right` (null: the default).
  placeArtworkAt(artworkId: string, at: SurfacePoint, right: Vec3 | null): void {
    const surface = this.surfaceFor(this.editor.document);
    const normal = worldNormal(surface, at);
    const frame = frameAt(surface, at, right === null ? defaultRight(normal) : right);
    if (frame === null) {
      return;
    }
    const stored = anchorOf(surface, frame);
    const settings = this.heldSettings({ artworkId: artworkId, template: null, frame: frame });
    settings.anchor = stored.anchor;
    settings.rotation = stored.rotation;
    const added = addDecal(this.editor.document, settings);
    this.selectedId = added.id;
    this.editor.commitDocument(added.doc, null);
  }

  // ---------------------------------------------------------------------------
  // Pressing, dragging, letting go.

  // A press in a view. Returns true if it belongs to the decals.
  pointerDown(pointer: DecalPointer, clientX: number, clientY: number): boolean {
    if (this.held !== null) {
      return true; // the release drops it
    }
    const handle = pointer.handleUnder(clientX, clientY);
    if (handle !== null && this.selectedId !== null) {
      this.startHandleDrag(pointer, handle, clientX, clientY);
      return this.handleDrag !== null;
    }
    const under = pointer.decalUnder(clientX, clientY);
    if (under === null) {
      return false;
    }
    this.select(under.id);
    const decal = requireDecal(this.editor.document, under.id);
    this.drag = {
      pointer: pointer,
      decalId: under.id,
      before: this.editor.document,
      start: JSON.parse(JSON.stringify(decal)) as Decal,
      grabX: under.x,
      grabY: under.y,
      cursor: null,
      pressX: clientX,
      pressY: clientY,
      moved: false,
      latest: null,
    };
    return true;
  }

  pointerMove(pointer: DecalPointer, clientX: number, clientY: number, shift: boolean): void {
    this.shift = shift;
    if (this.held !== null) {
      this.updateHeld(pointer, clientX, clientY);
      return;
    }
    if (this.handleDrag !== null) {
      if (this.handleDrag.pointer === pointer) {
        this.updateHandleDrag(clientX, clientY);
      }
      return;
    }
    const drag = this.drag;
    if (drag === null || drag.pointer !== pointer) {
      return;
    }
    if (!drag.moved) {
      if (Math.hypot(clientX - drag.pressX, clientY - drag.pressY) <= clickSlop) {
        return;
      }
      drag.moved = true;
    }
    this.updateDrag(clientX, clientY);
  }

  // Returns true if the release belonged to the decals.
  pointerUp(pointer: DecalPointer, clientX: number, clientY: number, overCanvas: boolean): boolean {
    if (this.held !== null) {
      if (overCanvas) {
        this.dropHeld(pointer, clientX, clientY);
      }
      return true;
    }
    if (this.handleDrag !== null) {
      this.finishHandleDrag();
      return true;
    }
    const drag = this.drag;
    if (drag === null) {
      return false;
    }
    this.drag = null;
    if (!drag.moved || drag.latest === null) {
      this.editor.redraw();
      return true;
    }
    const next = this.linked(updateDecal(drag.before, drag.decalId, drag.latest), drag.decalId);
    const surface = this.surfaceFor(drag.before);
    const startFrame = frameOf(surface, drag.start.anchor, drag.start.rotation);
    const endFrame = frameOf(surface, drag.latest.anchor, drag.latest.rotation);
    let along = 0;
    let around = 0;
    if (startFrame !== null && endFrame !== null) {
      const measured = alongAndAround(worldPoint(surface, startFrame.at), worldPoint(surface, endFrame.at));
      along = measured.along;
      around = measured.around;
    }
    const operation: LastOperation = { kind: 'decal-move', decalId: drag.decalId, before: drag.before, start: drag.start, along: along, around: around };
    this.editor.commitDocument(next, operation);
    return true;
  }

  private updateDrag(clientX: number, clientY: number): void {
    const drag = this.drag;
    if (drag === null) {
      return;
    }
    const started = performance.now();
    this.dragStep(drag, clientX, clientY);
    this.dragStepTimes.push(performance.now() - started);
    if (this.dragStepTimes.length > 400) {
      this.dragStepTimes.shift();
    }
  }

  private dragStep(drag: Drag, clientX: number, clientY: number): void {
    const surface = this.surfaceFor(drag.before);
    const at = drag.pointer.surfaceUnder(clientX, clientY);
    if (at === null) {
      return; // off the rocket: the decal stays where it last was
    }
    let previous = drag.cursor;
    if (previous === null) {
      // First step: the frame at the grabbed point, carried there from the anchor.
      const startFrame = frameOf(surface, drag.start.anchor, drag.start.rotation);
      if (startFrame === null) {
        return;
      }
      const atGrab = walkFrame(surface, startFrame, drag.grabX, drag.grabY);
      previous = atGrab === null ? startFrame : atGrab;
    }
    let cursorFrame = followCursor(surface, previous, at);
    if (cursorFrame === null) {
      return;
    }
    // On the page the pointer can go where no walk along the surface leads
    // (onto another island, or round the rocket in one move): the decal
    // goes there, keeping its angle from upright.
    const missedBy = length(sub(worldPoint(surface, cursorFrame.at), worldPoint(surface, at)));
    if (drag.pointer.jumps && missedBy > 1) {
      const normal = worldNormal(surface, at);
      const latestRotation = drag.latest === null ? drag.start.rotation : drag.latest.rotation;
      const jumped = frameAt(surface, at, rotateInPlane(defaultRight(normal), normal, latestRotation));
      if (jumped !== null) {
        cursorFrame = jumped;
      }
    }
    drag.cursor = cursorFrame;
    // From the cursor back to the decal's centre.
    const anchorFrame = walkFrame(surface, cursorFrame, -drag.grabX, -drag.grabY);
    if (anchorFrame === null) {
      return; // the centre would be off the surface
    }
    const stored = anchorOf(surface, anchorFrame);
    drag.latest = { anchor: stored.anchor, rotation: stored.rotation };
    this.editor.previewDocument(this.linked(updateDecal(drag.before, drag.decalId, drag.latest), drag.decalId));
  }

  private startHandleDrag(pointer: DecalPointer, handle: Handle, clientX: number, clientY: number): void {
    if (this.selectedId === null) {
      return;
    }
    const doc = this.editor.document;
    const decal = requireDecal(doc, this.selectedId);
    const surface = this.surfaceFor(doc);
    const frame = frameOf(surface, decal.anchor, decal.rotation);
    if (frame === null) {
      return;
    }
    const plane = pointer.planeOf(decal.id, frame, clientX, clientY);
    if (plane === null) {
      return;
    }
    const from = plane.coordinates(clientX, clientY);
    if (from === null) {
      return;
    }
    this.handleDrag = {
      pointer: pointer,
      handle: handle,
      decalId: decal.id,
      before: doc,
      start: JSON.parse(JSON.stringify(decal)) as Decal,
      plane: plane,
      from: from,
      latest: null,
    };
  }

  // The decal's tangent plane at its anchor, seen through the 3D view.
  private plane3d(frame: DecalFrame): DecalPlane | null {
    const surface = this.surfaceFor(this.editor.document);
    const centre = worldPoint(surface, frame.at);
    const normal = worldNormal(surface, frame.at);
    const right = frame.right;
    const up = upOf(surface, frame);
    const self = this;
    return {
      coordinates: function coordinates(x: number, y: number): [number, number] | null {
        const onPlane = self.onPlane(x, y, centre, normal);
        if (onPlane === null) {
          return null;
        }
        const offset = sub(onPlane, centre);
        return [dot(offset, right), dot(offset, up)];
      },
    };
  }

  // Where the cursor ray meets a plane, or null if it runs along it.
  private onPlane(clientX: number, clientY: number, point: Vec3, normal: Vec3): Vec3 | null {
    const ray = this.editor.view.rayAt(clientX, clientY);
    const along = dot(ray.direction, normal);
    if (Math.abs(along) < 1e-6) {
      return null;
    }
    const t = dot(sub(point, ray.origin), normal) / along;
    return add(ray.origin, scale(ray.direction, t));
  }

  private updateHandleDrag(clientX: number, clientY: number): void {
    const drag = this.handleDrag;
    if (drag === null) {
      return;
    }
    const now = drag.plane.coordinates(clientX, clientY);
    if (now === null) {
      return;
    }
    const startOffset = drag.from;
    const offset = now;
    let text = '';
    if (drag.handle === 'scale') {
      // Uniform, about the centre: the corner follows the cursor's distance.
      const startDistance = Math.hypot(startOffset[0], startOffset[1]);
      if (startDistance < 1e-6) {
        return;
      }
      let factor = Math.hypot(offset[0], offset[1]) / startDistance;
      const smallest = 1 / Math.min(drag.start.width, drag.start.height);
      factor = Math.max(factor, smallest);
      const width = drag.start.width * factor;
      const height = drag.start.height * factor;
      drag.latest = { width: width, height: height };
      text = width.toFixed(1) + ' × ' + height.toFixed(1) + ' mm';
    } else {
      const startAngle = Math.atan2(startOffset[1], startOffset[0]);
      const angle = Math.atan2(offset[1], offset[0]);
      let rotation = drag.start.rotation + (angle - startAngle);
      if (!this.shift) {
        const step = (15 * Math.PI) / 180;
        rotation = Math.round(rotation / step) * step;
      }
      drag.latest = { rotation: rotation };
      text = formatDegrees((rotation * 180) / Math.PI);
    }
    drag.pointer.showLabel(clientX, clientY, text);
    this.editor.previewDocument(this.linked(updateDecal(drag.before, drag.decalId, drag.latest), drag.decalId));
  }

  private finishHandleDrag(): void {
    const drag = this.handleDrag;
    this.handleDrag = null;
    if (drag !== null) {
      drag.pointer.hideLabel();
    }
    if (drag === null || drag.latest === null) {
      this.editor.redraw();
      return;
    }
    const next = this.linked(updateDecal(drag.before, drag.decalId, drag.latest), drag.decalId);
    const decal = requireDecal(next, drag.decalId);
    let operation: LastOperation;
    if (drag.handle === 'scale') {
      operation = { kind: 'decal-scale', decalId: drag.decalId, before: drag.before, start: drag.start, width: decal.width, height: decal.height };
    } else {
      // The panel shows the angle from upright (as the handle snaps it), so
      // typing 0 stands the decal upright again.
      const degrees = (decal.rotation * 180) / Math.PI;
      operation = { kind: 'decal-rotate', decalId: drag.decalId, before: drag.before, start: drag.start, degrees: degrees };
    }
    this.editor.commitDocument(next, operation);
  }

  // Undo or redo: let go of anything held or dragged, keep the selection.
  cancelActive(): void {
    if (this.cancelHeld()) {
      return;
    }
    if (this.handleDrag !== null) {
      this.handleDrag.pointer.hideLabel();
    }
    this.drag = null;
    this.handleDrag = null;
  }

  // Escape or right click.
  cancel(): boolean {
    if (this.cancelHeld()) {
      return true;
    }
    if (this.drag !== null || this.handleDrag !== null) {
      if (this.handleDrag !== null) {
        this.handleDrag.pointer.hideLabel();
      }
      this.drag = null;
      this.handleDrag = null;
      this.editor.redraw();
      return true;
    }
    if (this.selectedId !== null) {
      this.select(null);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Commands.

  select(id: string | null): void {
    this.selectedId = id;
    if (id !== null) {
      this.editor.selectPartOnly(null);
    }
    this.editor.redraw();
  }

  deleteSelected(): boolean {
    if (this.selectedId === null) {
      return false;
    }
    const id = this.selectedId;
    this.selectedId = null;
    // A linked set goes as a whole (as in KSP); "make unique" first to
    // remove one copy.
    this.editor.commitDocument(removeDecalGroup(this.editor.document, id), null);
    return true;
  }

  flipSelected(axis: 'x' | 'y'): void {
    if (this.selectedId === null) {
      return;
    }
    const decal = requireDecal(this.editor.document, this.selectedId);
    if (axis === 'x') {
      this.editor.commitDocument(this.linked(updateDecal(this.editor.document, decal.id, { flipX: !decal.flipX }), decal.id), null);
    } else {
      this.editor.commitDocument(this.linked(updateDecal(this.editor.document, decal.id, { flipY: !decal.flipY }), decal.id), null);
    }
  }

  // Duplicate in place (from the list): the copy goes directly above.
  duplicateInPlace(id: string): void {
    const result = duplicateDecal(this.editor.document, id);
    this.selectedId = result.id;
    this.editor.commitDocument(result.doc, null);
  }

  // An edit of one decal, carried to its linked copies.
  private linked(doc: AssemblyDocument, id: string): AssemblyDocument {
    return syncDecalGroup(doc, this.surfaceFor(doc), id);
  }

  // Symmetry of the selected decal (the toolbar): its set's settings, and
  // how many copies there are; null when nothing is selected.
  selectedSymmetry(): { count: number; mirror: boolean; flipMirror: boolean; members: number; onFin: number } | null {
    if (this.selectedId === null) {
      return null;
    }
    const doc = this.editor.document;
    const decal = findDecal(doc, this.selectedId);
    if (decal === null) {
      return null;
    }
    // A fin of a part symmetry set: how many fins there are.
    let onFin = 0;
    const placed = findPlaced(doc, decal.anchor.placedId);
    if (placed !== null && placed.symmetry !== null) {
      onFin = symmetryMembers(doc, placed.id).length;
    }
    const members = decalGroup(doc, decal.id).length;
    if (decal.symmetry === null) {
      return { count: 1, mirror: false, flipMirror: false, members: members, onFin: onFin };
    }
    return { count: decal.symmetry.count, mirror: decal.symmetry.mirror, flipMirror: decal.symmetry.flipMirror, members: members, onFin: onFin };
  }

  // Make the selected decal's set again with these settings.
  private resymmetrise(count: number, mirror: boolean, flipMirror: boolean): void {
    if (this.selectedId === null) {
      return;
    }
    const doc = this.editor.document;
    const result = setDecalSymmetry(doc, this.surfaceFor(doc), this.selectedId, count, mirror, flipMirror);
    this.editor.commitDocument(result.doc, null);
    if (result.made < result.wanted) {
      this.editor.report(String(result.wanted - result.made) + ' of the copies found no surface to go on.');
    }
  }

  // ×N: step through 1, 2, 3, 4, 6, 8 copies round the rocket.
  stepSymmetry(direction: number): void {
    const current = this.selectedSymmetry();
    if (current === null) {
      return;
    }
    let index = decalSymmetryChoices.indexOf(current.count);
    if (index < 0) {
      index = 0;
    }
    index = (index + direction + decalSymmetryChoices.length) % decalSymmetryChoices.length;
    this.resymmetrise(decalSymmetryChoices[index], current.mirror, current.flipMirror);
  }

  setSymmetryCount(count: number): void {
    const current = this.selectedSymmetry();
    if (current === null || count < 1) {
      return;
    }
    this.resymmetrise(count, current.mirror, current.flipMirror);
  }

  toggleMirror(): void {
    const current = this.selectedSymmetry();
    if (current === null) {
      return;
    }
    this.resymmetrise(current.count, !current.mirror, current.flipMirror);
  }

  toggleFlipMirror(): void {
    const current = this.selectedSymmetry();
    if (current === null || !current.mirror) {
      return;
    }
    this.resymmetrise(current.count, true, !current.flipMirror);
  }

  // On a fin of a fin set: a copy on every fin, at the same place on the
  // same side (and on the other side too if mirror is on).
  onEveryFin(): void {
    const current = this.selectedSymmetry();
    if (current === null || current.onFin < 2) {
      return;
    }
    this.resymmetrise(current.onFin, current.mirror, current.flipMirror);
  }

  // Take the selected copy out of its set.
  makeUnique(): void {
    if (this.selectedId === null) {
      return;
    }
    this.editor.commitDocument(makeDecalUnique(this.editor.document, this.selectedId), null);
  }

  // Layers and colours (the decal list).

  // A new layer order (bottom first, every decal once).
  setLayers(bottomFirst: string[]): void {
    this.editor.commitDocument(reorderDecals(this.editor.document, bottomFirst), null);
  }

  toggleHidden(id: string): void {
    const decal = requireDecal(this.editor.document, id);
    if (!decal.hidden && this.selectedId === id) {
      this.selectedId = null;
    }
    this.editor.commitDocument(this.linked(updateDecal(this.editor.document, id, { hidden: !decal.hidden }), id), null);
  }

  toggleLocked(id: string): void {
    const decal = requireDecal(this.editor.document, id);
    if (!decal.locked && this.selectedId === id) {
      this.selectedId = null;
    }
    this.editor.commitDocument(this.linked(updateDecal(this.editor.document, id, { locked: !decal.locked }), id), null);
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    const decal = requireDecal(this.editor.document, id);
    if (trimmed === '' || trimmed === decal.name) {
      this.editor.notify();
      return;
    }
    this.editor.commitDocument(this.linked(updateDecal(this.editor.document, id, { name: trimmed }), id), null);
  }

  setColour(id: string, artworkColour: string, vinyl: string): void {
    this.editor.commitDocument(this.linked(setDecalColour(this.editor.document, id, artworkColour, vinyl), id), null);
  }

  setPartColour(placedId: string, colour: string | null): void {
    this.editor.commitDocument(setPartColour(this.editor.document, placedId, colour), null);
  }

  // Place on face: centre the selected decal on a part's attach face, in
  // the default orientation.
  centreOnFace(placedId: string, face: number): boolean {
    if (this.selectedId === null) {
      return false;
    }
    const doc = this.editor.document;
    const placed = findPlaced(doc, placedId);
    if (placed === null) {
      return false;
    }
    const world = worldFace(this.editor.parts, placed, face);
    const surface = this.surfaceFor(doc);
    const piece = pieceIndex(surface, placedId);
    if (piece < 0) {
      return false;
    }
    // The point of the part's surface nearest the face's centre: on a flat
    // side that is the centre itself; on a face spanning an opening (the end
    // of a tube) there may be none close enough.
    const at = nearestOnPiece(surface, piece, world.centre, 5);
    if (at === null) {
      return false;
    }
    const normal = worldNormal(surface, at);
    const frame = frameAt(surface, at, defaultRight(normal));
    if (frame === null) {
      return false;
    }
    const stored = anchorOf(surface, frame);
    this.editor.commitDocument(this.linked(updateDecal(doc, this.selectedId, { anchor: stored.anchor, rotation: stored.rotation }), this.selectedId), null);
    return true;
  }

  // Re-do a decal operation with exact values (the adjust panel).
  adjust(operation: LastOperation, values: number[]): AssemblyDocument | null {
    if (operation.kind === 'decal-move') {
      if (values.length !== 2) {
        throw new Error('adjust: a decal move takes 2 values, got ' + String(values.length));
      }
      operation.along = values[0];
      operation.around = values[1];
      const surface = this.surfaceFor(operation.before);
      const start = frameOf(surface, operation.start.anchor, operation.start.rotation);
      if (start === null) {
        return null;
      }
      const moved = moveAlongAndAround(surface, start, values[0], values[1]);
      if (moved === null) {
        return null;
      }
      const stored = anchorOf(surface, moved);
      return this.linked(updateDecal(operation.before, operation.decalId, { anchor: stored.anchor, rotation: stored.rotation }), operation.decalId);
    }
    if (operation.kind === 'decal-rotate') {
      operation.degrees = values[0];
      const rotation = (values[0] * Math.PI) / 180;
      return this.linked(updateDecal(operation.before, operation.decalId, { rotation: rotation }), operation.decalId);
    }
    if (operation.kind === 'decal-scale') {
      if (!(values[0] > 0) || !(values[1] > 0)) {
        return null;
      }
      operation.width = values[0];
      operation.height = values[1];
      return this.linked(updateDecal(operation.before, operation.decalId, { width: values[0], height: values[1] }), operation.decalId);
    }
    return null;
  }

  // For the test hook: where a decal's corners and centre are (world).
  describe(id: string): { centre: Vec3; right: Vec3; up: Vec3; normal: Vec3; corners: Array<Vec3 | null> } | null {
    const doc = this.editor.shownDocument;
    const decal = findDecal(doc, id);
    const grid = this.grids.get(id);
    if (decal === null || grid === undefined) {
      return null;
    }
    const surface = this.surfaceFor(doc);
    const frame = frameOf(surface, decal.anchor, decal.rotation);
    if (frame === null) {
      return null;
    }
    const corners: Array<Vec3 | null> = [
      gridPoint(grid, 0, grid.rows - 1),
      gridPoint(grid, grid.columns - 1, grid.rows - 1),
      gridPoint(grid, grid.columns - 1, 0),
      gridPoint(grid, 0, 0),
    ];
    return { centre: worldPoint(surface, frame.at), right: frame.right, up: upOf(surface, frame), normal: worldNormal(surface, frame.at), corners: corners };
  }

  handleScreenPoints(): Array<{ handle: Handle; x: number; y: number }> {
    const result: Array<{ handle: Handle; x: number; y: number }> = [];
    for (let i = 0; i < this.handlePoints.length; i++) {
      const screen = this.editor.view.toScreen(this.handlePoints[i].point);
      result.push({ handle: this.handlePoints[i].handle, x: screen.x, y: screen.y });
    }
    return result;
  }

  // The drawn decals in layer order, mesh and texture, for the model export.
  visibleMeshes(): Array<{ geometry: THREE.BufferGeometry; texture: THREE.Texture | null }> {
    const result: Array<{ geometry: THREE.BufferGeometry; texture: THREE.Texture | null }> = [];
    const doc = this.editor.document;
    for (let i = 0; i < doc.decals.length; i++) {
      const visual = this.visuals.get(doc.decals[i].id);
      if (visual === undefined || !visual.mesh.visible) {
        continue;
      }
      const material = visual.mesh.material as THREE.MeshStandardMaterial;
      result.push({ geometry: visual.mesh.geometry, texture: material.map });
    }
    return result;
  }

  gridOf(id: string): DecalGrid | null {
    const grid = this.grids.get(id);
    return grid === undefined ? null : grid;
  }
}

// How far apart two surface points are along the rocket (towards the tail)
// and around it (arc length at the end point's distance from the axis;
// positive turns from the side towards the top).
export function alongAndAround(from: Vec3, to: Vec3): { along: number; around: number } {
  const along = dot(sub(to, from), AFT_DIRECTION);
  const angleFrom = Math.atan2(from[1], from[2]);
  const angleTo = Math.atan2(to[1], to[2]);
  let turn = angleTo - angleFrom;
  if (turn > Math.PI) {
    turn = turn - 2 * Math.PI;
  } else if (turn < -Math.PI) {
    turn = turn + 2 * Math.PI;
  }
  const radius = Math.hypot(to[1], to[2]);
  return { along: along, around: turn * radius };
}

// Walk a decal frame `along` mm along the rocket (as seen on the surface)
// and then `around` mm across, at right angles.
export function moveAlongAndAround(surface: Surface, start: DecalFrame, along: number, around: number): DecalFrame | null {
  let frame: DecalFrame | null = start;
  if (Math.abs(along) > 1e-9) {
    const normal = worldNormal(surface, frame.at);
    const axisOnSurface = sub(AFT_DIRECTION, scale(normal, dot(AFT_DIRECTION, normal)));
    if (length(axisOnSurface) < 1e-6) {
      return null;
    }
    const direction = normalize(axisOnSurface);
    const angle = angleInPlane(frame.right, direction, normal);
    frame = walkFrame(surface, frame, along * Math.cos(angle), along * Math.sin(angle));
    if (frame === null) {
      return null;
    }
  }
  if (Math.abs(around) > 1e-9) {
    const normal = worldNormal(surface, frame.at);
    const axisOnSurface = sub(AFT_DIRECTION, scale(normal, dot(AFT_DIRECTION, normal)));
    if (length(axisOnSurface) < 1e-6) {
      return null;
    }
    // Around: at right angles to the axis, turning from the side to the top.
    const direction = cross(normal, normalize(axisOnSurface));
    const angle = angleInPlane(frame.right, direction, normal);
    frame = walkFrame(surface, frame, around * Math.cos(angle), around * Math.sin(angle));
  }
  return frame;
}

// The nearest grid cell triangle hit by a ray: distance and the point's
// coordinates in the decal frame.
function raycastGrid(grid: DecalGrid, origin: Vec3, direction: Vec3): { distance: number; x: number; y: number } | null {
  // Most rays miss most decals: test the bounding sphere first.
  const sphere = boundingSphere(grid);
  const toCentre = sub(sphere.centre, origin);
  const along = dot(toCentre, direction);
  const missBy = length(sub(toCentre, scale(direction, along)));
  if (missBy > sphere.radius) {
    return null;
  }
  let best: { distance: number; x: number; y: number } | null = null;
  for (let j = 0; j + 1 < grid.rows; j++) {
    for (let i = 0; i + 1 < grid.columns; i++) {
      const corners: Array<[number, number]> = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const triangles = [
        [0, 1, 2],
        [0, 2, 3],
      ];
      for (let t = 0; t < 2; t++) {
        const a = corners[triangles[t][0]];
        const b = corners[triangles[t][1]];
        const c = corners[triangles[t][2]];
        const pa = gridPoint(grid, a[0], a[1]);
        const pb = gridPoint(grid, b[0], b[1]);
        const pc = gridPoint(grid, c[0], c[1]);
        if (pa === null || pb === null || pc === null) {
          continue;
        }
        const hit = rayTriangle(origin, direction, pa, pb, pc);
        if (hit === null) {
          continue;
        }
        if (best === null || hit.distance < best.distance) {
          const x = grid.xs[a[0]] * hit.wa + grid.xs[b[0]] * hit.wb + grid.xs[c[0]] * hit.wc;
          const y = grid.ys[a[1]] * hit.wa + grid.ys[b[1]] * hit.wb + grid.ys[c[1]] * hit.wc;
          best = { distance: hit.distance, x: x, y: y };
        }
      }
    }
  }
  return best;
}

const spheres = new WeakMap<DecalGrid, { centre: Vec3; radius: number }>();

function boundingSphere(grid: DecalGrid): { centre: Vec3; radius: number } {
  const cached = spheres.get(grid);
  if (cached !== undefined) {
    return cached;
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < grid.present.length; k++) {
    if (grid.present[k] === 0) {
      continue;
    }
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], grid.positions[3 * k + axis]);
      max[axis] = Math.max(max[axis], grid.positions[3 * k + axis]);
    }
  }
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = length(sub(max, centre)) + 1;
  const sphere = { centre: centre, radius: radius };
  spheres.set(grid, sphere);
  return sphere;
}

// Moller-Trumbore; both sides count. Returns distance and barycentric weights.
function rayTriangle(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3): { distance: number; wa: number; wb: number; wc: number } | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(direction, e2);
  const determinant = dot(e1, p);
  if (Math.abs(determinant) < 1e-12) {
    return null;
  }
  const inverse = 1 / determinant;
  const s = sub(origin, a);
  const u = dot(s, p) * inverse;
  if (u < 0 || u > 1) {
    return null;
  }
  const q = cross(s, e1);
  const v = dot(direction, q) * inverse;
  if (v < 0 || u + v > 1) {
    return null;
  }
  const distance = dot(e2, q) * inverse;
  if (distance < 0) {
    return null;
  }
  return { distance: distance, wa: 1 - u - v, wb: u, wc: v };
}

function formatDegrees(value: number): string {
  const text = Math.abs(value).toFixed(0);
  if (Number(text) === 0) {
    return '0°';
  }
  return (value > 0 ? '+' : '−') + text + '°';
}
