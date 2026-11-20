// The flat page under the 3D view: the rocket laid flat, linked to 3D.
//
// Drawn with Canvas 2D. What is drawn comes from the geometry layer
// (page.ts): the strip and the islands are built once per assembly, the
// strip is re-cut when the page is rolled, and each decal is drawn from its
// mapped grid pushed through the surface -> page map, so the 3D decal is
// the only copy of it.
//
// Using it (as a drawing program's canvas):
//   - drag empty space, middle button or right button: pan; two-finger
//     scroll pans too; the mouse wheel or a pinch zooms about the cursor;
//   - drag the strip up or down: roll the rocket (the 3D camera turns about
//     the axis with it, so the 3D view faces the middle of the strip);
//   - decals: exactly as in 3D (this view is one more DecalPointer).
// Hovering a point shows the matching point in 3D, and the other way round.

import type { Vec3 } from '../geometry/vec3.ts';
import type { Surface, SurfacePoint } from '../geometry/geodesic.ts';
import { pieceIndex } from '../geometry/geodesic.ts';
import { applyToPoint } from '../geometry/transform.ts';
import { barycentricOf, pointFromBarycentric } from '../geometry/surface-mesh.ts';
import type { DecalFrame, DecalGrid } from '../geometry/decal-map.ts';
import type { DecalPageTriangle, Page, PageView } from '../geometry/page.ts';
import { buildPage, decalPageTriangles, decalPointAt, decalToPage, pageToSurface, surfaceToPage, viewPage } from '../geometry/page.ts';
import type { PieceInfo } from '../geometry/page-islands.ts';
import { radiusOf } from '../geometry/page-strip.ts';
import type { Artwork } from '../geometry/artwork.ts';
import type { AssemblyDocument } from '../model/document.ts';
import { findPlaced } from '../model/document.ts';
import { findDecal } from '../model/decals.ts';
import type { Decal } from '../model/decals.ts';
import type { Editor } from './editor.ts';
import type { DecalPlane, DecalPointer, Handle } from './decal-tool.ts';
import { rasterise, textureSize } from './decal-visuals.ts';

// Height of the station ruler along the top (CSS px).
export const rulerHeight = 20;
// Space round the page when it is fitted to the pane (CSS px).
const fitMargin = 24;
// A press that moves less than this (CSS px) is a click.
const clickSlop = 5;
// Screen distance (CSS px) within which the cursor is on a handle, and how
// far above the top edge the rotate handle sits: as in the 3D view.
const handleReach = 9;
const rotateHandleOffset = 26;

const partGrey = '#9b9ba0';
// Wait this long (ms) after the assembly changes before building the page again.
const rebuildDelay = 250;

interface PressState {
  kind: 'decal' | 'pan' | 'roll' | 'none';
  button: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  // Roll drag: the roll and the grabbed point's distance from the axis.
  startRoll: number;
  radius: number;
}

interface DecalDrawing {
  grid: DecalGrid;
  roll: number;
  key: string;
  triangles: DecalPageTriangle[];
  raster: HTMLCanvasElement | null;
  // The resolution asked for, and the one the bitmap has (less for a big decal).
  wantedResolution: number;
  pixelsPerMillimetre: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface HandlePoint {
  handle: Handle;
  x: number;
  y: number;
}

export class PagePane {
  readonly element: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly editor: Editor;
  private readonly label: HTMLDivElement;
  readonly pointer: DecalPointer;

  page: Page | null = null;
  view: PageView | null = null;
  private pageKey = '';
  private buildQueued = false;
  // Page millimetre at the canvas's top left corner, and CSS px per mm.
  originX = 0;
  originY = 0;
  zoom = 1;
  // Until the user pans or zooms, the page is kept fitted to the pane.
  private userMoved = false;

  private stripPaths: Array<{ placedId: string; band: number; path: Path2D }> = [];
  private islandPaths: Array<{ placedId: string; path: Path2D }> = [];
  private outlinePath = new Path2D();
  private jointPath = new Path2D();
  private seamPath = new Path2D();
  private repeatPath = new Path2D();
  private readonly drawings = new Map<string, DecalDrawing>();
  private heldDrawing: DecalDrawing | null = null;
  private readonly textures = new Map<string, HTMLCanvasElement>();
  private handlePoints: HandlePoint[] = [];

  private press: PressState | null = null;
  private pendingRoll: number | null = null;
  private drawQueued = false;
  private sharpenTimer = 0;
  // Page point under the pointer (for the 3D marker), and the 3D pointer's
  // point on the page.
  private hoverPage: { x: number; y: number } | null = null;
  // A file dropped on the page: where, for placing it once it is read.
  private dropAt: { x: number; y: number } | null = null;
  // Milliseconds per draw, for the e2e report.
  readonly drawTimes: number[] = [];

