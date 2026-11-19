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
  heldSnap(): string | null;
  view(preset: PresetView | 'fit'): void;
  frameTimes(): number[];
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
      const placed = requirePlaced(editor.document, placedId);
      const part = editor.parts.get(placed.partId);
      const result: WorldFace[] = [];
      if (part === undefined) {
        return result;
      }
      for (let f = 0; f < part.attachFaces.length; f++) {
        const face = editor.worldFace(placed, f);
        result.push({ centre: face.centre, normal: face.normal, radius: face.radius });
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
    holding: function holding(): boolean {
      return editor.isHolding();
    },
    heldSnap: function heldSnap(): string | null {
      return editor.heldSnapKind();
    },
    view: function view(preset: PresetView | 'fit'): void {
      editor.setView(preset);
    },
    frameTimes: function frameTimes(): number[] {
      return editor.view.frameTimes.slice();
    },
  };
  (window as unknown as { dc6: TestHook }).dc6 = hook;
}
