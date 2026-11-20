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
  // The mapped grid of a decal: rows of world points (null where absent).
  decalGrid(id: string): { columns: number; rows: number; xs: number[]; ys: number[]; points: Array<Vec3 | null> } | null;
}

export interface DecalInfo {
  centre: Vec3;
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  // Top left, top right, bottom right, bottom left (artwork corners).
  corners: Array<Vec3 | null>;
}

export function installTestHook(editor: Editor, importer: Importer, bundled: Promise<void>): void {
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
  };
  (window as unknown as { dc6: TestHook }).dc6 = hook;
}