  constructor(parent: HTMLElement, editor: Editor) {
    this.editor = editor;
    this.element = document.createElement('div');
    this.element.className = 'page-pane';
    parent.appendChild(this.element);
    this.canvas = document.createElement('canvas');
    this.element.appendChild(this.canvas);
    const context = this.canvas.getContext('2d');
    if (context === null) {
      throw new Error('PagePane: no 2D canvas context');
    }
    this.context = context;
    this.label = document.createElement('div');
    this.label.className = 'decal-label';
    this.element.appendChild(this.label);
    const fit = document.createElement('button');
    fit.className = 'view page-fit';
    fit.textContent = 'Fit';
    fit.dataset.control = 'page-fit';
    this.element.appendChild(fit);
    const self = this;
    fit.addEventListener('click', function fitPage() {
      self.fit();
    });

    this.pointer = {
      jumps: true,
      surfaceUnder: function surfaceUnder(x: number, y: number): SurfacePoint | null {
        return self.surfaceUnder(x, y);
      },
      decalUnder: function decalUnder(x: number, y: number) {
        return self.decalUnder(x, y);
      },
      handleUnder: function handleUnder(x: number, y: number): Handle | null {
        return self.handleUnder(x, y);
      },
      rightAt: function rightAt(x: number, y: number): Vec3 | null {
        return self.rightAt(x, y);
      },
      // (On the page the plane comes from the decal's drawing, not its frame.)
      planeOf: function planeOf(decalId: string, _frame: DecalFrame, x: number, y: number): DecalPlane | null {
        return self.planeOf(decalId, x, y);
      },
      showLabel: function showLabel(x: number, y: number, text: string): void {
        const rect = self.element.getBoundingClientRect();
        self.label.textContent = text;
        self.label.style.display = 'block';
        self.label.style.left = String(x - rect.left + 16) + 'px';
        self.label.style.top = String(y - rect.top + 14) + 'px';
      },
      hideLabel: function hideLabel(): void {
        self.label.style.display = 'none';
      },
    };

    this.canvas.addEventListener('pointerdown', function down(event) {
      self.onPointerDown(event);
    });
    this.canvas.addEventListener('pointermove', function move(event) {
      self.onPointerMove(event);
    });
    this.canvas.addEventListener('pointerup', function up(event) {
      self.onPointerUp(event);
    });
    this.canvas.addEventListener('pointerleave', function leave() {
      self.hoverPage = null;
      self.editor.showLinkedPoint(null);
    });
    this.canvas.addEventListener(
      'wheel',
      function wheel(event) {
        self.onWheel(event);
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', function context(event) {
      event.preventDefault();
    });
    this.canvas.addEventListener('drop', function drop(event) {
      self.dropAt = { x: event.clientX, y: event.clientY };
    });
    editor.addListener({
      changed: function changed() {
        self.documentChanged();
      },
    });
    editor.onHoverPoint(function hoverIn3d() {
      self.queueDraw();
    });
    editor.view.onRoll(function rolled() {
      self.rollChanged();
    });
    const resizeObserver = new ResizeObserver(function resized() {
      self.resize();
    });
    resizeObserver.observe(this.element);
  }

  // ---------------------------------------------------------------------------
  // Building the page from the assembly.

  private documentChanged(): void {
    const doc = this.editor.document;
    const keyParts: unknown[] = [];
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      if (!placed.hidden) {
        keyParts.push(placed.id, placed.partId, placed.transform);
      }
    }
    const key = JSON.stringify(keyParts);
    if (key !== this.pageKey && !this.buildQueued) {
      // Building takes most of a second (ray casts, on this thread), so it
      // waits a moment: a quick run of edits builds once. (Doubt: it still
      // holds the window up while it runs; the import worker could do it.)
      this.buildQueued = true;
      const self = this;
      window.setTimeout(function build() {
        self.buildQueued = false;
        self.rebuild();
      }, rebuildDelay);
    }
    this.queueDraw();
  }

