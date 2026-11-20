// window.dc6: read-only helpers for automated tests (tools/e2e.ts). The
// tests act through real mouse events; this only tells them where things are
// on screen and what the document says.

import type { Editor } from './editor.ts';
import type { Importer } from './importer.ts';
import type { PresetView } from './view.ts';
import { requirePlaced, cloneDocument } from '../model/document.ts';
import type { AssemblyDocument } from '../model/document.ts';
import { applyToPoint } from '../geometry/transform.ts';
import type { Vec3 } from '../geometry/vec3.ts';
import type { PagePane } from './page-pane.ts';
import { barycentricOf } from '../geometry/surface-mesh.ts';
import { nearestOnPiece, pieceIndex } from '../geometry/geodesic.ts';

export interface WorldFace {
  centre: Vec3;
  normal: Vec3;
  radius: number | null;
}

export interface TestHook {
  loaded(): Promise<void>;
  document(): AssemblyDocument;
  partNames(): Record<string, string>;
  attachFaces(placedId: string): WorldFace[];
  // Client pixel position of a world point.
  screenOf(point: Vec3): { x: number; y: number };
  // Client pixel position of a point in a placed part's own frame.
  screenOfLocal(placedId: string, point: Vec3): { x: number; y: number };
  holding(): boolean;
  // The attach faces of the part being held, where it is now.
  heldFaces(): WorldFace[];
  heldSnap(): string | null;
  view(preset: PresetView | 'fit'): void;
  // Where the move or rotate gizmo is (world), and whether the cursor is on a handle.
  gizmoPivot(): Vec3;
  gizmoHovered(): boolean;
  // Millimetres per CSS pixel at a world point.
  millimetresPerPixel(point: Vec3): number;
  frameTimes(): number[];
  // Decals: the selected one, where one lies (world), its handles on screen,
  // and how long re-mapping took while dragging (ms each).
  selectedDecal(): string | null;
  decalInfo(id: string): DecalInfo | null;
  decalHandles(): Array<{ handle: string; x: number; y: number }>;
  decalMapTimes(): number[];
  decalDragTimes(): number[];
  // The mapped grid of a decal: rows of world points (null where absent).
  decalGrid(id: string): { columns: number; rows: number; xs: number[]; ys: number[]; points: Array<Vec3 | null> } | null;
  // The flat page.
  page(): PageInfo | null;
  // Client positions on the page of a world point that is on a visible
  // part's surface (one per place it shows), found from the nearest
  // surface point of that part.
  pageImagesOf(placedId: string, world: Vec3): Array<{ x: number; y: number; chart: number }>;
  // The world point under a client position on the page.
  pageWorldAt(x: number, y: number): Vec3 | null;
  pageDecalCentres(id: string): Array<{ x: number; y: number }>;
  pageHandles(): Array<{ handle: string; x: number; y: number }>;
  // Client y of the strip's top and bottom (seam) edges at page x.
  pageStripEdges(x: number): { top: number; bottom: number } | null;
  // Is the page's own pointer point shown in 3D, and is the 3D pointer's
  // point shown on the page.
  linkedMarker3d(): boolean;
  // Where the dot marking the page pointer's point is in 3D, or null.
  linkedPoint3d(): Vec3 | null;
  hoverPoint3d(): boolean;
  viewRoll(): number;
  pageDrawTimes(): number[];
  // Resolves once no page build is waiting or running.
  pageSettled(): Promise<void>;
  // Resolves once the last project file opened is in.
  opened(): Promise<void>;
  // How many autosaves were written; write one now.
  autosaves(): number;
  flushAutosave(): Promise<void>;
  // Decals: linked copies of one.
  decalGroup(id: string): string[];
}

// The app's side of the project file and autosave, for the hook.
export interface ProjectHooks {
  opening(): Promise<void>;
  autosaves(): number;
  flushAutosave(): Promise<void>;
}