  private rebuild(): void {
    const doc = this.editor.document;
    const keyParts: unknown[] = [];
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      if (!placed.hidden) {
        keyParts.push(placed.id, placed.partId, placed.transform);
      }
    }
    this.pageKey = JSON.stringify(keyParts);
    const surface = this.editor.decals.surfaceFor(doc);
    if (surface.pieces.length === 0) {
      this.page = null;
      this.view = null;
      this.queueDraw();
      return;
    }
    const info: PieceInfo[] = [];
    for (let i = 0; i < surface.pieces.length; i++) {
      const placed = findPlaced(doc, surface.pieces[i].placedId);
      if (placed === null) {
        throw new Error('PagePane: a surface piece without a placed part');
      }
      const part = this.editor.parts.get(placed.partId);
      if (part === undefined) {
        throw new Error('PagePane: no loaded part ' + placed.partId);
      }
      let symmetryNumber: number | null = null;
      if (placed.symmetry !== null) {
        symmetryNumber = placed.symmetry.index + 1;
      }
      info.push({ name: part.name, faces: part.faces, triangleFace: part.triangleFace, symmetryNumber: symmetryNumber });
    }
    this.page = buildPage(surface, info);
    this.makeView();
    if (!this.userMoved) {
      this.fit();
    }
  }

  private makeView(): void {
    if (this.page === null) {
      return;
    }
    this.view = viewPage(this.page, this.editor.view.roll);
    this.makePaths();
    this.drawings.clear();
    this.queueDraw();
  }

  private makePaths(): void {
    const view = this.view;
    if (view === null) {
      return;
    }
    const page = view.page;
    const strip = new Map<string, { placedId: string; band: number; path: Path2D }>();
    for (let f = 0; f < view.stripFaceCount; f++) {
      const face = view.faces[f];
      const placedId = page.placedIds[face.piece];
      const key = placedId + '|' + String(face.chart);
      let entry = strip.get(key);
      if (entry === undefined) {
        entry = { placedId: placedId, band: face.chart, path: new Path2D() };
        strip.set(key, entry);
      }
      addPolygon(entry.path, face.polygon);
    }
    // The strip itself last, so it is drawn over the faded repeats.
    this.stripPaths = Array.from(strip.values());
    this.stripPaths.sort(function repeatsFirst(a, b) {
      return Math.abs(b.band) - Math.abs(a.band);
    });
    this.islandPaths = [];
    for (let i = 0; i < page.islands.length; i++) {
      const island = page.islands[i];
      const path = new Path2D();
      for (let k = 0; k < island.triangles.length; k++) {
        const c = island.corners;
        const polygon = [c[6 * k], c[6 * k + 1], c[6 * k + 2], c[6 * k + 3], c[6 * k + 4], c[6 * k + 5]];
        for (let q = 0; q < 6; q = q + 2) {
          polygon[q] = polygon[q] + island.offsetX;
          polygon[q + 1] = polygon[q + 1] + island.offsetY;
        }
        // Counterclockwise, so the triangles fill as one shape without seams.
        const area = (polygon[2] - polygon[0]) * (polygon[5] - polygon[1]) - (polygon[4] - polygon[0]) * (polygon[3] - polygon[1]);
        if (area < 0) {
          addPolygon(path, [polygon[0], polygon[1], polygon[4], polygon[5], polygon[2], polygon[3]]);
        } else {
          addPolygon(path, polygon);
        }
      }
      this.islandPaths.push({ placedId: page.placedIds[island.piece], path: path });
    }
    this.outlinePath = segmentsPath(view.outline);
    for (let i = 0; i < page.islands.length; i++) {
      const island = page.islands[i];
      const moved: number[] = [];
      for (let q = 0; q < island.boundary.length; q = q + 2) {
        moved.push(island.boundary[q] + island.offsetX, island.boundary[q + 1] + island.offsetY);
      }
      this.outlinePath.addPath(segmentsPath(moved));
    }
    this.jointPath = segmentsPath(view.joints);
    this.seamPath = segmentsPath(view.seams);
    this.repeatPath = segmentsPath(view.repeatEdges);
  }

  private rollChanged(): void {
    if (this.view !== null && this.view.roll !== this.editor.view.roll) {
      this.makeView();
    }
  }

  // ---------------------------------------------------------------------------
  // View: pan and zoom.

  private resize(): void {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    const ratio = window.devicePixelRatio;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    this.canvas.style.width = String(width) + 'px';
    this.canvas.style.height = String(height) + 'px';
    if (this.page !== null && !this.userMoved) {
      this.fit();
    }
    this.queueDraw();
  }

  // The whole page in the pane.
  fit(): void {
    const page = this.page;
    const width = this.element.clientWidth;
    const height = this.element.clientHeight - rulerHeight;
    if (page === null || width < 2 * fitMargin + 10 || height < 2 * fitMargin + 10) {
      return;
    }
    const pageWidth = page.maxX - page.minX;
    const pageHeight = page.maxY - page.minY;
    this.zoom = Math.min((width - 2 * fitMargin) / pageWidth, (height - 2 * fitMargin) / pageHeight);
    const centreX = (page.minX + page.maxX) / 2;
    const centreY = (page.minY + page.maxY) / 2;
    this.originX = centreX - width / 2 / this.zoom;
    this.originY = centreY + (height / 2 + rulerHeight) / this.zoom;
    this.userMoved = false;
    this.queueDraw();
  }

  // Client px -> page mm, and back.
  toPage(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: this.originX + (clientX - rect.left) / this.zoom, y: this.originY - (clientY - rect.top) / this.zoom };
  }

  toClient(x: number, y: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (x - this.originX) * this.zoom, y: rect.top + (this.originY - y) * this.zoom };
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.userMoved = true;
    // A mouse wheel (whole notches, or line mode) or a pinch (Ctrl) zooms;
    // two fingers on a touchpad pan.
    const notch = event.deltaMode !== 0 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 50);
    if (event.ctrlKey || notch) {
      const rate = event.ctrlKey ? 0.01 : 0.0015;
      let amount = event.deltaY;
      if (event.deltaMode === 1) {
        amount = amount * 33;
      }
      const factor = Math.exp(-amount * rate);
      this.zoomAbout(event.clientX, event.clientY, factor);
      return;
    }
    this.originX = this.originX + event.deltaX / this.zoom;
    this.originY = this.originY - event.deltaY / this.zoom;
    this.queueDraw();
  }

  private zoomAbout(clientX: number, clientY: number, factor: number): void {
    const before = this.toPage(clientX, clientY);
    this.lastWheel = Date.now();
    this.zoom = Math.max(0.05, Math.min(200, this.zoom * factor));
    const after = this.toPage(clientX, clientY);
    this.originX = this.originX + before.x - after.x;
    this.originY = this.originY + before.y - after.y;
    this.queueDraw();
    // Decals are drawn into bitmaps at the zoom of the moment; once zooming
    // stops, draw them again at the new one.
    window.clearTimeout(this.sharpenTimer);
    const self = this;
    this.sharpenTimer = window.setTimeout(function sharpen() {
      self.queueDraw();
    }, 160);
  }

  // ---------------------------------------------------------------------------
  // The page as a DecalPointer.

  // A surface point of the decal tool's surface from a page point.
  private surfaceAtPage(x: number, y: number): { at: SurfacePoint; world: Vec3; chart: number } | null {
    const view = this.view;
    if (view === null) {
      return null;
    }
    const found = pageToSurface(view, x, y);
    if (found === null) {
      return null;
    }
    const surface = this.editor.decals.surfaceFor(this.editor.document);
    const piece = pieceIndex(surface, found.placedId);
    if (piece < 0) {
      return null;
    }
    const mesh = surface.pieces[piece].mesh;
    const local = pointFromBarycentric(mesh, found.triangle, found.barycentric);
    const world = applyToPoint(surface.pieces[piece].transform, local);
    return { at: { piece: piece, triangle: found.triangle, point: local }, world: world, chart: found.chart };
  }

  surfaceUnder(clientX: number, clientY: number): SurfacePoint | null {
    const rect = this.canvas.getBoundingClientRect();
    if (clientY < rect.top + rulerHeight || clientY > rect.bottom || clientX < rect.left || clientX > rect.right) {
      return null;
    }
    const p = this.toPage(clientX, clientY);
    const found = this.surfaceAtPage(p.x, p.y);
    return found === null ? null : found.at;
  }

  private decalUnder(clientX: number, clientY: number): { id: string; x: number; y: number } | null {
    const doc = this.editor.shownDocument;
    const p = this.toPage(clientX, clientY);
    for (let layer = doc.decals.length - 1; layer >= 0; layer--) {
      const decal = doc.decals[layer];
      if (decal.hidden || decal.locked) {
        continue;
      }
      const drawing = this.drawings.get(decal.id);
      if (drawing === undefined) {
        continue;
      }
      const hit = decalPointAt(drawing.triangles, p.x, p.y);
      if (hit !== null) {
        return { id: decal.id, x: hit.x, y: hit.y };
      }
    }
    return null;
  }

  private handleUnder(clientX: number, clientY: number): Handle | null {
    const rect = this.canvas.getBoundingClientRect();
    let best: Handle | null = null;
    let bestDistance = handleReach;
    for (let i = 0; i < this.handlePoints.length; i++) {
      const h = this.handlePoints[i];
      const d = Math.hypot(rect.left + h.x - clientX, rect.top + h.y - clientY);
      if (d <= bestDistance) {
        bestDistance = d;
        best = h.handle;
      }
    }
    return best;
  }

  // The decal's plane as the page shows it: from the drawing of the decal
  // nearest the press, its centre and the page directions of its right and
  // up there.
  private planeOf(decalId: string, clientX: number, clientY: number): DecalPlane | null {
    const drawing = this.drawings.get(decalId);
    if (drawing === undefined) {
      return null;
    }
    const press = this.toPage(clientX, clientY);
    const copies = copiesOf(drawing.triangles);
    let best: { x: number; y: number; map: [number, number, number, number] } | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < copies.length; i++) {
      const centre = decalToPage(drawing.triangles, copies[i], 0, 0);
      if (centre === null) {
        continue;
      }
      const d = Math.hypot(centre.x - press.x, centre.y - press.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = centre;
      }
    }
    if (best === null) {
      return null;
    }
    const centre = best;
    const m = centre.map;
    const determinant = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(determinant) < 1e-12) {
      return null;
    }
    const self = this;
    return {
      coordinates: function coordinates(x: number, y: number): [number, number] | null {
        const p = self.toPage(x, y);
        const dx = p.x - centre.x;
        const dy = p.y - centre.y;
        const a = (m[3] * dx - m[1] * dy) / determinant;
        const b = (-m[2] * dx + m[0] * dy) / determinant;
        return [a, b];
      },
    };
  }

  // The world direction of page right at a point on the page (towards the
  // tail on the strip, along the island's right on an island), or null.
  // A decal put on from the page is laid upright as the page shows it.
  rightAt(clientX: number, clientY: number): Vec3 | null {
    const p = this.toPage(clientX, clientY);
    const step = 0.5;
    const here = this.surfaceAtPage(p.x, p.y);
    if (here === null) {
      return null;
    }
    let ahead = this.surfaceAtPage(p.x + step, p.y);
    let sign = 1;
    if (ahead === null || ahead.chart !== here.chart) {
      ahead = this.surfaceAtPage(p.x - step, p.y);
      sign = -1;
    }
    if (ahead === null || ahead.chart !== here.chart) {
      return null;
    }
    const dx = (ahead.world[0] - here.world[0]) * sign;
    const dy = (ahead.world[1] - here.world[1]) * sign;
    const dz = (ahead.world[2] - here.world[2]) * sign;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-9) {
      return null;
    }
    return [dx / length, dy / length, dz / length];
  }

  // Where a file dropped on the page landed, once (null if it was not
  // dropped here), and page right there.
  takeDrop(): { at: SurfacePoint; right: Vec3 | null } | null {
    const at = this.dropAt;
    this.dropAt = null;
    if (at === null) {
      return null;
    }
    const point = this.surfaceUnder(at.x, at.y);
    if (point === null) {
      return null;
    }
    return { at: point, right: this.rightAt(at.x, at.y) };
  }

  // ---------------------------------------------------------------------------
  // Pointer.

  private onPointerDown(event: PointerEvent): void {
    event.stopPropagation();
    this.canvas.setPointerCapture(event.pointerId);
    const decals = this.editor.decals;
    const press: PressState = {
      kind: 'none',
      button: event.button,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      startRoll: this.editor.view.roll,
      radius: 0,
    };
    this.press = press;
    if (event.button === 1 || event.button === 2) {
      press.kind = 'pan';
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (decals.pointerDown(this.pointer, event.clientX, event.clientY)) {
      press.kind = 'decal';
      this.editor.notify();
      return;
    }
    const p = this.toPage(event.clientX, event.clientY);
    const under = this.surfaceAtPage(p.x, p.y);
    if (under !== null && under.chart >= -1 && under.chart <= 1) {
      press.kind = 'roll';
      press.radius = radiusOf(under.world);
      return;
    }
    press.kind = 'pan';
  }

  private onPointerMove(event: PointerEvent): void {
    event.stopPropagation();
    const decals = this.editor.decals;
    const press = this.press;
    if (press !== null && !press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) > clickSlop) {
      press.moved = true;
    }
    if (press !== null && press.kind === 'pan' && press.moved) {
      this.userMoved = true;
      this.originX = this.originX - (event.clientX - press.lastX) / this.zoom;
      this.originY = this.originY + (event.clientY - press.lastY) / this.zoom;
      this.canvas.style.cursor = 'grabbing';
      this.queueDraw();
    } else if (press !== null && press.kind === 'roll' && press.moved) {
      this.userMoved = true;
      // Sideways pans; up and down rolls, so the point grabbed stays under
      // the pointer: moving it down by d mm turns the middle of the strip
      // towards the top by d / r.
      this.originX = this.originX - (event.clientX - press.lastX) / this.zoom;
      const down = (event.clientY - press.y) / this.zoom;
      if (press.radius > 1e-6) {
        this.queueRoll(press.startRoll + down / press.radius);
      }
      this.canvas.style.cursor = 'grabbing';
      this.queueDraw();
    } else if (decals.isBusy() || (press !== null && press.kind === 'decal')) {
      decals.pointerMove(this.pointer, event.clientX, event.clientY, event.shiftKey);
    }
    // (Until the press moves past the click slop it is not a drag, and the
    // pan starts from where it was pressed.)
    if (press !== null && press.moved) {
      press.lastX = event.clientX;
      press.lastY = event.clientY;
    }
    if (press === null || press.kind !== 'pan') {
      this.hover(event.clientX, event.clientY);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    event.stopPropagation();
    const decals = this.editor.decals;
    const press = this.press;
    this.press = null;
    if (decals.isBusy() || (press !== null && press.kind === 'decal')) {
      decals.pointerMove(this.pointer, event.clientX, event.clientY, event.shiftKey);
      decals.pointerUp(this.pointer, event.clientX, event.clientY, true);
      this.editor.notify();
      this.hover(event.clientX, event.clientY);
      return;
    }
    if (press === null || press.moved) {
      this.hover(event.clientX, event.clientY);
      return;
    }
    // A click: right cancels, left on nothing in particular clears the decal selection.
    if (press.button === 2) {
      decals.cancel();
      this.editor.notify();
    } else if (press.button === 0 && decals.selectedId !== null) {
      decals.select(null);
    }
  }

  private queueRoll(roll: number): void {
    const first = this.pendingRoll === null;
    this.pendingRoll = roll;
    if (!first) {
      return;
    }
    const self = this;
    requestAnimationFrame(function roll() {
      const wanted = self.pendingRoll;
      self.pendingRoll = null;
      if (wanted !== null) {
        self.editor.view.setRoll(wanted);
      }
    });
  }

  // The pointer over the page: cursor, and the matching point in 3D.
  private hover(clientX: number, clientY: number): void {
    const p = this.toPage(clientX, clientY);
    const rect = this.canvas.getBoundingClientRect();
    let found: { at: SurfacePoint; world: Vec3; chart: number } | null = null;
    if (clientY > rect.top + rulerHeight) {
      found = this.surfaceAtPage(p.x, p.y);
    }
    this.hoverPage = found === null ? null : p;
    this.editor.showLinkedPoint(found === null ? null : found.world);
    if (this.press !== null && this.press.moved && this.press.kind !== 'decal') {
      return;
    }
    let cursor = this.editor.decals.cursorAt(this.pointer, clientX, clientY);
    if (cursor === null) {
      cursor = found !== null && found.chart >= -1 && found.chart <= 1 ? 'grab' : 'default';
    }
    this.canvas.style.cursor = cursor;
  }

  // ---------------------------------------------------------------------------
  // Drawing.

  queueDraw(): void {
    if (this.drawQueued) {
      return;
    }
    this.drawQueued = true;
    const self = this;
    requestAnimationFrame(function frame() {
      self.drawQueued = false;
      self.draw();
    });
  }

  private draw(): void {
    const start = performance.now();
    const context = this.context;
    const ratio = window.devicePixelRatio;
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.handlePoints = [];
    if (this.view === null) {
      return;
    }
    this.drawGrid(width, height);
    const doc = this.editor.shownDocument;
    const toPage = [this.zoom * ratio, 0, 0, -this.zoom * ratio, -this.originX * this.zoom * ratio, this.originY * this.zoom * ratio];
    context.setTransform(toPage[0], toPage[1], toPage[2], toPage[3], toPage[4], toPage[5]);
    // Each part filled, and stroked in its own colour with a hair-thin line:
    // long thin triangles side by side otherwise leave faint seams between
    // them when anti-aliased.
    const seamCover = 0.6 / this.zoom;
    context.lineWidth = seamCover;
    context.lineJoin = 'round';
    for (let i = 0; i < this.stripPaths.length; i++) {
      const entry = this.stripPaths[i];
      const colour = colourOf(doc, entry.placedId);
      context.globalAlpha = entry.band === 0 ? 1 : 0.4;
      context.fillStyle = colour;
      context.fill(entry.path);
      if (entry.band === 0) {
        context.strokeStyle = colour;
        context.stroke(entry.path);
      }
    }
    context.globalAlpha = 1;
    for (let i = 0; i < this.islandPaths.length; i++) {
      const colour = colourOf(doc, this.islandPaths[i].placedId);
      context.fillStyle = colour;
      context.fill(this.islandPaths[i].path);
      context.strokeStyle = colour;
      context.stroke(this.islandPaths[i].path);
    }
    // Lines, a constant width on screen.
    const pixel = 1 / this.zoom;
    context.lineJoin = 'round';
    context.lineWidth = pixel;
    context.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    context.stroke(this.jointPath);
    context.strokeStyle = 'rgba(230, 230, 236, 0.55)';
    context.stroke(this.outlinePath);
    context.stroke(this.seamPath);
    context.setLineDash([4 * pixel, 4 * pixel]);
    context.strokeStyle = 'rgba(230, 230, 236, 0.3)';
    context.stroke(this.repeatPath);
    context.setLineDash([]);

    this.drawDecals(doc);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawLabels();
    this.drawSelection(doc);
    this.drawHoverFrom3d();
    this.drawRuler(width);
    const elapsed = performance.now() - start;
    this.drawTimes.push(elapsed);
    if (this.drawTimes.length > 5000) {
      this.drawTimes.shift();
    }
  }

  private drawGrid(width: number, height: number): void {
    const context = this.context;
    const ratio = window.devicePixelRatio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const left = this.originX;
    const right = this.originX + width / this.zoom;
    const top = this.originY;
    const bottom = this.originY - height / this.zoom;
    const levels: Array<[number, string]> = [
      [1, '#0d0d10'],
      [10, '#16161a'],
      [100, '#202026'],
    ];
    for (let l = 0; l < levels.length; l++) {
      const step = levels[l][0];
      if (step * this.zoom < 7) {
        continue;
      }
      context.strokeStyle = levels[l][1];
      context.lineWidth = 1;
      context.beginPath();
      for (let x = Math.ceil(left / step) * step; x <= right; x = x + step) {
        const sx = Math.round((x - this.originX) * this.zoom) + 0.5;
        context.moveTo(sx, 0);
        context.lineTo(sx, height);
      }
      for (let y = Math.ceil(bottom / step) * step; y <= top; y = y + step) {
        const sy = Math.round((this.originY - y) * this.zoom) + 0.5;
        context.moveTo(0, sy);
        context.lineTo(width, sy);
      }
      context.stroke();
    }
  }

  private texture(artwork: Artwork, colourMap: Record<string, string>, longest: number): HTMLCanvasElement {
    const size = textureSize(longest);
    const key = artwork.id + '|' + JSON.stringify(colourMap) + '|' + String(size);
    let canvas = this.textures.get(key);
    if (canvas === undefined) {
      canvas = rasterise(artwork, colourMap, size);
      this.textures.set(key, canvas);
    }
    return canvas;
  }

  // A decal's drawing: its page triangles, and a bitmap of it at about the
  // screen's resolution, made again only when the decal, the roll or the
  // zoom (by a good step) changes.
  private drawingOf(grid: DecalGrid, decal: Pick<Decal, 'artworkId' | 'colourMap' | 'width' | 'height' | 'flipX' | 'flipY'>, cached: DecalDrawing | null): DecalDrawing | null {
    const view = this.view;
    if (view === null) {
      return null;
    }
    const artwork = this.editor.decals.artworks.get(decal.artworkId);
    if (artwork === undefined) {
      return null;
    }
    const wanted = Math.min(24, Math.max(1, Math.pow(2, Math.ceil(Math.log2(this.zoom * window.devicePixelRatio)))));
    const key = JSON.stringify([decal.artworkId, decal.colourMap, decal.width, decal.height, decal.flipX, decal.flipY]);
    let drawing = cached;
    if (drawing === null || drawing.grid !== grid || drawing.roll !== view.roll || drawing.key !== key) {
      const triangles = decalPageTriangles(view, grid);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let t = 0; t < triangles.length; t++) {
        const p = triangles[t].page;
        for (let q = 0; q < 6; q = q + 2) {
          minX = Math.min(minX, p[q]);
          maxX = Math.max(maxX, p[q]);
          minY = Math.min(minY, p[q + 1]);
          maxY = Math.max(maxY, p[q + 1]);
        }
      }
      drawing = { grid: grid, roll: view.roll, key: key, triangles: triangles, raster: null, wantedResolution: 0, pixelsPerMillimetre: 0, minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }
    const settled = Date.now();
    if (drawing.triangles.length > 0 && (drawing.raster === null || drawing.wantedResolution !== wanted)) {
      // While zooming, a bitmap that is too coarse is kept until zooming stops.
      if (drawing.raster === null || this.wheelSettled(settled)) {
        this.rasteriseDrawing(drawing, artwork, decal, wanted);
      }
    }
    return drawing;
  }

  private lastWheel = 0;
  private wheelSettled(now: number): boolean {
    return now - this.lastWheel > 140;
  }

  private rasteriseDrawing(drawing: DecalDrawing, artwork: Artwork, decal: Pick<Decal, 'colourMap' | 'width' | 'height' | 'flipX' | 'flipY'>, wanted: number): void {
    // Keep the bitmap within 4096 px on its long side.
    const spanX = drawing.maxX - drawing.minX;
    const spanY = drawing.maxY - drawing.minY;
    let scale = wanted;
    while (scale > 0.25 && Math.max(spanX, spanY) * scale > 4096) {
      scale = scale / 2;
    }
    const canvas = drawing.raster === null ? document.createElement('canvas') : drawing.raster;
    canvas.width = Math.max(1, Math.ceil(spanX * scale) + 2);
    canvas.height = Math.max(1, Math.ceil(spanY * scale) + 2);
    const context = canvas.getContext('2d');
    if (context === null) {
      return;
    }
    const texture = this.texture(artwork, decal.colourMap, Math.max(decal.width, decal.height));
    for (let t = 0; t < drawing.triangles.length; t++) {
      const triangle = drawing.triangles[t];
      const destination: number[] = [];
      const source: number[] = [];
      for (let q = 0; q < 3; q++) {
        destination.push(1 + (triangle.page[2 * q] - drawing.minX) * scale, 1 + (drawing.maxY - triangle.page[2 * q + 1]) * scale);
        let dx = triangle.decal[2 * q];
        let dy = triangle.decal[2 * q + 1];
        if (decal.flipX) {
          dx = -dx;
        }
        if (decal.flipY) {
          dy = -dy;
        }
        source.push(((dx + decal.width / 2) / decal.width) * texture.width, (1 - (dy + decal.height / 2) / decal.height) * texture.height);
      }
      drawTexturedTriangle(context, texture, source, destination);
    }
    drawing.raster = canvas;
    drawing.wantedResolution = wanted;
    drawing.pixelsPerMillimetre = scale;
  }

  private drawDecals(doc: AssemblyDocument): void {
    const context = this.context;
    const ratio = window.devicePixelRatio;
    const decals = this.editor.decals;
    const present = new Set<string>();
    for (let layer = 0; layer < doc.decals.length; layer++) {
      const decal = doc.decals[layer];
      if (decal.hidden) {
        continue;
      }
      const grid = decals.gridOf(decal.id);
      if (grid === null) {
        continue;
      }
      const cached = this.drawings.get(decal.id);
      const drawing = this.drawingOf(grid, decal, cached === undefined ? null : cached);
      if (drawing === null) {
        continue;
      }
      this.drawings.set(decal.id, drawing);
      present.add(decal.id);
      this.blit(context, drawing, ratio, 1);
    }
    const self = this;
    this.drawings.forEach(function removeStale(_drawing, id) {
      if (!present.has(id)) {
        self.drawings.delete(id);
      }
    });
    // The decal being held, following the pointer.
    const heldGrid = decals.heldGrid;
    const heldArtwork = decals.heldArtworkId();
    if (heldGrid !== null && heldArtwork !== null) {
      const settings = decals.heldSettingsNow();
      if (settings !== null) {
        this.heldDrawing = this.drawingOf(heldGrid, settings, this.heldDrawing);
        if (this.heldDrawing !== null) {
          this.blit(context, this.heldDrawing, ratio, 0.85);
        }
      }
    } else {
      this.heldDrawing = null;
    }
  }

  private blit(context: CanvasRenderingContext2D, drawing: DecalDrawing, ratio: number, alpha: number): void {
    if (drawing.raster === null) {
      return;
    }
    context.save();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = alpha;
    const scale = drawing.pixelsPerMillimetre;
    const x = (drawing.minX - 1 / scale - this.originX) * this.zoom;
    const y = (this.originY - drawing.maxY - 1 / scale) * this.zoom;
    context.imageSmoothingQuality = 'high';
    context.drawImage(drawing.raster, x, y, (drawing.raster.width / scale) * this.zoom, (drawing.raster.height / scale) * this.zoom);
    context.restore();
  }

  private drawLabels(): void {
    const page = this.page;
    if (page === null) {
      return;
    }
    const context = this.context;
    // Beside the island, to its right: islands are stacked one above the
    // other, so there is room there at any zoom.
    context.font = '11px "DM Sans", system-ui, sans-serif';
    context.fillStyle = '#85858c';
    context.textBaseline = 'middle';
    for (let i = 0; i < page.islands.length; i++) {
      const island = page.islands[i];
      const x = (island.maxX + island.offsetX - this.originX) * this.zoom + 6;
      const y = (this.originY - (island.minY + island.maxY) / 2 - island.offsetY) * this.zoom;
      context.fillText(island.label, x, y);
    }
  }

  // The selected decal: its outline and handles, on every drawing of it.
  private drawSelection(doc: AssemblyDocument): void {
    const decals = this.editor.decals;
    const id = decals.selectedId;
    if (id === null || decals.isBusy()) {
      return;
    }
    const decal = findDecal(doc, id);
    const drawing = this.drawings.get(id);
    if (decal === null || drawing === undefined) {
      return;
    }
    const context = this.context;
    const halfWidth = decal.width / 2;
    const halfHeight = decal.height / 2;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1;
    context.beginPath();
    for (let t = 0; t < drawing.triangles.length; t++) {
      const triangle = drawing.triangles[t];
      for (let k = 0; k < 3; k++) {
        const kk = (k + 1) % 3;
        const ax = triangle.decal[2 * k];
        const ay = triangle.decal[2 * k + 1];
        const bx = triangle.decal[2 * kk];
        const by = triangle.decal[2 * kk + 1];
        const onEdge = (Math.abs(Math.abs(ax) - halfWidth) < 1e-6 && Math.abs(ax - bx) < 1e-9) || (Math.abs(Math.abs(ay) - halfHeight) < 1e-6 && Math.abs(ay - by) < 1e-9);
        if (!onEdge) {
          continue;
        }
        const a = this.toCanvas(triangle.page[2 * k], triangle.page[2 * k + 1]);
        const b = this.toCanvas(triangle.page[2 * kk], triangle.page[2 * kk + 1]);
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
      }
    }
    // Handles of each drawing of the decal that has its centre (not a
    // sliver of it reaching into the repeat past the seam).
    const copies = copiesOf(drawing.triangles);
    const handles: HandlePoint[] = [];
    for (let i = 0; i < copies.length; i++) {
      if (decalToPage(drawing.triangles, copies[i], 0, 0) === null) {
        continue;
      }
      const corners: Array<[number, number]> = [
        [-halfWidth, halfHeight],
        [halfWidth, halfHeight],
        [halfWidth, -halfHeight],
        [-halfWidth, -halfHeight],
      ];
      for (let k = 0; k < corners.length; k++) {
        const p = decalToPage(drawing.triangles, copies[i], corners[k][0], corners[k][1]);
        if (p !== null) {
          const c = this.toCanvas(p.x, p.y);
          handles.push({ handle: 'scale', x: c.x, y: c.y });
        }
      }
      const top = decalToPage(drawing.triangles, copies[i], 0, halfHeight);
      if (top !== null) {
        // Straight up from the top edge, in the decal's own up direction.
        const upX = top.map[1];
        const upY = top.map[3];
        const upLength = Math.hypot(upX, upY);
        if (upLength > 1e-9) {
          const start = this.toCanvas(top.x, top.y);
          const handleX = start.x + (upX / upLength) * rotateHandleOffset;
          const handleY = start.y - (upY / upLength) * rotateHandleOffset;
          context.moveTo(start.x, start.y);
          context.lineTo(handleX, handleY);
          handles.push({ handle: 'rotate', x: handleX, y: handleY });
        }
      }
    }
    context.stroke();
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      context.beginPath();
      if (h.handle === 'scale') {
        context.rect(h.x - 4, h.y - 4, 8, 8);
      } else {
        context.arc(h.x, h.y, 4.5, 0, 2 * Math.PI);
      }
      context.fillStyle = '#ffffff';
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = '#1a1a1d';
      context.stroke();
    }
    this.handlePoints = handles;
  }

  // The point under the pointer in 3D, wherever it shows on the page.
  private drawHoverFrom3d(): void {
    const view = this.view;
    const point = this.editor.hoverPoint;
    if (view === null || point === null || this.hoverPage !== null) {
      return;
    }
    const surface: Surface = this.editor.decals.surfaceFor(this.editor.document);
    if (point.piece >= surface.pieces.length) {
      return;
    }
    const placedId = surface.pieces[point.piece].placedId;
    const pagePiece = view.page.placedIds.indexOf(placedId);
    if (pagePiece < 0) {
      return;
    }
    const w = barycentricOf(surface.pieces[point.piece].mesh, point.triangle, point.point);
    const images = surfaceToPage(view, pagePiece, point.triangle, w);
    const context = this.context;
    for (let i = 0; i < images.length; i++) {
      const c = this.toCanvas(images[i].x, images[i].y);
      context.beginPath();
      context.arc(c.x, c.y, 4, 0, 2 * Math.PI);
      context.fillStyle = '#ffffff';
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = '#1a1a1d';
      context.stroke();
    }
  }

  // Page mm -> canvas CSS px.
  private toCanvas(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.originX) * this.zoom, y: (this.originY - y) * this.zoom };
  }

  // The station ruler: mm from the nose tip along the body.
  private drawRuler(width: number): void {
    const context = this.context;
    context.fillStyle = '#101012';
    context.fillRect(0, 0, width, rulerHeight);
    context.fillStyle = '#26262a';
    context.fillRect(0, rulerHeight - 1, width, 1);
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    let step = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] * this.zoom >= 64) {
        step = steps[i];
        break;
      }
    }
    const minor = step / 5;
    const left = this.originX;
    const right = this.originX + width / this.zoom;
    context.strokeStyle = '#55555b';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = Math.ceil(left / minor) * minor; x <= right; x = x + minor) {
      const sx = Math.round((x - this.originX) * this.zoom) + 0.5;
      const major = Math.abs(x / step - Math.round(x / step)) < 1e-6;
      context.moveTo(sx, rulerHeight - (major ? 8 : 4));
      context.lineTo(sx, rulerHeight - 1);
    }
    context.stroke();
    context.font = '10px "JetBrains Mono", ui-monospace, monospace';
    context.fillStyle = '#85858c';
    context.textBaseline = 'top';
    for (let x = Math.ceil(left / step) * step; x <= right; x = x + step) {
      const sx = Math.round((x - this.originX) * this.zoom);
      context.fillText(String(Math.round(x)), sx + 3, 3);
    }
  }

  // ---------------------------------------------------------------------------
  // For the test hook.

  islandScreenBoxes(): Array<{ label: string; placedId: string; left: number; top: number; right: number; bottom: number }> {
    const result: Array<{ label: string; placedId: string; left: number; top: number; right: number; bottom: number }> = [];
    const page = this.page;
    if (page === null) {
      return result;
    }
    for (let i = 0; i < page.islands.length; i++) {
      const island = page.islands[i];
      const a = this.toClient(island.minX + island.offsetX, island.maxY + island.offsetY);
      const b = this.toClient(island.maxX + island.offsetX, island.minY + island.offsetY);
      result.push({ label: island.label, placedId: page.placedIds[island.piece], left: a.x, top: a.y, right: b.x, bottom: b.y });
    }
    return result;
  }

  // Client positions of a world-placed surface point (placed id, triangle,
  // barycentric) on the page.
  screenImages(placedId: string, triangle: number, barycentric: Vec3): Array<{ x: number; y: number; chart: number }> {
    const view = this.view;
    const result: Array<{ x: number; y: number; chart: number }> = [];
    if (view === null) {
      return result;
    }
    const piece = view.page.placedIds.indexOf(placedId);
    if (piece < 0) {
      return result;
    }
    const images = surfaceToPage(view, piece, triangle, barycentric);
    for (let i = 0; i < images.length; i++) {
      const c = this.toClient(images[i].x, images[i].y);
      result.push({ x: c.x, y: c.y, chart: images[i].chart });
    }
    return result;
  }

  // The world point under a client position on the page, or null.
  worldAt(clientX: number, clientY: number): Vec3 | null {
    const p = this.toPage(clientX, clientY);
    const found = this.surfaceAtPage(p.x, p.y);
    return found === null ? null : found.world;
  }

  handleScreenPoints(): Array<{ handle: string; x: number; y: number }> {
    const rect = this.canvas.getBoundingClientRect();
    const result: Array<{ handle: string; x: number; y: number }> = [];
    for (let i = 0; i < this.handlePoints.length; i++) {
      result.push({ handle: this.handlePoints[i].handle, x: rect.left + this.handlePoints[i].x, y: rect.top + this.handlePoints[i].y });
    }
    return result;
  }

  // Client positions of a decal's centre, one per drawing of it.
  decalCentres(id: string): Array<{ x: number; y: number }> {
    const drawing = this.drawings.get(id);
    const result: Array<{ x: number; y: number }> = [];
    if (drawing === undefined) {
      return result;
    }
    const copies = copiesOf(drawing.triangles);
    for (let i = 0; i < copies.length; i++) {
      const p = decalToPage(drawing.triangles, copies[i], 0, 0);
      if (p !== null) {
        result.push(this.toClient(p.x, p.y));
      }
    }
    return result;
  }

  // Seam edges on screen (client y of the strip's top and bottom edge at a page x).
  stripEdgesAt(x: number): { top: number; bottom: number } | null {
    const view = this.view;
    if (view === null) {
      return null;
    }
    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 0; i < view.seams.length; i = i + 4) {
      const x1 = view.seams[i];
      const x2 = view.seams[i + 2];
      if ((x1 - x) * (x2 - x) > 0) {
        continue;
      }
      const y = (view.seams[i + 1] + view.seams[i + 3]) / 2;
      top = Math.max(top, y);
      bottom = Math.min(bottom, y);
    }
    if (!Number.isFinite(top)) {
      return null;
    }
    return { top: this.toClient(x, top).y, bottom: this.toClient(x, bottom).y };
  }

  linkedHoverShown(): number {
    return this.hoverPage === null ? 0 : 1;
  }
}

function addPolygon(path: Path2D, polygon: number[]): void {
  path.moveTo(polygon[0], polygon[1]);
  for (let q = 2; q < polygon.length; q = q + 2) {
    path.lineTo(polygon[q], polygon[q + 1]);
  }
  path.closePath();
}

function segmentsPath(segments: number[]): Path2D {
  const path = new Path2D();
  for (let i = 0; i < segments.length; i = i + 4) {
    path.moveTo(segments[i], segments[i + 1]);
    path.lineTo(segments[i + 2], segments[i + 3]);
  }
  return path;
}

function colourOf(doc: AssemblyDocument, placedId: string): string {
  const colour = doc.partColours[placedId];
  if (colour === undefined) {
    return partGrey;
  }
  return colour;
}

function copiesOf(triangles: DecalPageTriangle[]): number[] {
  const seen: number[] = [];
  for (let t = 0; t < triangles.length; t++) {
    if (seen.indexOf(triangles[t].copy) < 0) {
      seen.push(triangles[t].copy);
    }
  }
  return seen;
}

// Draw the part of `image` in the source triangle into the destination
// triangle (both 3 x/y pairs in px), by an affine map, clipped to the
// destination grown by half a pixel so neighbouring triangles leave no
// hairline gap.
function drawTexturedTriangle(context: CanvasRenderingContext2D, image: HTMLCanvasElement, source: number[], destination: number[]): void {
  const u0 = source[0];
  const v0 = source[1];
  const du1 = source[2] - u0;
  const dv1 = source[3] - v0;
  const du2 = source[4] - u0;
  const dv2 = source[5] - v0;
  const determinant = du1 * dv2 - du2 * dv1;
  if (Math.abs(determinant) < 1e-9) {
    return;
  }
  const x0 = destination[0];
  const y0 = destination[1];
  const dx1 = destination[2] - x0;
  const dy1 = destination[3] - y0;
  const dx2 = destination[4] - x0;
  const dy2 = destination[5] - y0;
  const a = (dx1 * dv2 - dx2 * dv1) / determinant;
  const c = (dx2 * du1 - dx1 * du2) / determinant;
  const b = (dy1 * dv2 - dy2 * dv1) / determinant;
  const d = (dy2 * du1 - dy1 * du2) / determinant;
  const e = x0 - a * u0 - c * v0;
  const f = y0 - b * u0 - d * v0;
  const centreX = (destination[0] + destination[2] + destination[4]) / 3;
  const centreY = (destination[1] + destination[3] + destination[5]) / 3;
  context.save();
  context.beginPath();
  for (let q = 0; q < 3; q++) {
    const px = destination[2 * q];
    const py = destination[2 * q + 1];
    const away = Math.hypot(px - centreX, py - centreY);
    const grow = away > 1e-9 ? 0.5 / away : 0;
    const gx = px + (px - centreX) * grow;
    const gy = py + (py - centreY) * grow;
    if (q === 0) {
      context.moveTo(gx, gy);
    } else {
      context.lineTo(gx, gy);
    }
  }
  context.closePath();
  context.clip();
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}