export interface PageInfo {
  stripTriangles: number;
  stripLength: number;
  islands: Array<{ label: string; placedId: string; kind: string; left: number; top: number; right: number; bottom: number }>;
  buildMilliseconds: number;
  zoom: number;
  // Client position of page point (0, 0) (the nose tip on the strip's middle line).
  originX: number;
  originY: number;
  canvas: { left: number; top: number; width: number; height: number };
}

export interface DecalInfo {
  centre: Vec3;
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  // Top left, top right, bottom right, bottom left (artwork corners).
  corners: Array<Vec3 | null>;
}

export function installTestHook(editor: Editor, importer: Importer, bundled: Promise<void>, pagePane: PagePane, project: ProjectHooks): void {
  const hook: TestHook = {
    loaded: async function loaded(): Promise<void> {
      await bundled;
      while (importer.pendingCount() > 0) {
        await new Promise(function wait(resolve) {
          setTimeout(resolve, 50);
        });
      }
    },
    document: function documentCopy(): AssemblyDocument {
      return cloneDocument(editor.document);
    },
    partNames: function partNames(): Record<string, string> {
      const names: Record<string, string> = {};
      editor.parts.forEach(function add(part, id) {
        names[id] = part.name;
      });
      return names;
    },
    attachFaces: function attachFaces(placedId: string): WorldFace[] {
      const placed = requirePlaced(editor.shownDocument, placedId);
      const part = editor.parts.get(placed.partId);
      const result: WorldFace[] = [];
      if (part === undefined) {
        return result;
      }
      for (let f = 0; f < part.attachFaces.length; f++) {
        result.push(editor.worldFaceOf(placedId, f));
      }
      return result;
    },
    screenOf: function screenOf(point: Vec3): { x: number; y: number } {
      const screen = editor.view.toScreen(point);
      return { x: screen.x, y: screen.y };
    },
    screenOfLocal: function screenOfLocal(placedId: string, point: Vec3): { x: number; y: number } {
      const placed = requirePlaced(editor.shownDocument, placedId);
      const screen = editor.view.toScreen(applyToPoint(placed.transform, point));
      return { x: screen.x, y: screen.y };
    },
    heldFaces: function heldFaces(): WorldFace[] {
      const heldId = editor.heldShownId();
      const result: WorldFace[] = [];
      if (heldId === null) {
        return result;
      }
      const placed = requirePlaced(editor.shownDocument, heldId);
      const part = editor.parts.get(placed.partId);
      if (part === undefined) {
        return result;
      }
      for (let f = 0; f < part.attachFaces.length; f++) {
        result.push(editor.worldFaceOf(heldId, f));
      }
      return result;
    },
    holding: function holding(): boolean {
      return editor.isHolding();
    },
    heldSnap: function heldSnap(): string | null {
      return editor.heldSnapKind();
    },
    view: function view(preset: PresetView | 'fit'): void {
      editor.setView(preset);
    },
    gizmoPivot: function gizmoPivot(): Vec3 {
      return editor.gizmo.pivotPoint();
    },
    gizmoHovered: function gizmoHovered(): boolean {
      return editor.gizmo.hovered();
    },
    millimetresPerPixel: function millimetresPerPixel(point: Vec3): number {
      return editor.view.millimetresPerPixel(point);
    },
    frameTimes: function frameTimes(): number[] {
      return editor.view.frameTimes.slice();
    },
    selectedDecal: function selectedDecal(): string | null {
      return editor.decals.selectedId;
    },
    decalInfo: function decalInfo(id: string): DecalInfo | null {
      return editor.decals.describe(id);
    },
    decalHandles: function decalHandles(): Array<{ handle: string; x: number; y: number }> {
      return editor.decals.handleScreenPoints();
    },
    decalMapTimes: function decalMapTimes(): number[] {
      return editor.decals.mapTimes.slice();
    },
    decalDragTimes: function decalDragTimes(): number[] {
      return editor.decals.dragStepTimes.slice();
    },
    decalGrid: function decalGrid(id: string) {
      const grid = editor.decals.gridOf(id);
      if (grid === null) {
        return null;
      }
      const points: Array<Vec3 | null> = [];
      for (let k = 0; k < grid.present.length; k++) {
        if (grid.present[k] === 0) {
          points.push(null);
        } else {
          points.push([grid.positions[3 * k], grid.positions[3 * k + 1], grid.positions[3 * k + 2]]);
        }
      }
      return { columns: grid.columns, rows: grid.rows, xs: grid.xs, ys: grid.ys, points: points };
    },
    page: function page(): PageInfo | null {
      const built = pagePane.page;
      if (built === null) {
        return null;
      }
      const boxes = pagePane.islandScreenBoxes();
      const islands: PageInfo['islands'] = [];
      for (let i = 0; i < boxes.length; i++) {
        islands.push({ label: boxes[i].label, placedId: boxes[i].placedId, kind: built.islands[i].kind, left: boxes[i].left, top: boxes[i].top, right: boxes[i].right, bottom: boxes[i].bottom });
      }
      const origin = pagePane.toClient(0, 0);
      const rect = pagePane.canvas.getBoundingClientRect();
      return {
        stripTriangles: built.strip.triangles.length,
        stripLength: built.strip.length,
        islands: islands,
        buildMilliseconds: built.buildMilliseconds,
        zoom: pagePane.zoom,
        originX: origin.x,
        originY: origin.y,
        canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    },
    pageImagesOf: function pageImagesOf(placedId: string, world: Vec3) {
      const surface = editor.decals.surfaceFor(editor.document);
      const piece = pieceIndex(surface, placedId);
      if (piece < 0) {
        return [];
      }
      const at = nearestOnPiece(surface, piece, world, 2);
      if (at === null) {
        return [];
      }
      const w = barycentricOf(surface.pieces[piece].mesh, at.triangle, at.point);
      return pagePane.screenImages(placedId, at.triangle, w);
    },
    pageWorldAt: function pageWorldAt(x: number, y: number): Vec3 | null {
      return pagePane.worldAt(x, y);
    },
    pageDecalCentres: function pageDecalCentres(id: string) {
      return pagePane.decalCentres(id);
    },
    pageHandles: function pageHandles() {
      return pagePane.handleScreenPoints();
    },
    pageStripEdges: function pageStripEdges(x: number) {
      return pagePane.stripEdgesAt(x);
    },
    linkedMarker3d: function linkedMarker3d(): boolean {
      return pagePane.linkedHoverShown() > 0;
    },
    linkedPoint3d: function linkedPoint3d(): Vec3 | null {
      return editor.linkedPoint;
    },
    hoverPoint3d: function hoverPoint3d(): boolean {
      return editor.hoverPoint !== null;
    },
    viewRoll: function viewRoll(): number {
      return editor.view.roll;
    },
    pageDrawTimes: function pageDrawTimes(): number[] {
      return pagePane.drawTimes.slice();
    },
    pageSettled: async function pageSettled(): Promise<void> {
      while (pagePane.isBuilding()) {
        await new Promise(function wait(resolve) {
          setTimeout(resolve, 50);
        });
      }
    },
    opened: function opened(): Promise<void> {
      return project.opening();
    },
    autosaves: function autosaves(): number {
      return project.autosaves();
    },
    flushAutosave: function flushAutosave(): Promise<void> {
      return project.flushAutosave();
    },
    decalGroup: function group(id: string): string[] {
      const doc = editor.document;
      const ids: string[] = [];
      const decal = doc.decals.find(function byId(d) {
        return d.id === id;
      });
      if (decal === undefined) {
        return ids;
      }
      for (let i = 0; i < doc.decals.length; i++) {
        const other = doc.decals[i];
        if (other.id === id || (decal.symmetry !== null && other.symmetry !== null && other.symmetry.group === decal.symmetry.group)) {
          ids.push(other.id);
        }
      }
      return ids;
    },
  };
  (window as unknown as { dc6: TestHook }).dc6 = hook;
}
