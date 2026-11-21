// End-to-end check of stages 1 to 4, driving the built app with real mouse events
// (page.mouse move/down/up and real key presses; nothing is placed by calling
// the editor). window.dc6 is only used to find where things are on screen and
// to read the resulting document.
//
// Run with:   npm run e2e        (builds first, then runs this)
// Screenshots: one per step, in $DC6_E2E_OUT or the scratch folder below.
//
// The rocket built, nose to the left:
//   nose - can - tube (root) - boattail, four fins on the tube, a sled hidden.
// The can is snapped onto the tube by the tip of its internals and then
// pushed 70 mm aft by typing "+70" (its internals go into the tube); the
// nose is snapped onto the can's spigot and then dragged 12 mm aft with the
// move gizmo, so it screws over the spigot and its rim meets the can's shoulder.
// The fins are dropped 40 degrees above the side and snap to 45 (15 degree
// roll steps from straight up).
//
// Then decals (stage 2) and the cut file (stage 3): see decalSteps below;
// then the flat page linked to 3D (stage 4): see pageSteps.

import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Browser, Page, Playwright } from './playwright-types.ts';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import type { DecalInfo } from '../src/app/test-hook.ts';
import type { AssemblyDocument, PlacedPart } from '../src/model/document.ts';
import type { PageInfo, TestHook, WorldFace } from '../src/app/test-hook.ts';
import type { Vec3 } from '../src/geometry/vec3.ts';
import { body, can } from './test-model-dimensions.ts';

// Playwright is installed on the machine, not as a project dependency.
const require = createRequire(import.meta.url);
const playwright = require('playwright') as Playwright;

const outputDirectory = process.env.DC6_E2E_OUT ?? '/tmp/claude-0/-home-user-DC6/957e7891-de01-5aa6-b91e-10b2b12b1724/scratchpad/e2e';
mkdirSync(outputDirectory, { recursive: true });

declare global {
  interface Window {
    dc6: TestHook;
  }
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log('  ok   ' + message);
  } else {
    console.log('  FAIL ' + message);
    failures.push(message);
  }
}

let stepNumber = 0;
const runStart = Date.now();
async function shot(page: Page, name: string): Promise<void> {
  stepNumber = stepNumber + 1;
  const file = join(outputDirectory, String(stepNumber).padStart(2, '0') + '-' + name + '.png');
  await page.screenshot({ path: file });
  console.log('  screenshot ' + file + ' at ' + ((Date.now() - runStart) / 1000).toFixed(1) + ' s');
}

async function documentOf(page: Page): Promise<AssemblyDocument> {
  return page.evaluate(function read() {
    return window.dc6.document();
  });
}

async function faces(page: Page, placedId: string): Promise<WorldFace[]> {
  return page.evaluate(function read(id: string) {
    return window.dc6.attachFaces(id);
  }, placedId);
}

async function heldFaces(page: Page): Promise<WorldFace[]> {
  return page.evaluate(function read() {
    return window.dc6.heldFaces();
  });
}

async function heldSnap(page: Page): Promise<string | null> {
  return page.evaluate(function read() {
    return window.dc6.heldSnap();
  });
}

async function screenOf(page: Page, point: Vec3): Promise<{ x: number; y: number }> {
  return page.evaluate(function project(p: Vec3) {
    return window.dc6.screenOf(p);
  }, point);
}

// The mouse, moved in small steps as a hand would, remembering where it is.
const mouseAt = { x: 0, y: 0 };
async function glide(page: Page, x: number, y: number, steps: number): Promise<void> {
  await page.mouse.move(x, y, { steps: steps });
  mouseAt.x = x;
  mouseAt.y = y;
  await page.waitForTimeout(80);
}

async function click(page: Page, x: number, y: number): Promise<void> {
  await glide(page, x, y, 4);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function clickSelector(page: Page, selector: string): Promise<void> {
  // As a user scrolls a long list to reach an item.
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) {
    throw new Error('no element for ' + selector);
  }
  await click(page, box.x + box.width / 2, box.y + box.height / 2);
}

async function fitView(page: Page): Promise<void> {
  await clickSelector(page, 'button[data-view="side"]');
  await clickSelector(page, 'button[data-view="fit"]');
  await page.waitForTimeout(100);
}

function placedOfPart(doc: AssemblyDocument, names: Record<string, string>, name: string): PlacedPart[] {
  return doc.placed.filter(function byName(p) {
    return names[p.partId] === name;
  });
}

function one(doc: AssemblyDocument, names: Record<string, string>, name: string): PlacedPart {
  const list = placedOfPart(doc, names, name);
  if (list.length !== 1) {
    throw new Error('expected one placed ' + name + ', found ' + String(list.length));
  }
  return list[0];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// The rocket axis is world X, nose towards -X.
function fromAxis(p: Vec3): number {
  return Math.hypot(p[1], p[2]);
}

// The face of the given radius whose normal points along +X (sign 1) or -X (sign -1).
function faceFacing(list: WorldFace[], radius: number, sign: number): WorldFace {
  for (let i = 0; i < list.length; i++) {
    const face = list[i];
    const r = face.radius === null ? -1 : face.radius;
    if (Math.abs(r - radius) < 0.05 && face.normal[0] * sign > 0.99) {
      return face;
    }
  }
  throw new Error('no face of radius ' + String(radius) + ' facing ' + String(sign));
}

function faceOfRadius(list: WorldFace[], radius: number): WorldFace {
  for (let i = 0; i < list.length; i++) {
    const r = list[i].radius === null ? -1 : list[i].radius!;
    if (Math.abs(r - radius) < 0.05) {
      return list[i];
    }
  }
  throw new Error('no face of radius ' + String(radius));
}

// Bring the held part's attach face of `ownRadius` onto the screen point of
// `target`, the way a user would: look where the node is and move the mouse
// by the difference.
async function bringHeldNodeTo(page: Page, ownRadius: number, target: Vec3): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const own = faceOfRadius(await heldFaces(page), ownRadius);
    const ownScreen = await screenOf(page, own.centre);
    const targetScreen = await screenOf(page, target);
    const dx = targetScreen.x - ownScreen.x;
    const dy = targetScreen.y - ownScreen.y;
    if (Math.hypot(dx, dy) < 3) {
      return;
    }
    if ((await heldSnap(page)) === 'stack') {
      return;
    }
    await glide(page, mouseAt.x + dx, mouseAt.y + dy, 8);
  }
}

// Drag the move gizmo's axis handle by about `millimetres` towards the tail
// (screen right in the side view). Returns the label shown during the drag.
async function dragAxisHandle(page: Page, millimetres: number): Promise<string | null> {
  const pivot = await page.evaluate(function read() {
    return window.dc6.gizmoPivot();
  });
  const pivotScreen = await screenOf(page, pivot);
  // Find the handle: slide right from the pivot until it lights up.
  let handle: { x: number; y: number } | null = null;
  for (let d = 16; d < 240; d = d + 4) {
    await glide(page, pivotScreen.x + d, pivotScreen.y, 1);
    const hovered = await page.evaluate(function read() {
      return window.dc6.gizmoHovered();
    });
    if (hovered) {
      handle = { x: pivotScreen.x + d, y: pivotScreen.y };
      break;
    }
  }
  if (handle === null) {
    throw new Error('could not find the move handle');
  }
  const mmPerPixel = await page.evaluate(function read(p: Vec3) {
    return window.dc6.millimetresPerPixel(p);
  }, pivot);
  await page.mouse.down();
  await glide(page, handle.x + millimetres / mmPerPixel, handle.y, 8);
  const label = await page.locator('.gizmo-label').textContent();
  await page.mouse.up();
  await page.waitForTimeout(100);
  return label;
}

async function main(): Promise<void> {
  const server = await preview({ preview: { port: 4179, strictPort: true }, logLevel: 'warn' });
  const browser = await playwright.chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 2 });
  // Long tasks on the main thread (anything over 50 ms), for the check
  // that building the page no longer holds the window up.
  await page.addInitScript(function watchLongTasks() {
    const tasks: number[] = [];
    (window as unknown as { longTasks: number[] }).longTasks = tasks;
    try {
      const observer = new PerformanceObserver(function seen(list) {
        const entries = list.getEntries();
        for (let i = 0; i < entries.length; i++) {
          tasks.push(entries[i].duration);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // No long task timing in this browser.
    }
  });
  page.on('pageerror', function report(error) {
    failures.push('page error: ' + error.message);
    console.log('page error: ' + error.message);
  });

  try {
    // DC6_E2E_FROM=<a .dc6 file> skips the assembly, decal and page steps
    // (a project saved at that point by a full run) and runs the rest.
    const from = process.env.DC6_E2E_FROM;
    if (from === undefined) {
      console.log('0. the empty window');
      await page.goto('http://localhost:4179/');
      await page.waitForTimeout(400);
      await shot(page, 'empty');

      console.log('1. load parts');
      await page.goto('http://localhost:4179/?parts=nose,tube,can,boattail,fin,sled');
      await page.waitForFunction(function hasHook() {
        return window.dc6 !== undefined;
      });
      await page.evaluate(function loaded() {
        return window.dc6.loaded();
      });
      await page.waitForTimeout(300);
      const names = await page.evaluate(function names() {
        return window.dc6.partNames();
      });
      check(Object.keys(names).length === 6, 'six parts in the list');
      await shot(page, 'loaded');

      const assemblyStart = Date.now();
      const canvas = await page.locator('canvas').first().boundingBox();
      if (canvas === null) {
        throw new Error('no canvas');
      }
      const middle = { x: canvas.x + canvas.width * 0.55, y: canvas.y + canvas.height * 0.5 };
      const emptySpot = { x: canvas.x + canvas.width * 0.5, y: canvas.y + canvas.height * 0.15 };

      console.log('2. drop the tube as root');
      await clickSelector(page, '.bin-item[data-part-name="tube"]');
      await glide(page, middle.x, middle.y, 20);
      await shot(page, 'tube-held');
      await click(page, middle.x, middle.y);
      let doc = await documentOf(page);
      const tube = one(doc, names, 'tube');
      check(doc.rootId === tube.id, 'the tube is the root');
      let tubeFaces = await faces(page, tube.id);
      check(fromAxis(tubeFaces[0].centre) < 0.01 && fromAxis(tubeFaces[1].centre) < 0.01, 'the tube lies on the rocket axis');
      await shot(page, 'tube-root');

      console.log('3. place on face: turn the tube end for end');
      await clickSelector(page, 'button[data-tool="face"]');
      const tubeMiddle: Vec3 = [(tubeFaces[0].centre[0] + tubeFaces[1].centre[0]) / 2, 0, body.outerRadius];
      let at = await screenOf(page, tubeMiddle);
      await click(page, at.x, at.y); // select the tube
      await clickSelector(page, 'button[data-view="nose"]');
      await page.waitForTimeout(100);
      await shot(page, 'tube-faces-from-nose');
      // The tube end facing the viewer (the nose end) is clicked; it becomes the aft end.
      const wasFore = faceFacing(tubeFaces, body.outerRadius, -1);
      at = await screenOf(page, [wasFore.centre[0], wasFore.centre[1] + 20, wasFore.centre[2]]);
      await click(page, at.x, at.y);
      doc = await documentOf(page);
      tubeFaces = await faces(page, tube.id);
      const nowAft = faceFacing(tubeFaces, body.outerRadius, 1);
      check(fromAxis(nowAft.centre) < 0.01, 'the clicked face is now the aft face, centred on the axis');
      check(doc.attachFaceByPart[tube.partId] !== undefined, 'the choice is remembered for the tube');
      await clickSelector(page, 'button[data-tool="place"]');
      await fitView(page);
      await shot(page, 'tube-turned');

      console.log('4. snap the can onto the tube by its internals, then drag it 70 mm aft with the move gizmo');
      await clickSelector(page, '.bin-item[data-part-name="can"]');
      await glide(page, emptySpot.x, emptySpot.y, 6);
      const tubeFore = faceFacing(tubeFaces, body.outerRadius, -1);
      const tubeForePoint = await screenOf(page, tubeFore.centre);
      await glide(page, tubeForePoint.x - 120, emptySpot.y, 6);
      await bringHeldNodeTo(page, can.ringOuterRadius, tubeFore.centre);
      check((await heldSnap(page)) === 'stack', 'the held can snaps onto the tube end');
      await shot(page, 'can-snapped');
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
      doc = await documentOf(page);
      const canPlaced = one(doc, names, 'can');
      check(canPlaced.parentId === tube.id, 'the can is a child of the tube');
      await clickSelector(page, 'button[data-tool="move"]');
      const canLabel = await dragAxisHandle(page, 70);
      check(canLabel === '+70 mm', 'dragging the can shows +70 mm (' + String(canLabel) + ')');
      let canFaces = await faces(page, canPlaced.id);
      const canTip = faceOfRadius(canFaces, can.ringOuterRadius);
      check(Math.abs(canTip.centre[0] - (tubeFore.centre[0] + 70)) < 1e-6, 'the can moved 70 mm aft: its internals are inside the tube');
      // The can's rim (local z = 0) now meets the tube's fore end.
      const spigotEnd = faceOfRadius(canFaces, can.spigotCoreRadius);
      const canRimStation = spigotEnd.centre[0] + can.shellHeight + can.spigotLength;
      check(Math.abs(canRimStation - tubeFore.centre[0]) < 0.01, 'the can rim meets the tube end');
      await fitView(page);
      await shot(page, 'can-pushed-in');

      console.log('5. snap the nose onto the can spigot, drag it roughly aft, then type 12 into the adjust panel');
      await clickSelector(page, 'button[data-tool="place"]');
      await clickSelector(page, '.bin-item[data-part-name="nose"]');
      await glide(page, emptySpot.x, emptySpot.y, 6);
      const spigotPoint = await screenOf(page, spigotEnd.centre);
      await glide(page, spigotPoint.x - 150, emptySpot.y, 6);
      await bringHeldNodeTo(page, body.outerRadius, spigotEnd.centre);
      check((await heldSnap(page)) === 'stack', 'the held nose snaps onto the can spigot');
      await shot(page, 'nose-snapped');
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
      doc = await documentOf(page);
      const nosePlaced = one(doc, names, 'nose');
      check(nosePlaced.parentId === canPlaced.id, 'the nose is a child of the can');
      await clickSelector(page, 'button[data-tool="move"]');
      const roughLabel = await dragAxisHandle(page, 9);
      await shot(page, 'nose-dragged-roughly');
      check(roughLabel !== null && roughLabel !== '+12 mm', 'the rough drag is not already 12 mm (' + String(roughLabel) + ')');
      const alongField = page.locator('.adjust input[data-field="along"]');
      const alongBox = await alongField.boundingBox();
      if (alongBox === null) {
        throw new Error('no adjust panel after the move');
      }
      await click(page, alongBox.x + alongBox.width / 2, alongBox.y + alongBox.height / 2);
      await page.keyboard.type('12', { delay: 30 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
      await shot(page, 'nose-adjusted');
      const noseFaces = await faces(page, nosePlaced.id);
      const noseBase = faceOfRadius(noseFaces, body.outerRadius);
      canFaces = await faces(page, canPlaced.id);
      const shoulderStation = faceOfRadius(canFaces, can.spigotCoreRadius).centre[0] + can.spigotLength;
      check(Math.abs(noseBase.centre[0] - shoulderStation) < 0.01, 'the nose rim lands on the can shoulder (off by ' + (noseBase.centre[0] - shoulderStation).toExponential(2) + ' mm)');
      check(Math.abs((noseBase.radius ?? 0) - can.endRadius) < 0.01 && fromAxis(noseBase.centre) < 0.01, 'nose and can are flush at the joint: both 33 mm, coaxial');
      await fitView(page);
      await shot(page, 'nose-on-can');

      console.log('6. snap the boattail onto the tube');
      await clickSelector(page, 'button[data-tool="place"]');
      await clickSelector(page, '.bin-item[data-part-name="boattail"]');
      const adjustGone = await page.evaluate(function hidden() {
        const panel = document.querySelector('.adjust') as HTMLElement | null;
        return panel === null || panel.style.display === 'none';
      });
      check(adjustGone, 'the adjust panel goes away when the user does something else');
      await glide(page, emptySpot.x, emptySpot.y, 6);
      tubeFaces = await faces(page, tube.id);
      const tubeAft = faceFacing(tubeFaces, body.outerRadius, 1);
      const tubeAftPoint = await screenOf(page, tubeAft.centre);
      await glide(page, tubeAftPoint.x + 120, emptySpot.y, 6);
      await bringHeldNodeTo(page, body.outerRadius, tubeAft.centre);
      check((await heldSnap(page)) === 'stack', 'the held boattail snaps onto the tube aft end');
      await shot(page, 'boattail-snapped');
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
      doc = await documentOf(page);
      const boattail = one(doc, names, 'boattail');
      check(boattail.parentId === tube.id, 'the boattail is a child of the tube');
      await fitView(page);
      await shot(page, 'boattail-dropped');

      console.log('7. one fin with x4 symmetry');
      for (let i = 0; i < 3; i++) {
        await clickSelector(page, 'button[data-control="symmetry"]');
      }
      const symmetryText = await page.locator('button[data-control="symmetry"]').textContent();
      check(symmetryText === '×4', 'symmetry set to x4');
      await clickSelector(page, '.bin-item[data-part-name="fin"]');
      await glide(page, emptySpot.x, emptySpot.y, 6);
      // On the tube, 60 mm forward of its aft end, 40 degrees above the side
      // facing us: the roll snaps to 45 (15 degree steps from straight up).
      const angle = (40 * Math.PI) / 180;
      const finPoint = await screenOf(page, [tubeAft.centre[0] - 60, body.outerRadius * Math.sin(angle), body.outerRadius * Math.cos(angle)]);
      await glide(page, finPoint.x, finPoint.y, 20);
      check((await heldSnap(page)) === 'surface', 'the held fin stands on the tube surface');
      await shot(page, 'fin-held');
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(100);
      await shot(page, 'fins-dropped');

      console.log('8. hide the sled');
      await clickSelector(page, '.bin-item[data-part-name="sled"]');
      await glide(page, emptySpot.x, emptySpot.y, 6);
      await click(page, emptySpot.x, emptySpot.y);
      doc = await documentOf(page);
      const sled = one(doc, names, 'sled');
      await shot(page, 'sled-dropped');
      await clickSelector(page, '.tree-row[data-placed-id="' + sled.id + '"] .eye');
      doc = await documentOf(page);
      check(one(doc, names, 'sled').hidden, 'the sled is hidden');
      await shot(page, 'sled-hidden');

      console.log('9. undo twice, redo once');
      await glide(page, middle.x, canvas.y + canvas.height - 40, 5);
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(80);
      doc = await documentOf(page);
      check(!one(doc, names, 'sled').hidden, 'first undo shows the sled again');
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(80);
      doc = await documentOf(page);
      check(placedOfPart(doc, names, 'sled').length === 0, 'second undo removes the sled');
      await page.keyboard.press('Control+Shift+z');
      await page.waitForTimeout(80);
      doc = await documentOf(page);
      check(placedOfPart(doc, names, 'sled').length === 1, 'redo puts the sled back');
      const assemblyMs = Date.now() - assemblyStart;
      console.log('scripted assembly took ' + (assemblyMs / 1000).toFixed(1) + ' s (including the scripted waits)');
      await page.keyboard.press('Escape');
      await fitView(page);
      await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 3);
      await page.waitForTimeout(150);
      await shot(page, 'final');
      await clickSelector(page, 'button[data-view="tail"]');
      await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 3);
      await page.waitForTimeout(150);
      await shot(page, 'final-from-tail');

      console.log('10. orbit around the finished rocket (look for speckle at every angle)');
      await fitView(page);
      const orbitStart = { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.9 };
      const drags = [
        [220, -60],
        [260, 120],
        [-200, -160],
      ];
      for (let i = 0; i < drags.length; i++) {
        await glide(page, orbitStart.x, orbitStart.y, 2);
        await page.mouse.down();
        await glide(page, orbitStart.x + drags[i][0], orbitStart.y + drags[i][1], 10);
        await page.mouse.up();
        await clickSelector(page, 'button[data-view="fit"]');
        await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 2);
        await page.waitForTimeout(150);
        await shot(page, 'orbit-' + String(i + 1));
      }

      console.log('11. check the assembly');
      doc = await documentOf(page);
      const sections = ['nose', 'can', 'tube', 'boattail'];
      const stations: number[] = [];
      for (let i = 0; i < sections.length; i++) {
        const placed = one(doc, names, sections[i]);
        const list = await faces(page, placed.id);
        let worst = 0;
        let worstAngle = 0;
        let sum = 0;
        for (let k = 0; k < list.length; k++) {
          worst = Math.max(worst, fromAxis(list[k].centre));
          worstAngle = Math.max(worstAngle, 1 - Math.abs(list[k].normal[0]));
          sum = sum + list[k].centre[0];
        }
        stations.push(sum / list.length);
        check(worst < 0.01 && worstAngle < 1e-9, sections[i] + ' is coaxial with the rocket axis (off by ' + worst.toExponential(2) + ' mm)');
      }
      check(stations[0] < stations[1] && stations[1] < stations[2] && stations[2] < stations[3], 'nose, can, tube, boattail run left to right (nose left)');
      const boattailFaces = await faces(page, boattail.id);
      const boattailFore = faceFacing(boattailFaces, body.outerRadius, -1);
      const gap = distance(boattailFore.centre, tubeAft.centre);
      check(gap < 0.01, 'the boattail touches the tube face to face (gap ' + gap.toExponential(2) + ' mm)');
      const fins = placedOfPart(doc, names, 'fin');
      check(fins.length === 4, 'four fins');
      const groups = new Set(
        fins.map(function group(f) {
          return f.symmetry === null ? 'none' : f.symmetry.group;
        }),
      );
      check(groups.size === 1 && !groups.has('none'), 'the four fins are one linked symmetry set');
      const angles: number[] = [];
      for (let i = 0; i < fins.length; i++) {
        const list = await faces(page, fins[i].id);
        const ownFace = fins[i].joint === null ? 0 : fins[i].joint!.ownFace;
        const root = list[ownFace];
        check(Math.abs(fromAxis(root.centre) - body.outerRadius) < 0.05, 'fin ' + String(i + 1) + ' root sits on the tube (r = ' + fromAxis(root.centre).toFixed(3) + ' mm)');
        // Square to the tube: the root face looks straight in at the axis.
        const radialLength = fromAxis(root.centre);
        const inward = (root.normal[1] * root.centre[1] + root.normal[2] * root.centre[2]) / radialLength;
        check(inward < -1 + 1e-6, 'fin ' + String(i + 1) + ' stands square to the tube');
        angles.push(Math.atan2(root.centre[2], root.centre[1]));
        const fromUp = (Math.atan2(root.centre[2], root.centre[1]) * 180) / Math.PI;
        const offStep = Math.abs(fromUp / 15 - Math.round(fromUp / 15)) * 15;
        check(offStep < 1e-6, 'fin ' + String(i + 1) + ' roll is a 15 degree step from straight up (' + fromUp.toFixed(4) + ' deg)');
      }
      angles.sort(function ascending(a, b) {
        return a - b;
      });
      for (let i = 0; i < angles.length; i++) {
        const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
        const spacing = ((next - angles[i]) * 180) / Math.PI;
        check(Math.abs(spacing - 90) < 1e-6, 'neighbouring fins are 90 degrees apart (' + spacing.toFixed(6) + ')');
      }
      await decalSteps(page, names, canvas);
      await pageSteps(page, names);

      await saveProjectCopy(page, join(outputDirectory, 'after-stage-4.dc6'));
    } else {
      console.log('starting from ' + from);
      await page.goto('http://localhost:4179/');
      await page.waitForFunction(function hasHook() {
        return window.dc6 !== undefined;
      });
      await openProjectFile(page, from);
    }
    await laterSteps(page, browser);

    const frameTimes = await page.evaluate(function times() {
      return window.dc6.frameTimes();
    });
    let total = 0;
    let longest = 0;
    for (let i = 0; i < frameTimes.length; i++) {
      total = total + frameTimes[i];
      longest = Math.max(longest, frameTimes[i]);
    }
    console.log('frame work (update + render, software GL): mean ' + (total / Math.max(1, frameTimes.length)).toFixed(1) + ' ms, worst ' + longest.toFixed(1) + ' ms over ' + String(frameTimes.length) + ' frames');
  } finally {
    await browser.close();
    await new Promise<void>(function close(resolve) {
      server.httpServer.close(function closed() {
        resolve();
      });
    });
  }
  console.log('whole run took ' + ((Date.now() - runStart) / 1000).toFixed(1) + ' s');
  if (failures.length > 0) {
    console.log(String(failures.length) + ' check(s) failed');
    process.exit(1);
  }
  console.log('all checks passed');
}

// ---------------------------------------------------------------------------
// Stage 2 and 3: decals on the rocket, and the cut file.

const artFolder = join(process.cwd(), 'test-models', 'art');

async function decalInfo(page: Page, id: string): Promise<DecalInfo> {
  const info = await page.evaluate(function read(decalId: string) {
    return window.dc6.decalInfo(decalId);
  }, id);
  if (info === null) {
    throw new Error('decal ' + id + ' is not drawn');
  }
  return info;
}

function decalNamed(doc: AssemblyDocument, name: string): AssemblyDocument['decals'][number] {
  for (let i = 0; i < doc.decals.length; i++) {
    if (doc.decals[i].name === name) {
      return doc.decals[i];
    }
  }
  throw new Error('no decal named ' + name);
}

async function handles(page: Page): Promise<Array<{ handle: string; x: number; y: number }>> {
  return page.evaluate(function read() {
    return window.dc6.decalHandles();
  });
}

async function typeInto(page: Page, selector: string, text: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) {
    throw new Error('no field ' + selector);
  }
  await click(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
}

async function pickArt(page: Page, name: string, at: { x: number; y: number }): Promise<void> {
  await clickSelector(page, '.art-item[data-artwork-name="' + name + '"]');
  await glide(page, at.x, at.y, 12);
  await click(page, at.x, at.y);
}

// The unwrapped roll angle covered by the centre row of a decal's grid.
async function rollSpan(page: Page, id: string): Promise<{ degrees: number; missing: number }> {
  const grid = await page.evaluate(function read(decalId: string) {
    return window.dc6.decalGrid(decalId);
  }, id);
  if (grid === null) {
    throw new Error('no grid for ' + id);
  }
  const row = (grid.rows - 1) / 2;
  let previous: number | null = null;
  let turned = 0;
  let missing = 0;
  for (let i = 0; i < grid.columns; i++) {
    const p = grid.points[row * grid.columns + i];
    if (p === null) {
      missing = missing + 1;
      continue;
    }
    const angle = Math.atan2(p[1], p[2]);
    if (previous !== null) {
      let step = angle - previous;
      if (step > Math.PI) {
        step = step - 2 * Math.PI;
      } else if (step < -Math.PI) {
        step = step + 2 * Math.PI;
      }
      turned = turned + step;
    }
    previous = angle;
  }
  return { degrees: (Math.abs(turned) * 180) / Math.PI, missing: missing };
}

function plainSvgProblems(svg: string): string[] {
  const problems: string[] = [];
  if (/transform=/.test(svg)) {
    problems.push('has a transform');
  }
  if (/style=|<style/.test(svg)) {
    problems.push('has CSS');
  }
  if (/<use|clip-path|clipPath/.test(svg)) {
    problems.push('has use or clip paths');
  }
  const size = /<svg[^>]* width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (size === null || size[1] !== size[3] || size[2] !== size[4]) {
    problems.push('size in mm does not match the viewBox');
  }
  const paths = svg.match(/<path [^>]*>/g) ?? [];
  if (paths.length === 0) {
    problems.push('no paths');
  }
  for (let i = 0; i < paths.length; i++) {
    const d = /d="([^"]*)"/.exec(paths[i]);
    if (d === null || !/^[MLCZ0-9 .\-]+$/.test(d[1]) || !d[1].trim().endsWith('Z')) {
      problems.push('path ' + String(i) + ' is not closed absolute data');
      break;
    }
    if (!/fill="none"/.test(paths[i])) {
      problems.push('path ' + String(i) + ' is filled');
      break;
    }
  }
  return problems;
}

async function decalSteps(page: Page, names: Record<string, string>, canvas: { x: number; y: number; width: number; height: number }): Promise<void> {
  let doc = await documentOf(page);
  const tube = one(doc, names, 'tube');
  const nose = one(doc, names, 'nose');
  const tubeFaces = await faces(page, tube.id);
  const tubeFore = faceFacing(tubeFaces, body.outerRadius, -1);
  const tubeAft = faceFacing(tubeFaces, body.outerRadius, 1);
  const tubeMiddleX = (tubeFore.centre[0] + tubeAft.centre[0]) / 2;
  await page.keyboard.press('Escape');
  await fitView(page);

  console.log('12. import artwork: two logos with paths, a band, and a file with live text');
  const input = page.locator('input[type=file]').first();
  await input.setInputFiles([join(artFolder, 'logo.svg'), join(artFolder, 'lettering.svg'), join(artFolder, 'stripe.svg')]);
  await page.waitForTimeout(400);
  check((await page.locator('.art-item').count()) === 3, 'three artworks in the list');
  check(!(await page.locator('.notice').isVisible()), 'clean files give no notice');
  await input.setInputFiles([join(artFolder, 'live-text.svg')]);
  await page.waitForTimeout(300);
  const noticeText = (await page.locator('.notice').textContent()) ?? '';
  check(/live text/.test(noticeText) && /paths/.test(noticeText), 'live text gives a notice naming the problem (' + noticeText.replace('×', '').trim() + ')');
  await shot(page, 'live-text-notice');
  await clickSelector(page, '.notice-close');
  check(!(await page.locator('.notice').isVisible()), 'the notice is dismissed');

  console.log('13. the tube in white (preview colour)');
  await clickSelector(page, '.tree-row[data-placed-id="' + tube.id + '"] .part-swatch');
  await clickSelector(page, '.popover .swatch[data-colour="#f2f2f2"]');
  doc = await documentOf(page);
  check(doc.partColours[tube.id] === '#f2f2f2', 'the tube is previewed white');

  console.log('14. drop the lettering on the side of the tube');
  const onTube = await screenOf(page, [tubeMiddleX - 40, 0, 0]);
  await clickSelector(page, '.art-item[data-artwork-name="lettering"]');
  await glide(page, onTube.x, onTube.y, 12);
  await shot(page, 'lettering-held');
  await click(page, onTube.x, onTube.y);
  doc = await documentOf(page);
  check(doc.decals.length === 1, 'one decal');
  let lettering = decalNamed(doc, 'lettering');
  check(lettering.anchor.placedId === tube.id, 'the lettering is on the tube');
  check(Math.abs(lettering.width - 60) < 1e-6 && Math.abs(lettering.height - 20) < 1e-3, 'at true size, 60 x 20 mm (' + lettering.width.toFixed(3) + ' x ' + lettering.height.toFixed(3) + ')');
  let info = await decalInfo(page, lettering.id);
  check(info.up[1] > 0.95 && info.right[0] > 0.99, 'artwork up is world up, artwork right is towards the tail');
  const topLeft = await screenOf(page, info.corners[0] as Vec3);
  const topRight = await screenOf(page, info.corners[1] as Vec3);
  const bottomLeft = await screenOf(page, info.corners[3] as Vec3);
  check(topLeft.y < bottomLeft.y - 10 && topLeft.x < topRight.x - 50, 'in the side view the lettering is upright and reads left to right');
  await shot(page, 'lettering-on-tube');

  console.log('15. drag it along and around the body; type an exact distance');
  const startCentre = info.centre;
  let at = await screenOf(page, info.centre);
  await glide(page, at.x, at.y, 3);
  await page.mouse.down();
  await glide(page, at.x + 90, at.y - 35, 16);
  await page.mouse.up();
  await page.waitForTimeout(150);
  info = await decalInfo(page, lettering.id);
  const alongValue = Number(await page.locator('.adjust input[data-field="along"]').first().inputValue());
  const aroundValue = Number(await page.locator('.adjust input[data-field="around"]').first().inputValue());
  check(alongValue > 20 && aroundValue > 5, 'the adjust panel shows along ' + alongValue + ' mm and around ' + aroundValue + ' mm');
  await typeInto(page, '.adjust input[data-field="along"]', '50');
  info = await decalInfo(page, lettering.id);
  check(Math.abs(info.centre[0] - startCentre[0] - 50) < 0.05, 'typing 50 moves it exactly 50 mm along (' + (info.centre[0] - startCentre[0]).toFixed(3) + ')');
  check(info.right[0] > 0.99, 'still square to the axis after moving round (right . axis = ' + info.right[0].toFixed(4) + ')');
  await shot(page, 'lettering-moved');

  console.log('16. drag it over the can and onto the nose, in small steps');
  at = await screenOf(page, info.centre);
  const noseFaces = await faces(page, nose.id);
  const noseBase = faceOfRadius(noseFaces, body.outerRadius);
  const target = await screenOf(page, [noseBase.centre[0] - 45, 0, 0]);
  await glide(page, at.x, at.y, 3);
  await page.mouse.down();
  const steps = Math.ceil(Math.hypot(target.x - at.x, target.y - at.y) / 6);
  let previous: DecalInfo | null = null;
  let worstJump = 0;
  let worstTurn = 0;
  let worstTurnAt: Vec3 = [0, 0, 0];
  let travelled = 0;
  const dragStart = Date.now();
  for (let k = 1; k <= steps; k++) {
    const x = at.x + ((target.x - at.x) * k) / steps;
    const y = at.y + ((target.y - at.y) * k) / steps;
    await page.mouse.move(x, y);
    await page.waitForTimeout(20);
    const now = await decalInfo(page, lettering.id);
    if (previous !== null) {
      const jump = distance(now.centre, previous.centre);
      travelled = travelled + jump;
      worstJump = Math.max(worstJump, jump);
      // Spin about the surface normal: the previous right, laid into the
      // current tangent plane, against the current right. (Tilting with the
      // surface, as over the kink where the waisted can meets the tube, is
      // not a spin.)
      const n = now.normal;
      const p = previous.right;
      const along = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
      const laid: Vec3 = [p[0] - along * n[0], p[1] - along * n[1], p[2] - along * n[2]];
      const laidLength = Math.hypot(laid[0], laid[1], laid[2]);
      const cosine = (laid[0] * now.right[0] + laid[1] * now.right[1] + laid[2] * now.right[2]) / laidLength;
      const turn = Math.acos(Math.min(1, cosine));
      if ((turn * 180) / Math.PI > worstTurn) {
        worstTurn = (turn * 180) / Math.PI;
        worstTurnAt = now.centre;
      }
    }
    previous = now;
    if (k === Math.round(steps * 0.55)) {
      await shot(page, 'lettering-crossing-the-can');
    }
  }
  const dragSeconds = (Date.now() - dragStart) / 1000;
  await page.mouse.up();
  await page.waitForTimeout(150);
  doc = await documentOf(page);
  lettering = decalNamed(doc, 'lettering');
  check(lettering.anchor.placedId === nose.id, 'the lettering is now on the nose');
  const meanStep = travelled / Math.max(1, steps - 1);
  check(worstJump < 3 * meanStep + 0.5, 'it slid without a jump: largest step ' + worstJump.toFixed(2) + ' mm, mean ' + meanStep.toFixed(2) + ' mm');
  check(worstTurn < 3, 'its frame never flipped or spun: largest turn about the normal per step ' + worstTurn.toFixed(2) + ' deg (at ' + worstTurnAt.map(function f(v) {
    return v.toFixed(1);
  }).join(', ') + ')');
  info = await decalInfo(page, lettering.id);
  check(info.up[1] > 0.7, 'upright on the nose (up . world up = ' + info.up[1].toFixed(3) + ')');
  await shot(page, 'lettering-on-nose');
  const mapTimes = await page.evaluate(function read() {
    return window.dc6.decalMapTimes();
  });
  let mapTotal = 0;
  let mapWorst = 0;
  for (let i = 0; i < mapTimes.length; i++) {
    mapTotal = mapTotal + mapTimes[i];
    mapWorst = Math.max(mapWorst, mapTimes[i]);
  }
  console.log('drag: ' + String(steps) + ' pointer moves in ' + dragSeconds.toFixed(1) + ' s with software GL; decal re-map mean ' + (mapTotal / Math.max(1, mapTimes.length)).toFixed(2) + ' ms, worst ' + mapWorst.toFixed(2) + ' ms over ' + String(mapTimes.length));

  console.log('17. turn it with the rotate handle (15 degree steps)');
  let list = await handles(page);
  const centreScreen = await screenOf(page, info.centre);
  const rotateHandle = list.filter(function isRotate(h) {
    return h.handle === 'rotate';
  })[0];
  check(rotateHandle !== undefined && list.length === 5, 'four corner handles and a rotate handle are shown');
  const startRotation = lettering.rotation;
  await glide(page, rotateHandle.x, rotateHandle.y, 3);
  await page.mouse.down();
  const radius = Math.hypot(rotateHandle.x - centreScreen.x, rotateHandle.y - centreScreen.y);
  const startAngle = Math.atan2(rotateHandle.y - centreScreen.y, rotateHandle.x - centreScreen.x);
  for (let k = 1; k <= 10; k++) {
    // Clockwise on screen by 32 degrees: snaps to 30.
    const a = startAngle + (((32 * Math.PI) / 180) * k) / 10;
    await page.mouse.move(centreScreen.x + radius * Math.cos(a), centreScreen.y + radius * Math.sin(a));
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
  doc = await documentOf(page);
  lettering = decalNamed(doc, 'lettering');
  // The angle snaps to 15 degree steps from upright (rotation 0), so
  // upright is always one snap away.
  const turnedDegrees = ((lettering.rotation - startRotation) * 180) / Math.PI;
  const absoluteDegrees = (lettering.rotation * 180) / Math.PI;
  const offStep = Math.abs(absoluteDegrees / 15 - Math.round(absoluteDegrees / 15)) * 15;
  check(offStep < 1e-6 && Math.abs(turnedDegrees) > 20, 'it turned ' + turnedDegrees.toFixed(2) + ' deg, to ' + absoluteDegrees.toFixed(4) + ' deg from upright, a 15 degree step');
  await shot(page, 'lettering-rotated');
  const shownAngle = Number(await page.locator('.adjust input[data-field="angle"]').first().inputValue());
  check(Math.abs(shownAngle - absoluteDegrees) < 0.05, 'the panel shows the angle from upright: ' + shownAngle);
  await typeInto(page, '.adjust input[data-field="angle"]', '0');
  doc = await documentOf(page);
  lettering = decalNamed(doc, 'lettering');
  info = await decalInfo(page, lettering.id);
  check(Math.abs(lettering.rotation) < 1e-9 && info.up[1] > 0.9, 'typing 0 stands it upright (up . world up = ' + info.up[1].toFixed(3) + ')');

  console.log('18. scale it with a corner handle, then type an exact width');
  list = await handles(page);
  const corner = list.filter(function isCorner(h) {
    return h.handle === 'scale';
  })[1];
  await glide(page, corner.x, corner.y, 3);
  await page.mouse.down();
  await glide(page, centreScreen.x + (corner.x - centreScreen.x) * 1.3, centreScreen.y + (corner.y - centreScreen.y) * 1.3, 10);
  await page.mouse.up();
  await page.waitForTimeout(150);
  doc = await documentOf(page);
  lettering = decalNamed(doc, 'lettering');
  check(lettering.width > 66 && Math.abs(lettering.width / lettering.height - 3) < 1e-3, 'the corner scales it uniformly (' + lettering.width.toFixed(1) + ' x ' + lettering.height.toFixed(1) + ' mm)');
  await typeInto(page, '.adjust input[data-field="width"]', '45');
  doc = await documentOf(page);
  lettering = decalNamed(doc, 'lettering');
  check(Math.abs(lettering.width - 45) < 1e-9 && Math.abs(lettering.height - 15) < 1e-3, 'typing 45 mm makes it 45 x ' + lettering.height.toFixed(4) + ' mm (height linked)');
  await shot(page, 'lettering-scaled');

  console.log('19. a logo on the tube, a band round the tube, a logo on a fin');
  await page.keyboard.press('Escape');
  // The logo straddles the joint between the tube and the waisted can, and
  // the band goes over it: layering and the part joint in one place.
  await pickArt(page, 'logo', await screenOf(page, [tubeFore.centre[0] + 6, 0, 0]));
  await pickArt(page, 'stripe', await screenOf(page, [tubeFore.centre[0] + 18, 0, 0]));
  doc = await documentOf(page);
  const stripe = decalNamed(doc, 'stripe');
  check(stripe.anchor.placedId === tube.id, 'the band is on the tube');
  // Turn it to run round the tube: drag the rotate handle a little, then type 90.
  list = await handles(page);
  const bandRotate = list.filter(function isRotate(h) {
    return h.handle === 'rotate';
  })[0];
  if (bandRotate === undefined) {
    throw new Error('no rotate handle on the band');
  }
  await glide(page, bandRotate.x, bandRotate.y, 3);
  await page.mouse.down();
  await glide(page, bandRotate.x + 60, bandRotate.y + 10, 6);
  await page.mouse.up();
  await page.waitForTimeout(100);
  await typeInto(page, '.adjust input[data-field="angle"]', '90');
  const span = await rollSpan(page, stripe.id);
  check(span.degrees > 360 && span.missing === 0, 'the 300 mm band wraps more than once round the 207 mm tube: ' + span.degrees.toFixed(1) + ' degrees');
  await shot(page, 'band-wrapped');
  const fins = placedOfPart(doc, names, 'fin');
  let frontFin = fins[0];
  for (let i = 0; i < fins.length; i++) {
    const root = (await faces(page, fins[i].id))[fins[i].joint === null ? 0 : fins[i].joint!.ownFace];
    if (root.centre[1] > 1 && root.centre[2] > 1) {
      frontFin = fins[i];
    }
  }
  const finFaces = await faces(page, frontFin.id);
  let side = finFaces[0];
  let best = -Infinity;
  const towardsCamera: Vec3 = [0, Math.sin((12 * Math.PI) / 180), Math.cos((12 * Math.PI) / 180)];
  for (let i = 0; i < finFaces.length; i++) {
    const facing = finFaces[i].normal[0] * towardsCamera[0] + finFaces[i].normal[1] * towardsCamera[1] + finFaces[i].normal[2] * towardsCamera[2];
    if (finFaces[i].radius === null && facing > best) {
      best = facing;
      side = finFaces[i];
    }
  }
  await pickArt(page, 'logo', await screenOf(page, side.centre));
  doc = await documentOf(page);
  const finLogo = doc.decals[doc.decals.length - 1];
  check(finLogo.anchor.placedId === frontFin.id, 'the second logo is on a fin');
  info = await decalInfo(page, finLogo.id);
  check(info.up[1] > 0.5 && info.right[0] > 0.99, 'on the fin it is upright seen from outside (up . world up = ' + info.up[1].toFixed(3) + ')');
  await shot(page, 'logo-on-fin');

  console.log('20. colours: the lettering in cerise');
  lettering = decalNamed(doc, 'lettering');
  await clickSelector(page, '.layer-row[data-decal-id="' + lettering.id + '"] .swatch');
  await clickSelector(page, '.popover .swatch[data-colour="#e64097"]');
  doc = await documentOf(page);
  check(decalNamed(doc, 'lettering').colourMap['#000000'] === '#e64097', 'the lettering is cut in cerise');

  console.log('21. flip, duplicate, delete');
  await clickSelector(page, '.layer-row[data-decal-id="' + lettering.id + '"] .tree-name');
  await glide(page, canvas.x + canvas.width / 2, canvas.y + canvas.height - 30, 3);
  await page.keyboard.press('h');
  doc = await documentOf(page);
  check(decalNamed(doc, 'lettering').flipX, 'H flips it');
  await page.keyboard.press('h');
  await page.keyboard.press('Control+d');
  const copyAt = await screenOf(page, [tubeMiddleX + 30, 0, 0]);
  await glide(page, copyAt.x, copyAt.y, 8);
  await click(page, copyAt.x, copyAt.y);
  doc = await documentOf(page);
  check(doc.decals.length === 5 && doc.decals[doc.decals.length - 1].name === 'lettering copy', 'Ctrl+D makes a copy that follows the cursor and drops');
  await glide(page, canvas.x + canvas.width / 2, canvas.y + canvas.height - 30, 3);
  await page.keyboard.press('Delete');
  doc = await documentOf(page);
  check(doc.decals.length === 4, 'Delete removes the selected copy');

  console.log('22. layers: reorder, hide, lock, rename');
  const rows = page.locator('.layer-row');
  check((await rows.count()) === 4, 'four layer rows');
  // The lettering is the bottom layer (first placed): drag its row to the top.
  const bottomRow = await page.locator('.layer-row[data-decal-id="' + lettering.id + '"] .tree-name').boundingBox();
  const topRow = await page.locator('.layer-row').first().boundingBox();
  if (bottomRow === null || topRow === null) {
    throw new Error('no layer rows');
  }
  await glide(page, bottomRow.x + 20, bottomRow.y + bottomRow.height / 2, 2);
  await page.mouse.down();
  await glide(page, topRow.x + 20, topRow.y + 2, 8);
  await page.mouse.up();
  await page.waitForTimeout(150);
  doc = await documentOf(page);
  check(doc.decals[doc.decals.length - 1].id === lettering.id, 'the lettering is now the top layer');
  await clickSelector(page, '.layer-row[data-decal-id="' + stripe.id + '"] .eye');
  const tubeLogo = decalNamed(doc, 'logo');
  await clickSelector(page, '.layer-row[data-decal-id="' + tubeLogo.id + '"] .lock');
  doc = await documentOf(page);
  check(decalNamed(doc, 'stripe').hidden && decalNamed(doc, 'logo').locked, 'the band is hidden and the tube logo locked');
  await page.keyboard.press('Escape');
  const lockedInfo = await decalInfo(page, tubeLogo.id);
  const lockedAt = await screenOf(page, lockedInfo.centre);
  await click(page, lockedAt.x, lockedAt.y);
  const selectedNow = await page.evaluate(function read() {
    return window.dc6.selectedDecal();
  });
  check(selectedNow !== tubeLogo.id, 'a locked decal cannot be picked in the view');
  await page.keyboard.press('Escape');
  const finName = await page.locator('.layer-row[data-decal-id="' + finLogo.id + '"] .tree-name').boundingBox();
  if (finName === null) {
    throw new Error('no fin logo row');
  }
  await glide(page, finName.x + 10, finName.y + finName.height / 2, 2);
  await page.mouse.dblclick(finName.x + 10, finName.y + finName.height / 2);
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('fin logo', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  doc = await documentOf(page);
  check(doc.decals.some(function named(d) {
    return d.name === 'fin logo';
  }), 'the fin logo is renamed by double-click');
  await shot(page, 'layers');

  console.log('23. undo and redo decal edits');
  await glide(page, canvas.x + canvas.width / 2, canvas.y + canvas.height - 30, 3);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(80);
  doc = await documentOf(page);
  check(!doc.decals.some(function named(d) {
    return d.name === 'fin logo';
  }), 'undo takes the rename back');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(80);
  doc = await documentOf(page);
  check(!decalNamed(doc, 'logo').locked, 'undo again unlocks the logo');
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(80);
  doc = await documentOf(page);
  check(decalNamed(doc, 'logo').locked && decalNamed(doc, 'fin logo').id === finLogo.id, 'redo puts both back');

  console.log('24. export the cut file');
  await clickSelector(page, 'button[data-control="export"]');
  await shot(page, 'export-dialog');
  await clickSelector(page, 'button[data-option="files:layers"]');
  const downloadWaiting = page.waitForEvent('download');
  await clickSelector(page, 'button[data-action="export"]');
  const download = await downloadWaiting;
  const file = readFileSync(await download.path(), 'utf8');
  check(download.suggestedFilename() === 'dc6-cut.svg', 'one file with a layer per colour: ' + download.suggestedFilename());
  const problems = plainSvgProblems(file);
  check(problems.length === 0, 'the cut file is plain SVG in mm' + (problems.length > 0 ? ': ' + problems.join(', ') : ''));
  check(/<text[^>]*>lettering<\/text>/.test(file) && /<text[^>]*>fin logo<\/text>/.test(file) && !/>stripe</.test(file), 'every shown decal is labelled; the hidden band is left out');
  check(/<g id="cerise" inkscape:groupmode="layer"/.test(file) && /<g id="black" inkscape:groupmode="layer"/.test(file), 'a layer per vinyl colour');
  // The lettering piece (45 x 15 mm) at 1:1: its paths span 45 mm.
  const letteringPaths: string[] = [];
  const pathPattern = /<path d="([^"]*)"/g;
  let match = pathPattern.exec(file);
  while (match !== null) {
    letteringPaths.push(match[1]);
    match = pathPattern.exec(file);
  }
  check(letteringPaths.length === 2 + 2 + 4, 'eight outlines: two logos of two shapes, four letter shapes (' + String(letteringPaths.length) + ')');
  console.log('  cut file: ' + String(file.length) + ' bytes, first line of the svg: ' + (file.split('\n')[1] ?? '').slice(0, 150));
  await clickSelector(page, 'button[data-control="export"]');
  await clickSelector(page, 'button[data-option="files:per-colour"]');
  const first = page.waitForEvent('download');
  await clickSelector(page, 'button[data-action="export"]');
  const cerise = await first;
  const second = page.waitForEvent('download');
  const black = await second;
  check(cerise.suggestedFilename() === 'dc6-cut-cerise.svg' && black.suggestedFilename() === 'dc6-cut-black.svg', 'a file per colour: ' + cerise.suggestedFilename() + ', ' + black.suggestedFilename());
  check(plainSvgProblems(readFileSync(await black.path(), 'utf8')).length === 0, 'the per-colour files are plain too');

  console.log('25. the finished livery');
  await page.keyboard.press('Escape');
  await fitView(page);
  await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 3);
  await page.waitForTimeout(150);
  await shot(page, 'livery-side');
  await clickSelector(page, '.layer-row[data-decal-id="' + stripe.id + '"] .eye');
  await clickSelector(page, 'button[data-view="top"]');
  await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 3);
  await page.waitForTimeout(150);
  await shot(page, 'livery-top');
  await fitView(page);
  const jointClose = await screenOf(page, [tubeFore.centre[0] - 10, 0, 0]);
  await glide(page, jointClose.x, jointClose.y, 3);
  for (let k = 0; k < 14; k++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(60);
  }
  await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 3);
  await page.waitForTimeout(150);
  await shot(page, 'livery-joint-close');
  await fitView(page);
  const orbitFrom = { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.9 };
  await glide(page, orbitFrom.x, orbitFrom.y, 2);
  await page.mouse.down();
  await glide(page, orbitFrom.x + 200, orbitFrom.y - 70, 10);
  await page.mouse.up();
  await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 3);
  await page.waitForTimeout(150);
  await shot(page, 'livery-orbit');

  console.log('26. place on face: the lettering centred on a fin side');
  await fitView(page);
  await clickSelector(page, '.layer-row[data-decal-id="' + lettering.id + '"] .tree-name');
  await clickSelector(page, 'button[data-tool="face"]');
  const finSide = await screenOf(page, side.centre);
  await click(page, finSide.x, finSide.y);
  doc = await documentOf(page);
  lettering = decalNamed(doc, 'lettering');
  check(lettering.anchor.placedId === frontFin.id && distance(lettering.anchor.position, side.centre) < 0.5, 'the lettering is centred on the fin face (' + distance(lettering.anchor.position, side.centre).toFixed(3) + ' mm off)');
  info = await decalInfo(page, lettering.id);
  check(info.up[1] > 0.5 && info.right[0] > 0.99, 'and stands upright there');
  await clickSelector(page, 'button[data-tool="place"]');
  await glide(page, canvas.x + 5, canvas.y + canvas.height - 5, 3);
  await shot(page, 'lettering-placed-on-fin-face');
}

// ---------------------------------------------------------------------------
// Stage 4: the flat page, linked to 3D.

async function pageInfo(page: Page): Promise<PageInfo> {
  const info = await page.evaluate(function read() {
    return window.dc6.page();
  });
  if (info === null) {
    throw new Error('no page');
  }
  return info;
}

async function pageWorldAt(page: Page, x: number, y: number): Promise<Vec3 | null> {
  return page.evaluate(function read(p: { x: number; y: number }) {
    return window.dc6.pageWorldAt(p.x, p.y);
  }, { x: x, y: y });
}

async function pageImagesOf(page: Page, placedId: string, world: Vec3): Promise<Array<{ x: number; y: number; chart: number }>> {
  return page.evaluate(function read(a: { id: string; world: Vec3 }) {
    return window.dc6.pageImagesOf(a.id, a.world);
  }, { id: placedId, world: world });
}

async function pageCentres(page: Page, id: string): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(function read(decalId: string) {
    return window.dc6.pageDecalCentres(decalId);
  }, id);
}

function rollOf(p: Vec3): number {
  return Math.atan2(p[1], p[2]);
}

// Drag with the mouse in small steps, as a hand would.
async function dragFrom(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps: number): Promise<void> {
  await glide(page, from.x, from.y, 3);
  await page.mouse.down();
  await glide(page, to.x, to.y, steps);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function pageSteps(page: Page, names: Record<string, string>): Promise<void> {
  let doc = await documentOf(page);
  const tube = one(doc, names, 'tube');
  const sled = one(doc, names, 'sled');

  console.log('27. the flat page: the strip and the fin islands');
  // The sled was put back floating above the rocket by the redo in step 9:
  // hide it again, as the rocket would be built.
  if (!sled.hidden) {
    await clickSelector(page, '.tree-row[data-placed-id="' + sled.id + '"] .eye');
  }
  await page.keyboard.press('Escape');
  await fitView(page);
  await clickSelector(page, 'button[data-control="page-fit"]');
  await page.waitForTimeout(300);
  let info = await pageInfo(page);
  const finIslands = info.islands.filter(function onFin(i) {
    return names[(doc.placed.find((p) => p.id === i.placedId) as PlacedPart).partId] === 'fin';
  });
  check(info.stripTriangles > 1000 && Math.abs(info.stripLength - 493.8) < 2, 'the page has one body strip, ' + info.stripLength.toFixed(1) + ' mm from nose tip to tail (' + String(info.stripTriangles) + ' triangles)');
  check(finIslands.length === 8 && info.islands.length === 8, 'eight fin side islands and nothing else (' + info.islands.map((i) => i.label).join(', ') + ')');
  console.log('  page built in ' + info.buildMilliseconds.toFixed(0) + ' ms in the browser');
  await glide(page, info.canvas.left + 5, info.canvas.top + info.canvas.height - 5, 2);
  await shot(page, 'page');

  console.log('28. hover: a point on the page is marked in 3D, a point in 3D on the page');
  const onStrip = { x: info.originX + 260 * info.zoom, y: info.originY - 10 * info.zoom };
  await glide(page, onStrip.x, onStrip.y, 6);
  const underPage = await pageWorldAt(page, onStrip.x, onStrip.y);
  const marker = await page.evaluate(function read() {
    return window.dc6.linkedPoint3d();
  });
  check(underPage !== null && marker !== null && distance(underPage, marker) < 0.01, 'hovering the strip puts the 3D marker on the same surface point (' + JSON.stringify(underPage) + ' / ' + JSON.stringify(marker) + ')');
  await shot(page, 'hover-page');
  const tubeFaces = await faces(page, tube.id);
  const tubeAft = faceFacing(tubeFaces, body.outerRadius, 1);
  const spot3d: Vec3 = [tubeAft.centre[0] - 150, body.outerRadius * Math.sin(0.3), body.outerRadius * Math.cos(0.3)];
  const spotScreen = await screenOf(page, spot3d);
  await glide(page, spotScreen.x, spotScreen.y, 8);
  await page.waitForTimeout(100);
  const shownOnPage = await page.evaluate(function read() {
    return window.dc6.hoverPoint3d();
  });
  const spotImages = await pageImagesOf(page, tube.id, spot3d);
  check(shownOnPage && spotImages.length === 1, 'hovering the tube in 3D marks the point on the page (at ' + spotImages.map((p) => p.x.toFixed(0) + ',' + p.y.toFixed(0)).join(' ') + ')');
  await shot(page, 'hover-3d');

  console.log('29. drop a decal from the bin onto the strip');
  info = await pageInfo(page);
  const dropAt = { x: info.originX + 230 * info.zoom, y: info.originY - 5 * info.zoom };
  await clickSelector(page, '.art-item[data-artwork-name="logo"]');
  await glide(page, dropAt.x, dropAt.y, 14);
  await click(page, dropAt.x, dropAt.y);
  doc = await documentOf(page);
  const pageLogo = doc.decals[doc.decals.length - 1];
  const dropWorld = await pageWorldAt(page, dropAt.x, dropAt.y);
  check(pageLogo.anchor.placedId === tube.id && dropWorld !== null && distance(pageLogo.anchor.position, dropWorld) < 0.01, 'clicked on the page, the logo is stuck to the tube at that point');

  console.log('30. drag it on the page: the 3D decal moves to the matching place');
  let centres = await pageCentres(page, pageLogo.id);
  const target = { x: centres[0].x + 40, y: centres[0].y + 25 };
  await dragFrom(page, centres[0], target, 14);
  const targetWorld = await pageWorldAt(page, target.x, target.y);
  let logoInfo = await decalInfo(page, pageLogo.id);
  check(targetWorld !== null && distance(logoInfo.centre, targetWorld) < 0.6, 'the 3D decal centre is where the page shows it (' + (targetWorld === null ? 'none' : distance(logoInfo.centre, targetWorld).toFixed(3)) + ' mm off)');
  const moveAlong = Number(await page.locator('.adjust input[data-field="along"]').first().inputValue());
  check(moveAlong > 5, 'the adjust panel offers the page move as a decal move (along ' + moveAlong + ' mm)');
  await shot(page, 'page-drag');

  console.log('31. drag it in 3D: the page follows');
  const before3d = await screenOf(page, logoInfo.centre);
  await dragFrom(page, before3d, { x: before3d.x - 60, y: before3d.y + 10 }, 12);
  logoInfo = await decalInfo(page, pageLogo.id);
  const expected = await pageImagesOf(page, tube.id, logoInfo.centre);
  centres = await pageCentres(page, pageLogo.id);
  check(expected.length > 0 && centres.length > 0 && Math.hypot(centres[0].x - expected[0].x, centres[0].y - expected[0].y) < 1.5, 'the page shows the decal at its new 3D place');

  console.log('32. rotate and scale it with the page handles');
  // Click it on the page to select it there.
  await click(page, centres[0].x, centres[0].y);
  let pageHandleList = await page.evaluate(function read() {
    return window.dc6.pageHandles();
  });
  const rotateHandle = pageHandleList.filter((h) => h.handle === 'rotate')[0];
  check(rotateHandle !== undefined && pageHandleList.length === 5, 'the page shows four corner handles and a rotate handle (' + pageHandleList.map((h) => h.handle).join(', ') + ')');
  doc = await documentOf(page);
  const before = doc.decals.find((d) => d.id === pageLogo.id) as AssemblyDocument['decals'][number];
  const centre = centres[0];
  const radius = Math.hypot(rotateHandle.x - centre.x, rotateHandle.y - centre.y);
  const startAngle = Math.atan2(rotateHandle.y - centre.y, rotateHandle.x - centre.x);
  await glide(page, rotateHandle.x, rotateHandle.y, 3);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    const a = startAngle - ((47 * Math.PI) / 180) * (k / 10);
    await page.mouse.move(centre.x + radius * Math.cos(a), centre.y + radius * Math.sin(a));
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
  doc = await documentOf(page);
  let after = doc.decals.find((d) => d.id === pageLogo.id) as AssemblyDocument['decals'][number];
  const turned = ((after.rotation - before.rotation) * 180) / Math.PI;
  check(Math.abs(turned - 45) < 1e-6, 'turning the page handle 47 degrees anticlockwise turns it 45 (snapped): ' + turned.toFixed(3));
  pageHandleList = await page.evaluate(function read() {
    return window.dc6.pageHandles();
  });
  const corner = pageHandleList.filter((h) => h.handle === 'scale')[0];
  await dragFrom(page, corner, { x: centre.x + (corner.x - centre.x) * 1.5, y: centre.y + (corner.y - centre.y) * 1.5 }, 10);
  doc = await documentOf(page);
  after = doc.decals.find((d) => d.id === pageLogo.id) as AssemblyDocument['decals'][number];
  const grew = after.width / before.width;
  check(grew > 1.35 && grew < 1.65 && Math.abs(after.width / after.height - before.width / before.height) < 1e-6, 'the page corner scales it uniformly by ' + grew.toFixed(3));
  await shot(page, 'page-handles');

  console.log('33. drag it across the seam on the page');
  centres = await pageCentres(page, pageLogo.id);
  let edges = await page.evaluate(function read() {
    return window.dc6.pageStripEdges(240);
  });
  if (edges === null) {
    throw new Error('no strip edges');
  }
  const pastSeam = { x: centres[0].x, y: edges.top - 4 };
  await dragFrom(page, centres[0], pastSeam, 20);
  logoInfo = await decalInfo(page, pageLogo.id);
  centres = await pageCentres(page, pageLogo.id);
  const roll = (rollOf(logoInfo.centre) * 180) / Math.PI;
  // Past the top edge the page shows the surface just round the seam, at
  // roll angles from -180 degrees on.
  check(roll < -150 && centres.length >= 2, 'dragged past the strip edge it went round the back (roll ' + roll.toFixed(1) + ' deg) and shows on both sides of the seam (' + String(centres.length) + ' drawings)');
  await shot(page, 'page-across-seam');

  console.log('34. pan the page down to bring the seam to the middle: the strip repeats');
  info = await pageInfo(page);
  const emptyLeft = { x: info.originX - 60, y: info.canvas.top + info.canvas.height / 2 };
  const middleY = info.canvas.top + 20 + (info.canvas.height - 20) / 2;
  const drawsBefore = (await page.evaluate(function read() {
    return window.dc6.pageDrawTimes();
  })).length;
  await dragFrom(page, emptyLeft, { x: emptyLeft.x, y: emptyLeft.y + (middleY - edges.top) }, 12);
  const panDraws = await page.evaluate(function read() {
    return window.dc6.pageDrawTimes();
  });
  const duringPan = panDraws.slice(drawsBefore);
  let panTotal = 0;
  for (let i = 0; i < duringPan.length; i++) {
    panTotal = panTotal + duringPan[i];
  }
  console.log('  page redraw while panning: mean ' + (panTotal / Math.max(1, duringPan.length)).toFixed(1) + ' ms over ' + String(duringPan.length) + ' draws');
  edges = await page.evaluate(function read() {
    return window.dc6.pageStripEdges(240);
  });
  info = await pageInfo(page);
  if (edges === null) {
    throw new Error('no strip edges');
  }
  const seamX = info.originX + 240 * info.zoom;
  const belowSeam = await pageWorldAt(page, seamX, edges.top + 6);
  const aboveSeam = await pageWorldAt(page, seamX, edges.top - 6);
  check(Math.abs(edges.top - middleY) < 3, 'the seam is in the middle of the page (' + edges.top.toFixed(1) + ' / ' + middleY.toFixed(1) + ')');
  check(belowSeam !== null && aboveSeam !== null && Math.abs(rollOf(belowSeam)) > 2.5 && Math.abs(rollOf(aboveSeam)) > 2.5 && rollOf(belowSeam) * rollOf(aboveSeam) < 0, 'above the seam the strip goes on round the back: roll ' + (belowSeam === null ? '-' : ((rollOf(belowSeam) * 180) / Math.PI).toFixed(1)) + ' deg below it, ' + (aboveSeam === null ? '-' : ((rollOf(aboveSeam) * 180) / Math.PI).toFixed(1)) + ' deg above');
  await glide(page, info.canvas.left + 5, info.canvas.top + info.canvas.height - 5, 2);
  await shot(page, 'page-seam-middle');

  console.log('35. roll the rocket by dragging the strip: the 3D view turns with it');
  await clickSelector(page, 'button[data-control="page-fit"]');
  info = await pageInfo(page);
  const grab = { x: info.originX + 300 * info.zoom, y: info.originY - 20 * info.zoom };
  const pull = 40;
  await dragFrom(page, grab, { x: grab.x, y: grab.y + pull }, 10);
  const rolled = await page.evaluate(function read() {
    return window.dc6.viewRoll();
  });
  const expectedRoll = pull / info.zoom / body.outerRadius;
  check(Math.abs(rolled - expectedRoll) < 0.03, 'dragging the strip down ' + String(pull) + ' px rolls the view ' + ((rolled * 180) / Math.PI).toFixed(1) + ' deg (expected ' + ((expectedRoll * 180) / Math.PI).toFixed(1) + ')');
  await glide(page, info.canvas.left + 5, info.canvas.top + info.canvas.height - 5, 2);
  await shot(page, 'page-rolled');
  await clickSelector(page, 'button[data-view="side"]');
  const back = await page.evaluate(function read() {
    return window.dc6.viewRoll();
  });
  check(back === 0, 'the Side view puts the roll back to 0');

  console.log('36. drop a decal from the bin onto a fin island');
  await clickSelector(page, 'button[data-control="page-fit"]');
  info = await pageInfo(page);
  const island = info.islands[0];
  const islandMiddle = { x: (island.left + island.right) / 2, y: (island.top + island.bottom) / 2 };
  let finPoint = await pageWorldAt(page, islandMiddle.x, islandMiddle.y);
  // The bounding box's middle may be off a swept fin: step towards the root.
  for (let k = 1; k < 10 && finPoint === null; k++) {
    islandMiddle.x = islandMiddle.x - 3;
    finPoint = await pageWorldAt(page, islandMiddle.x, islandMiddle.y);
  }
  await clickSelector(page, '.art-item[data-artwork-name="lettering"]');
  await glide(page, islandMiddle.x, islandMiddle.y, 14);
  await click(page, islandMiddle.x, islandMiddle.y);
  doc = await documentOf(page);
  const onFin = doc.decals[doc.decals.length - 1];
  check(onFin.anchor.placedId === island.placedId && finPoint !== null && distance(onFin.anchor.position, finPoint) < 0.01, 'the lettering is stuck to ' + island.label + ' where it was clicked');
  const finCentres = await pageCentres(page, onFin.id);
  check(finCentres.length === 1 && Math.abs(finCentres[0].x - islandMiddle.x) < 1.5 && Math.abs(finCentres[0].y - islandMiddle.y) < 1.5, 'it is drawn on the island where it was dropped');
  const finHandles = await page.evaluate(function read() {
    return window.dc6.pageHandles();
  });
  const finRotate = finHandles.filter((h) => h.handle === 'rotate')[0];
  check(finRotate !== undefined && finCentres.length === 1 && finRotate.y < finCentres[0].y - 10 && Math.abs(finRotate.x - finCentres[0].x) < 2, 'put on from the page it stands upright on the page (its rotate handle straight above it)');
  await shot(page, 'page-fin-decal');

  console.log('37. a file dropped on the page goes where it is dropped');
  const svgText = readFileSync(join(artFolder, 'logo.svg'), 'utf8');
  // Whole pixels: a synthetic drag event's position is.
  const fileDrop = { x: Math.round(info.originX + 120 * info.zoom), y: Math.round(info.originY + 8 * info.zoom) };
  const decalCount = doc.decals.length;
  await page.evaluate(function dropFile(a: { text: string; x: number; y: number }) {
    const transfer = new DataTransfer();
    transfer.items.add(new File([a.text], 'dropped.svg', { type: 'image/svg+xml' }));
    const target = document.elementFromPoint(a.x, a.y) as HTMLElement;
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: a.x, clientY: a.y, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: a.x, clientY: a.y, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: a.x, clientY: a.y, dataTransfer: transfer }));
  }, { text: svgText, x: fileDrop.x, y: fileDrop.y });
  await page.waitForTimeout(400);
  doc = await documentOf(page);
  const fileWorld = await pageWorldAt(page, fileDrop.x, fileDrop.y);
  const dropped = doc.decals[doc.decals.length - 1];
  check(doc.decals.length === decalCount + 1 && fileWorld !== null && distance(dropped.anchor.position, fileWorld) < 0.01, '(' + String(doc.decals.length - decalCount) + ' new, ' + JSON.stringify(fileWorld) + ' / ' + JSON.stringify(dropped.anchor.position) + ') the dropped SVG is stuck to the rocket at the drop point (the drop event is synthetic: a file cannot be dragged in with the mouse)');

  console.log('38. undo and redo from the page');
  await glide(page, info.canvas.left + 5, info.canvas.top + info.canvas.height - 5, 2);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  doc = await documentOf(page);
  check(doc.decals.length === decalCount - 1 && (await pageCentres(page, onFin.id)).length === 0, 'two undos take the dropped file and the fin lettering away, on the page too');
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(150);
  doc = await documentOf(page);
  check(doc.decals.length === decalCount && (await pageCentres(page, onFin.id)).length === 1, 'redo puts the fin lettering back on the page');

  console.log('39. the divider: drag, reset, put the page away and back');
  const divider = await page.locator('.divider').first().boundingBox();
  if (divider === null) {
    throw new Error('no divider');
  }
  const dividerMiddle = { x: 700, y: divider.y + divider.height / 2 };
  await dragFrom(page, dividerMiddle, { x: 700, y: dividerMiddle.y - 120 }, 8);
  let canvasBox = await page.locator('.page-pane canvas').first().boundingBox();
  check(canvasBox !== null && Math.abs(canvasBox.y - (divider.y - 120 + divider.height)) < 1.5, 'dragging the divider up 120 px gives the page 120 px more');
  await shot(page, 'divider-up');
  const moved = await page.locator('.divider').first().boundingBox();
  if (moved === null) {
    throw new Error('no divider');
  }
  await page.mouse.dblclick(700, moved.y + moved.height / 2);
  await page.waitForTimeout(150);
  canvasBox = await page.locator('.page-pane canvas').first().boundingBox();
  check(canvasBox !== null && Math.abs(canvasBox.y - (divider.y + divider.height)) < 3, 'double-clicking the divider puts it back');
  await dragFrom(page, dividerMiddle, { x: 700, y: 798 }, 8);
  check(!(await page.locator('.page-pane').first().isVisible()), 'dragging the divider to the bottom puts the page away');
  const collapsed = await page.locator('.divider').first().boundingBox();
  if (collapsed === null) {
    throw new Error('no divider');
  }
  await dragFrom(page, { x: 700, y: collapsed.y + 3 }, { x: 700, y: 400 }, 8);
  check(await page.locator('.page-pane').first().isVisible(), 'and dragging it up brings the page back');

  console.log('40. the finished page');
  await page.mouse.dblclick(700, 403);
  await clickSelector(page, 'button[data-view="side"]');
  await clickSelector(page, 'button[data-view="fit"]');
  await clickSelector(page, 'button[data-control="page-fit"]');
  await page.keyboard.press('Escape');
  await glide(page, 5, 795, 2);
  await page.waitForTimeout(300);
  await shot(page, 'page-final');
  // Closer: the can (window, holes, joints) with the logos, then the fins.
  let finalInfo = await pageInfo(page);
  const canPoint = { x: finalInfo.originX + 150 * finalInfo.zoom, y: finalInfo.originY - 0 * finalInfo.zoom };
  await glide(page, canPoint.x, canPoint.y, 4);
  for (let k = 0; k < 6; k++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  await glide(page, 5, 795, 2);
  await page.waitForTimeout(200);
  await shot(page, 'page-zoomed-strip');
  await clickSelector(page, 'button[data-control="page-fit"]');
  finalInfo = await pageInfo(page);
  const finPoint2 = { x: finalInfo.originX + 360 * finalInfo.zoom, y: finalInfo.originY - 200 * finalInfo.zoom };
  await glide(page, finPoint2.x, finPoint2.y, 4);
  for (let k = 0; k < 4; k++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  await glide(page, 5, 795, 2);
  await page.waitForTimeout(200);
  await shot(page, 'page-zoomed-fins');
  await clickSelector(page, 'button[data-control="page-fit"]');
  finalInfo = await pageInfo(page);
  const tipPoint = { x: finalInfo.originX + 2, y: finalInfo.originY };
  await glide(page, tipPoint.x, tipPoint.y, 4);
  for (let k = 0; k < 8; k++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  await glide(page, 5, 795, 2);
  await page.waitForTimeout(200);
  await shot(page, 'page-zoomed-nose');
  await clickSelector(page, 'button[data-control="page-fit"]');
  const drawTimes = await page.evaluate(function read() {
    return window.dc6.pageDrawTimes();
  });
  let total = 0;
  let worst = 0;
  for (let i = 0; i < drawTimes.length; i++) {
    total = total + drawTimes[i];
    worst = Math.max(worst, drawTimes[i]);
  }
  console.log('page draws over the whole run (including re-cutting the strip while rolling and re-drawing dragged decals): mean ' + (total / Math.max(1, drawTimes.length)).toFixed(1) + ' ms, worst ' + worst.toFixed(1) + ' ms over ' + String(drawTimes.length) + ' draws (' + String(doc.decals.length) + ' decals)');
}

// ---------------------------------------------------------------------------
// Stages 5 to 7 and the loose ends: decal symmetry, the project file,
// autosave, replacing a part, the placement sheet and the other exports.

async function chooseFile(page: Page, selector: string, file: string): Promise<void> {
  const waiting = page.waitForEvent('filechooser');
  await clickSelector(page, selector);
  const chooser = await waiting;
  await chooser.setFiles(file);
}

async function downloadFrom(page: Page, selector: string): Promise<{ name: string; path: string }> {
  const waiting = page.waitForEvent('download');
  await clickSelector(page, selector);
  const download = await waiting;
  return { name: download.suggestedFilename(), path: await download.path() };
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(function wait() {
    return window.dc6.loaded();
  });
  await page.evaluate(function wait() {
    return window.dc6.pageSettled();
  });
  await page.waitForTimeout(200);
}

// Ctrl+S, and keep the file the browser was handed.
async function saveProjectCopy(page: Page, target: string): Promise<string> {
  await glide(page, 700, 60, 2);
  const waiting = page.waitForEvent('download');
  await page.keyboard.press('Control+s');
  const download = await waiting;
  copyFileSync(await download.path(), target);
  console.log('  project saved as ' + download.suggestedFilename() + ' (' + String(statSync(target).size) + ' bytes), kept at ' + target);
  return download.suggestedFilename();
}

// Ctrl+O and pick the file.
async function openProjectFile(page: Page, file: string): Promise<void> {
  // A browser opens a file picker only for a page the user has touched.
  await click(page, 700, 790);
  const waiting = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  const chooser = await waiting;
  await chooser.setFiles(file);
  await page.waitForTimeout(200);
  await page.evaluate(function wait() {
    return window.dc6.opened();
  });
  await settle(page);
}

function decalById(doc: AssemblyDocument, id: string): AssemblyDocument['decals'][number] {
  const decal = doc.decals.find(function byId(d) {
    return d.id === id;
  });
  if (decal === undefined) {
    throw new Error('no decal ' + id);
  }
  return decal;
}

async function groupOf(page: Page, id: string): Promise<string[]> {
  return page.evaluate(function read(decalId: string) {
    return window.dc6.decalGroup(decalId);
  }, id);
}

// The cut file with a layer per colour, layered, as text.
async function cutFileText(page: Page): Promise<string> {
  await clickSelector(page, 'button[data-control="export"]');
  await clickSelector(page, 'button[data-option="files:layers"]');
  await clickSelector(page, 'button[data-option="overlaps:layered"]');
  const file = await downloadFrom(page, 'button[data-action="export"]');
  return readFileSync(file.path, 'utf8');
}

// Quaternion helpers for the rotate check: the turn from a to b.
function relativeTurn(a: [number, number, number, number], b: [number, number, number, number]): { axis: Vec3; degrees: number } {
  // b * conj(a)
  const ax = -a[0];
  const ay = -a[1];
  const az = -a[2];
  const aw = a[3];
  const x = b[3] * ax + b[0] * aw + b[1] * az - b[2] * ay;
  const y = b[3] * ay - b[0] * az + b[1] * aw + b[2] * ax;
  const z = b[3] * az + b[0] * ay - b[1] * ax + b[2] * aw;
  const w = b[3] * aw - b[0] * ax - b[1] * ay - b[2] * az;
  const sine = Math.hypot(x, y, z);
  const degrees = (2 * Math.atan2(sine, Math.abs(w)) * 180) / Math.PI;
  if (sine < 1e-12) {
    return { axis: [0, 0, 0], degrees: 0 };
  }
  return { axis: [x / sine, y / sine, z / sine], degrees: degrees };
}

async function longTasks(page: Page): Promise<number[]> {
  return page.evaluate(function read() {
    return (window as unknown as { longTasks: number[] }).longTasks.slice();
  });
}

async function clearLongTasks(page: Page): Promise<void> {
  await page.evaluate(function clear() {
    (window as unknown as { longTasks: number[] }).longTasks.length = 0;
  });
}

function pngSize(bytes: Buffer): { width: number; height: number; colourType: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25] };
}

async function laterSteps(page: Page, browser: Browser): Promise<void> {
  const names = await page.evaluate(function read() {
    return window.dc6.partNames();
  });
  let doc = await documentOf(page);
  const canvasBox = await page.locator('canvas').first().boundingBox();
  if (canvasBox === null) {
    throw new Error('no canvas');
  }
  const canvas = canvasBox;
  const tube = one(doc, names, 'tube');
  const nose = one(doc, names, 'nose');
  const tubeFaces = await faces(page, tube.id);
  const tubeFore = faceFacing(tubeFaces, body.outerRadius, -1);
  await page.keyboard.press('Escape');
  await fitView(page);
  const away = { x: canvas.x + 5, y: canvas.y + canvas.height - 5 };

  console.log('41. rotate the nose with the gizmo, then change the axis it turned about (adjust panel)');
  await clickSelector(page, '.tree-row[data-placed-id="' + nose.id + '"] .tree-name');
  await page.keyboard.press('3');
  await page.waitForTimeout(150);
  const pivot = await page.evaluate(function read() {
    return window.dc6.gizmoPivot();
  });
  const pivotScreen = await screenOf(page, pivot);
  let ring: { x: number; y: number } | null = null;
  for (let d = 20; d < 260 && ring === null; d = d + 3) {
    await glide(page, pivotScreen.x, pivotScreen.y - d, 1);
    const hovered = await page.evaluate(function read() {
      return window.dc6.gizmoHovered();
    });
    if (hovered) {
      ring = { x: pivotScreen.x, y: pivotScreen.y - d };
    }
  }
  if (ring === null) {
    throw new Error('could not find a rotate ring');
  }
  const noseBefore = requirePlacedIn(doc, nose.id).transform;
  await page.mouse.down();
  await glide(page, ring.x + 70, ring.y + 15, 10);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const activeAxis = await page.locator('.adjust .segmented button.active').first().textContent();
  const wanted = activeAxis === 'Up' ? 'side' : 'up';
  await settle(page);
  await clearLongTasks(page);
  const changeStart = Date.now();
  await clickSelector(page, '.adjust .segmented button[data-axis="' + wanted + '"]');
  await settle(page);
  const changeTasks = await longTasks(page);
  let changeLongest = 0;
  for (let i = 0; i < changeTasks.length; i++) {
    changeLongest = Math.max(changeLongest, changeTasks[i]);
  }
  const rebuilt = await pageInfo(page);
  console.log('  a part moved: the new page arrived ' + String(Date.now() - changeStart) + ' ms after the click (built in ' + rebuilt.buildMilliseconds.toFixed(0) + ' ms in the worker); main thread meanwhile: ' + String(changeTasks.length) + ' long tasks, longest ' + changeLongest.toFixed(0) + ' ms');
  // (With software GL the redraw and the compositor's commit after it still
  // take a few hundred ms here; the build itself no longer blocks.)
  check(changeLongest < rebuilt.buildMilliseconds, 'the page is built off the main thread: the longest main-thread task (' + changeLongest.toFixed(0) + ' ms) is shorter than the build (' + rebuilt.buildMilliseconds.toFixed(0) + ' ms)');
  doc = await documentOf(page);
  let turn = relativeTurn(noseBefore.rotation, requirePlacedIn(doc, nose.id).transform.rotation);
  const expectedAxis: Vec3 = wanted === 'up' ? [0, 1, 0] : [0, 0, 1];
  check(turn.degrees > 1 && Math.abs(Math.abs(turn.axis[0] * expectedAxis[0] + turn.axis[1] * expectedAxis[1] + turn.axis[2] * expectedAxis[2]) - 1) < 1e-6, 'the adjust panel turned the rotation (' + turn.degrees.toFixed(1) + ' deg, first about ' + String(activeAxis) + ') to be about ' + wanted);
  await shot(page, 'rotate-axis-changed');
  await clickSelector(page, '.adjust .segmented button[data-axis="along"]');
  doc = await documentOf(page);
  turn = relativeTurn(noseBefore.rotation, requirePlacedIn(doc, nose.id).transform.rotation);
  check(Math.abs(Math.abs(turn.axis[0]) - 1) < 1e-6, 'and then about the rocket axis (axis ' + turn.axis.map((v) => v.toFixed(3)).join(', ') + ')');
  await glide(page, away.x, away.y, 2);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  doc = await documentOf(page);
  check(relativeTurn(noseBefore.rotation, requirePlacedIn(doc, nose.id).transform.rotation).degrees < 1e-6, 'one undo puts the nose back as it was');
  await page.keyboard.press('1');
  await page.keyboard.press('Escape');

  console.log('42. replace the artwork of a decal with an edited SVG');
  let finLogo = decalNamed(doc, 'fin logo');
  await chooseFile(page, '.layer-row[data-decal-id="' + finLogo.id + '"] [data-action="replace"]', join(artFolder, 'lettering.svg'));
  await page.waitForTimeout(300);
  doc = await documentOf(page);
  let replaced = decalById(doc, finLogo.id);
  check(replaced.artworkId !== finLogo.artworkId && replaced.anchor.triangle === finLogo.anchor.triangle && Math.abs(replaced.rotation - finLogo.rotation) < 1e-9, 'the fin logo shows the new artwork at the same place and angle');
  // The lettering artwork is 60 x 20 mm, the logo 40 x 40: the same mm on the rocket per mm of artwork.
  check(Math.abs(replaced.width / 60 - finLogo.width / 40) < 1e-3 && Math.abs(replaced.height / 20 - finLogo.height / 40) < 1e-3, 'at the same scale (' + finLogo.width.toFixed(1) + ' mm logo -> ' + replaced.width.toFixed(1) + ' x ' + replaced.height.toFixed(1) + ' mm lettering)');
  await glide(page, away.x, away.y, 2);
  await page.keyboard.press('Control+z');
  doc = await documentOf(page);
  check(decalById(doc, finLogo.id).artworkId === finLogo.artworkId, 'undo puts the old artwork back');

  console.log('43. the cut file with overlaps knocked out');
  const layered = await cutFileText(page);
  await clickSelector(page, 'button[data-control="export"]');
  await clickSelector(page, 'button[data-option="overlaps:knockout"]');
  const knockedFile = await downloadFrom(page, 'button[data-action="export"]');
  const knocked = readFileSync(knockedFile.path, 'utf8');
  const knockedProblems = plainSvgProblems(knocked);
  check(knockedProblems.length === 0 && knocked !== layered, 'the knocked-out cut file is plain SVG too, and differs from the layered one' + (knockedProblems.length > 0 ? ': ' + knockedProblems.join(', ') : ''));
  const longestPolygon = function longest(svg: string): number {
    let most = 0;
    const found = svg.match(/<path d="[^"]*"/g) ?? [];
    for (let i = 0; i < found.length; i++) {
      most = Math.max(most, (found[i].match(/L/g) ?? []).length);
    }
    return most;
  };
  check(longestPolygon(knocked) > 40 && longestPolygon(layered) < 40, 'knocked out, the lower colour is cut round the higher one (a cut polygon of ' + String(longestPolygon(knocked)) + ' points; layered, at most ' + String(longestPolygon(layered)) + ')');
  await clickSelector(page, 'button[data-control="export"]');
  await clickSelector(page, 'button[data-option="overlaps:layered"]');
  await page.keyboard.press('Escape');

  console.log('44. decal symmetry: a logo x4 round the tube');
  await fitView(page);
  const logoSpot = await screenOf(page, [tubeFore.centre[0] + 75, 0, body.outerRadius]);
  await pickArt(page, 'logo', logoSpot);
  doc = await documentOf(page);
  const ringLogo = doc.decals[doc.decals.length - 1];
  // Click the x1 and type the count.
  await clickSelector(page, 'button[data-control="symmetry"]');
  await page.keyboard.type('4', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  let members = await groupOf(page, ringLogo.id);
  doc = await documentOf(page);
  const ringRolls: number[] = [];
  for (let i = 0; i < members.length; i++) {
    const member = decalById(doc, members[i]);
    ringRolls.push((rollOf(member.anchor.position) * 180) / Math.PI);
  }
  ringRolls.sort(function ascending(a, b) {
    return a - b;
  });
  let even = members.length === 4;
  for (let i = 1; i < ringRolls.length; i++) {
    even = even && Math.abs(ringRolls[i] - ringRolls[i - 1] - 90) < 0.5;
  }
  check(even, 'clicking x1 and typing 4 makes four linked copies 90 degrees apart (' + ringRolls.map((r) => r.toFixed(1)).join(', ') + ')');
  check((await page.locator('button[data-control="symmetry"]').first().textContent()) === '×4', 'the toolbar shows x4 for the selected decal');
  const ringRow = page.locator('.layer-row[data-count="4"]');
  check((await ringRow.count()) === 1 && /×4/.test((await ringRow.first().textContent()) ?? ''), 'the layer list shows the set as one row with a x4 badge');
  await glide(page, away.x, away.y, 2);
  await shot(page, 'decal-x4-3d-side');
  // On the page: each copy drawn in its own place at its own size.
  await clickSelector(page, 'button[data-control="page-fit"]');
  await settle(page);
  await glide(page, away.x, away.y, 2);
  let copiesOk = true;
  let copyReport = '';
  for (let i = 0; i < members.length; i++) {
    const shapes = await page.evaluate(function read(id: string) {
      return window.dc6.pageDecalShape(id);
    }, members[i]);
    const main = shapes.filter((c) => c.copy === 0)[0];
    let longestEdge = 0;
    for (let k = 0; k < shapes.length; k++) {
      longestEdge = Math.max(longestEdge, shapes[k].longestEdge);
    }
    copiesOk = copiesOk && main !== undefined && Math.abs(main.area - 1600) < 30 && longestEdge < 3;
    copyReport = copyReport + (main === undefined ? ' none' : ' ' + main.area.toFixed(0) + ' mm² / ' + longestEdge.toFixed(2) + ' mm');
  }
  check(copiesOk, 'on the page each copy covers its own 40 x 40 mm and no triangle of it is longer than a grid cell or two (' + copyReport.trim() + ')');
  // Pixels: between the copy facing the viewer (roll 0) and the one on top
  // (roll 90) the page shows the white tube, not cerise.
  const ringDoc = await documentOf(page);
  let low: { x: number; y: number } | null = null;
  let high: { x: number; y: number } | null = null;
  for (let i = 0; i < members.length; i++) {
    const roll = (rollOf(decalById(ringDoc, members[i]).anchor.position) * 180) / Math.PI;
    const centres = await pageCentres(page, members[i]);
    if (Math.abs(roll) < 5 && centres.length > 0) {
      low = centres[0];
    }
    if (Math.abs(roll - 90) < 5 && centres.length > 0) {
      high = centres[0];
    }
  }
  if (low === null || high === null) {
    throw new Error('copies at roll 0 and 90 not found on the page');
  }
  // (No selection: its handles would sit in that gap.)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const samples = await page.evaluate(function pixels(a: { low: { x: number; y: number }; high: { x: number; y: number } }) {
    const canvas = document.querySelector('.page-pane canvas') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const ratio = canvas.width / rect.width;
    function at(x: number, y: number): number[] {
      const data = context.getImageData(Math.round((x - rect.left) * ratio), Math.round((y - rect.top) * ratio), 1, 1).data;
      return [data[0], data[1], data[2]];
    }
    const row: number[][] = [];
    const y = (a.low.y + a.high.y) / 2;
    for (let dx = -12; dx <= 12; dx = dx + 3) {
      row.push(at(a.low.x + dx, y));
    }
    return { gap: row, centre: at(a.low.x - 6, a.low.y + 3) };
  }, { low: low, high: high });
  let tubeColoured = true;
  for (let i = 0; i < samples.gap.length; i++) {
    const p = samples.gap[i];
    tubeColoured = tubeColoured && p[0] > 200 && p[1] > 200 && p[2] > 200;
  }
  const centreIsCerise = samples.centre[0] > 180 && samples.centre[1] < 120;
  check(tubeColoured && centreIsCerise, 'a row of page pixels between two copies is the white tube, and the copy itself is cerise (gap ' + JSON.stringify(samples.gap[4]) + ', copy ' + JSON.stringify(samples.centre) + ')');
  await shot(page, 'decal-x4-page-fit');
  await clickSelector(page, '.layer-row[data-count="4"] .tree-name');
  await glide(page, low.x, (low.y + high.y) / 2, 4);
  for (let k = 0; k < 5; k++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  await glide(page, away.x, away.y, 2);
  await page.waitForTimeout(200);
  await shot(page, 'decal-x4-page-zoomed');
  await clickSelector(page, 'button[data-control="page-fit"]');
  // Any count up to 12 can be typed: on the layer row's badge too.
  await clickSelector(page, '.layer-row[data-count="4"] .badge');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('12', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check((await groupOf(page, ringLogo.id)).length === 12, 'typing 12 on the x4 badge makes twelve copies');
  await glide(page, away.x, away.y, 2);
  await page.keyboard.press('Control+z');
  members = await groupOf(page, ringLogo.id);
  check(members.length === 4, 'undo: four again');
  // A three-quarter view, to see the copies round the back.
  const orbitFrom = { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.85 };
  await glide(page, orbitFrom.x, orbitFrom.y, 2);
  await page.mouse.down();
  await glide(page, orbitFrom.x + 150, orbitFrom.y - 60, 10);
  await page.mouse.up();
  await glide(page, away.x, away.y, 2);
  await page.waitForTimeout(150);
  await shot(page, 'decal-x4-3d-orbit');
  await fitView(page);
  // Edit one copy (drag the one in front): all four move.
  const before = await documentOf(page);
  let frontInfo = await decalInfo(page, ringLogo.id);
  let frontScreen = await screenOf(page, frontInfo.centre);
  await dragFrom(page, frontScreen, { x: frontScreen.x + 50, y: frontScreen.y }, 10);
  doc = await documentOf(page);
  let moves: number[] = [];
  for (let i = 0; i < members.length; i++) {
    moves.push(decalById(doc, members[i]).anchor.position[0] - decalById(before, members[i]).anchor.position[0]);
  }
  check(moves[0] > 5 && Math.max(...moves) - Math.min(...moves) < 0.5, 'dragging one copy moves all four along the rocket by the same (' + moves.map((m) => m.toFixed(2)).join(', ') + ' mm)');
  await clickSelector(page, '.layer-row[data-count="4"] .swatch');
  await clickSelector(page, '.popover .swatch[data-colour="#000000"]');
  doc = await documentOf(page);
  const firstMap = JSON.stringify(decalById(doc, members[0]).colourMap);
  let sameColours = firstMap !== '{}';
  for (let i = 1; i < members.length; i++) {
    sameColours = sameColours && JSON.stringify(decalById(doc, members[i]).colourMap) === firstMap;
  }
  check(sameColours, 'a new vinyl colour on the row recolours all four (' + firstMap + ')');
  await glide(page, away.x, away.y, 2);
  await page.keyboard.press('Control+z');
  doc = await documentOf(page);
  check(JSON.stringify(decalById(doc, members[2]).colourMap) === '{}', 'undo takes the colour off all four');
  await page.keyboard.press('Shift+X');
  members = await groupOf(page, ringLogo.id);
  check(members.length === 3, 'Shift+X makes it x3 (' + String(members.length) + ' copies)');
  await page.keyboard.press('x');
  members = await groupOf(page, ringLogo.id);
  check(members.length === 4, 'and X back to x4');
  const selectedNow = await page.evaluate(function read() {
    return window.dc6.selectedDecal();
  });
  await clickSelector(page, 'button[data-control="decal-unique"]');
  doc = await documentOf(page);
  const loner = selectedNow === null ? null : decalById(doc, selectedNow);
  check(loner !== null && loner.symmetry === null && (await groupOf(page, members[1])).length === 3, 'make unique takes the selected copy out; the other three stay linked');
  await glide(page, away.x, away.y, 2);
  await page.keyboard.press('Control+z');
  members = await groupOf(page, ringLogo.id);
  check(members.length === 4, 'undo links it again');

  console.log('45. mirror: lettering on the upper side, mirrored to the far side');
  const mirrorAt: Vec3 = [tubeFore.centre[0] + 135, body.outerRadius * Math.sin(0.6), body.outerRadius * Math.cos(0.6)];
  await pickArt(page, 'lettering', await screenOf(page, mirrorAt));
  doc = await documentOf(page);
  const mirrorSource = doc.decals[doc.decals.length - 1];
  await glide(page, away.x, away.y, 2);
  await page.keyboard.press('m');
  const pair = await groupOf(page, mirrorSource.id);
  doc = await documentOf(page);
  const image = decalById(doc, pair.filter((id) => id !== mirrorSource.id)[0]);
  const source = decalById(doc, mirrorSource.id);
  const reflected: Vec3 = [source.anchor.position[0], source.anchor.position[1], -source.anchor.position[2]];
  check(pair.length === 2 && distance(image.anchor.position, reflected) < 0.2, 'M puts a copy at the mirror image place (z to -z), ' + distance(image.anchor.position, reflected).toFixed(3) + ' mm off');
  const imageInfo = await decalInfo(page, image.id);
  check(!image.flipX && imageInfo.right[0] < -0.9 && imageInfo.up[1] > 0.5, 'the copy is not flipped: the lettering reads the right way round from that side');
  await clickSelector(page, 'button[data-view="top"]');
  await glide(page, away.x, away.y, 2);
  await page.waitForTimeout(150);
  await shot(page, 'decal-mirror-top');
  await clickSelector(page, 'button[data-control="decal-flip-mirror"]');
  doc = await documentOf(page);
  check(decalById(doc, image.id).flipX && !decalById(doc, mirrorSource.id).flipX, 'Flip image flips the artwork on the mirror copy only (a true mirror image)');
  await glide(page, away.x, away.y, 2);
  await page.waitForTimeout(150);
  await shot(page, 'decal-mirror-flipped-top');
  await fitView(page);

  console.log('46. on every fin: the fin logo on the same side of each fin');
  finLogo = decalNamed(doc, 'fin logo');
  await clickSelector(page, '.layer-row[data-decal-id="' + finLogo.id + '"] .tree-name');
  check(await page.locator('button[data-control="decal-every-fin"]').first().isVisible(), 'on a fin of a x4 set the toolbar offers Every fin');
  await clickSelector(page, 'button[data-control="decal-every-fin"]');
  const finSet = await groupOf(page, finLogo.id);
  doc = await documentOf(page);
  const finsUsed = new Set<string>();
  let sameTriangle = true;
  for (let i = 0; i < finSet.length; i++) {
    const member = decalById(doc, finSet[i]);
    finsUsed.add(member.anchor.placedId);
    sameTriangle = sameTriangle && member.anchor.triangle === finLogo.anchor.triangle;
  }
  check(finSet.length === 4 && finsUsed.size === 4 && sameTriangle, 'four copies, one on each fin, at the same place on the same side (same mesh triangle)');
  await clickSelector(page, 'button[data-control="page-fit"]');
  await settle(page);
  await glide(page, away.x, away.y, 2);
  await shot(page, 'page-symmetry');

  console.log('47. from the page: drag one fin copy, the other three follow');
  let finCentres = await pageCentres(page, finSet[1]);
  if (finCentres.length === 0) {
    throw new Error('the fin copy is not on the page');
  }
  const beforeFinDrag = await documentOf(page);
  await dragFrom(page, finCentres[0], { x: finCentres[0].x + 25, y: finCentres[0].y + 6 }, 10);
  doc = await documentOf(page);
  const triangles = new Set<number>();
  let allMoved = true;
  for (let i = 0; i < finSet.length; i++) {
    triangles.add(decalById(doc, finSet[i]).anchor.triangle);
    allMoved = allMoved && distance(decalById(doc, finSet[i]).anchor.position, decalById(beforeFinDrag, finSet[i]).anchor.position) > 2;
  }
  check(allMoved && triangles.size === 1, 'all four fin copies moved, and are still at the same place on each fin');
  // The count from the page too: a tube copy picked there, Shift+X.
  const ringCentres = await pageCentres(page, members[2]);
  if (ringCentres.length > 0) {
    await click(page, ringCentres[0].x, ringCentres[0].y);
  }
  await page.keyboard.press('Shift+X');
  check((await groupOf(page, members[2])).length === 3, 'Shift+X with a tube copy picked on the page makes x3');
  await page.keyboard.press('Control+z');
  check((await groupOf(page, members[2])).length === 4, 'undo brings back the four');

  console.log('48. drag a 150 mm decal: time per step');
  await fitView(page);
  await page.keyboard.press('Escape');
  await pickArt(page, 'stripe', await screenOf(page, [tubeFore.centre[0] + 100, 0, body.outerRadius]));
  doc = await documentOf(page);
  const big = doc.decals[doc.decals.length - 1];
  let handleList = await handles(page);
  const bigCorner = handleList.filter((h) => h.handle === 'scale')[0];
  const bigInfo = await decalInfo(page, big.id);
  const bigCentre = await screenOf(page, bigInfo.centre);
  await dragFrom(page, bigCorner, { x: bigCentre.x + (bigCorner.x - bigCentre.x) * 0.7, y: bigCentre.y + (bigCorner.y - bigCentre.y) * 0.7 }, 6);
  await typeInto(page, '.adjust input[data-field="width"]', '150');
  doc = await documentOf(page);
  const bigNow = decalById(doc, big.id);
  check(Math.abs(bigNow.width - 150) < 0.01, 'the band is 150 mm long (' + bigNow.width.toFixed(1) + ' x ' + bigNow.height.toFixed(1) + ' mm)');
  const dragTimesBefore = (await page.evaluate(function read() {
    return window.dc6.decalDragTimes();
  })).length;
  const drawsBefore = (await page.evaluate(function read() {
    return window.dc6.pageDrawTimes();
  })).length;
  const bigScreen = await screenOf(page, (await decalInfo(page, big.id)).centre);
  const dragStart = Date.now();
  await glide(page, bigScreen.x, bigScreen.y, 2);
  await page.mouse.down();
  for (let k = 1; k <= 24; k++) {
    await page.mouse.move(bigScreen.x + k * 3, bigScreen.y + Math.sin(k / 4) * 10);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const dragWall = Date.now() - dragStart;
  await page.waitForTimeout(200);
  const stepTimes = (await page.evaluate(function read() {
    return window.dc6.decalDragTimes();
  })).slice(dragTimesBefore);
  const pageDraws = (await page.evaluate(function read() {
    return window.dc6.pageDrawTimes();
  })).slice(drawsBefore);
  let stepTotal = 0;
  let stepWorst = 0;
  for (let i = 0; i < stepTimes.length; i++) {
    stepTotal = stepTotal + stepTimes[i];
    stepWorst = Math.max(stepWorst, stepTimes[i]);
  }
  let drawTotal = 0;
  for (let i = 0; i < pageDraws.length; i++) {
    drawTotal = drawTotal + pageDraws[i];
  }
  console.log('  150 mm decal drag: ' + String(stepTimes.length) + ' steps, mean ' + (stepTotal / Math.max(1, stepTimes.length)).toFixed(1) + ' ms, worst ' + stepWorst.toFixed(1) + ' ms per step (find place, re-map, 3D scene); page redraw mean ' + (drawTotal / Math.max(1, pageDraws.length)).toFixed(1) + ' ms over ' + String(pageDraws.length) + ' draws; ' + String(dragWall) + ' ms wall for 24 moves');
  await glide(page, away.x, away.y, 2);
  await page.keyboard.press('Delete');

  console.log('49. exports: the dialog, the placement sheet, a picture, the page, the model');
  await clickSelector(page, 'button[data-control="export"]');
  await glide(page, away.x, away.y, 2);
  await shot(page, 'export-dialog-full');
  const sheetFile = await downloadFrom(page, 'button[data-action="sheet-svg"]');
  const sheet = readFileSync(sheetFile.path, 'utf8');
  check(sheetFile.name === 'dc6-placement-A4.svg' && /<svg[^>]* width="297mm" height="210mm" viewBox="0 0 297 210"/.test(sheet), 'the placement sheet is an A4 landscape SVG');
  const scaleMatch = /Scale 1:([\d.]+)/.exec(sheet);
  check(scaleMatch !== null && /From aft end/.test(sheet), 'it states its scale (1:' + (scaleMatch === null ? '?' : scaleMatch[1]) + ') and the datum');
  const numberTags = sheet.match(/<circle /g) ?? [];
  check(numberTags.length >= 10 && />×4</.test(sheet), 'every decal is numbered on the drawing (' + String(numberTags.length) + ' tags) and the table gives quantities');
  const sheetPage = await browser.newPage({ viewport: { width: 1123, height: 794 }, deviceScaleFactor: 2 });
  await sheetPage.setContent('<html><body style="margin:0;background:#fff">' + sheet.replace('width="297mm" height="210mm"', 'width="1123" height="794"') + '</body></html>');
  await sheetPage.waitForTimeout(300);
  stepNumber = stepNumber + 1;
  const sheetImage = join(outputDirectory, String(stepNumber).padStart(2, '0') + '-placement-sheet.png');
  await sheetPage.screenshot({ path: sheetImage });
  console.log('  screenshot ' + sheetImage + ' (the placement sheet rendered)');
  await sheetPage.close();
  // Print: the sheet in a window of its own that prints itself.
  await clickSelector(page, 'button[data-control="export"]');
  const popupWaiting = page.waitForEvent('popup');
  await clickSelector(page, 'button[data-action="sheet-print"]');
  const popup = await popupWaiting;
  await popup.waitForLoadState('load');
  const printed = await popup.content();
  check(/<svg/.test(printed) && /window\.print/.test(printed) && /size: A4 landscape/.test(printed), 'Print opens the sheet in a page sized for A4 landscape that calls print');
  await popup.close();
  // The 3D view as PNG at twice its size, then with a transparent background.
  await clickSelector(page, 'button[data-control="export"]');
  let pngFile = await downloadFrom(page, 'button[data-action="view-png"]');
  let png = readFileSync(pngFile.path);
  let size = pngSize(png);
  const viewBox = await page.locator('.viewport canvas').first().boundingBox();
  check(pngFile.name === 'dc6-view.png' && viewBox !== null && size.width === Math.round(viewBox.width * 2) && size.height === Math.round(viewBox.height * 2), 'the view as PNG at 2x: ' + String(size.width) + ' x ' + String(size.height) + ' px');
  await clickSelector(page, 'button[data-control="export"]');
  await clickSelector(page, 'button[data-option="transparent"]');
  pngFile = await downloadFrom(page, 'button[data-action="view-png"]');
  png = readFileSync(pngFile.path);
  size = pngSize(png);
  const corner = await page.evaluate(async function cornerAlpha(base64: string) {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const context = c.getContext('2d') as CanvasRenderingContext2D;
    context.drawImage(image, 0, 0);
    const cornerPixel = context.getImageData(2, 2, 1, 1).data;
    const middle = context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    return [cornerPixel[3], middle[3]];
  }, png.toString('base64'));
  check(size.colourType === 6 && corner[0] === 0 && corner[1] > 200, 'with Transparent the background is see-through (corner alpha ' + String(corner[0]) + ', rocket alpha ' + String(corner[1]) + ')');
  await clickSelector(page, 'button[data-control="export"]');
  await clickSelector(page, 'button[data-option="transparent"]');
  await page.keyboard.press('Escape');
  // The page as SVG, 1:1.
  await clickSelector(page, 'button[data-control="export"]');
  const pageFile = await downloadFrom(page, 'button[data-action="page-svg"]');
  const pageText = readFileSync(pageFile.path, 'utf8');
  const pageSize = /<svg[^>]* width="([\d.]+)mm" height="([\d.]+)mm" viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(pageText);
  doc = await documentOf(page);
  const shownDecals = doc.decals.filter((d) => !d.hidden).length;
  const groups = pageText.match(/<g id="d\d+">/g) ?? [];
  check(pageSize !== null && pageSize[1] === pageSize[3] && Number(pageSize[1]) > 500 && groups.length === shownDecals, 'the page as SVG: ' + (pageSize === null ? '?' : pageSize[1] + ' x ' + pageSize[2]) + ' mm at 1:1, a group of outlines per decal (' + String(groups.length) + ' of ' + String(shownDecals) + ')');
  // The model with the livery.
  await clickSelector(page, 'button[data-control="export"]');
  const modelFile = await downloadFrom(page, 'button[data-action="model-glb"]');
  const model = readFileSync(modelFile.path);
  const jsonLength = model.readUInt32LE(12);
  const gltf = JSON.parse(model.subarray(20, 20 + jsonLength).toString('utf8'));
  const decalMeshes = (gltf.nodes as Array<{ name?: string }>).filter((n) => /^decal/.test(n.name ?? '')).length;
  check(model.subarray(0, 4).toString('ascii') === 'glTF' && model.readUInt32LE(4) === 2 && decalMeshes > 0 && (gltf.images ?? []).length > 0, 'the model is binary glTF 2 with ' + String((gltf.nodes as unknown[]).length) + ' nodes (' + String(decalMeshes) + ' decal meshes) and ' + String((gltf.images ?? []).length) + ' textures, ' + String(model.length) + ' bytes');

  console.log('50. save the project (Ctrl+S)');
  await page.keyboard.press('Escape');
  const savedDoc = await documentOf(page);
  const savedCut = await cutFileText(page);
  const projectPath = join(outputDirectory, 'saved.dc6');
  const savedName = await saveProjectCopy(page, projectPath);
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  check(/\.dc6$/.test(savedName) && project.format === 'dc6-project' && project.version === 1 && project.files.length >= 6 && project.files.every((f: { hash: string; encoding: string }) => /^sha256:[0-9a-f]{64}$/.test(f.hash) && f.encoding === 'gzip-base64'), 'one .dc6 file, version 1, with ' + String(project.files.length) + ' STEP files embedded (gzip), each with its SHA-256, and ' + String(project.artworks.length) + ' artworks as SVG text');

  console.log('51. New clears everything (it asks first, there is work)');
  await clickSelector(page, 'button[data-control="new"]');
  check((await page.locator('button[data-control="new"]').first().textContent()) === 'Discard all?', 'the first click asks');
  await clickSelector(page, 'button[data-control="new"]');
  await page.waitForTimeout(300);
  doc = await documentOf(page);
  check(doc.placed.length === 0 && doc.decals.length === 0 && (await page.locator('.empty').first().isVisible()), 'the second clears it: the empty window again');

  console.log('52. open the project (Ctrl+O): the same document, the same cut file');
  await openProjectFile(page, projectPath);
  doc = await documentOf(page);
  check(JSON.stringify(doc) === JSON.stringify(savedDoc), 'the document is identical');
  check((await cutFileText(page)) === savedCut, 'the cut file is identical');
  await page.keyboard.press('Escape');
  await glide(page, away.x, away.y, 2);
  await shot(page, 'project-opened');

  console.log('53. a .dc6 file dropped on the window opens too');
  await clickSelector(page, 'button[data-control="new"]');
  await clickSelector(page, 'button[data-control="new"]');
  const projectText = readFileSync(projectPath, 'utf8');
  await page.evaluate(function dropFile(text: string) {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], 'saved.dc6', { type: 'application/json' }));
    const target = document.elementFromPoint(700, 300) as HTMLElement;
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, projectText);
  await page.waitForTimeout(500);
  await page.evaluate(function wait() {
    return window.dc6.opened();
  });
  await settle(page);
  doc = await documentOf(page);
  check(JSON.stringify(doc) === JSON.stringify(savedDoc), 'dropped, it opens the same document (synthetic drop event, as in step 37)');

  console.log('54. autosave: reload the window, the work is simply back');
  await page.evaluate(function flush() {
    return window.dc6.flushAutosave();
  });
  check((await page.evaluate(function read() {
    return window.dc6.autosaves();
  })) > 0, 'an autosave was written');
  await page.goto('http://localhost:4179/');
  await page.waitForFunction(function hasHook() {
    return window.dc6 !== undefined;
  });
  await settle(page);
  doc = await documentOf(page);
  check(JSON.stringify(doc) === JSON.stringify(savedDoc), 'after a reload the document is restored from browser storage, no questions asked');
  await page.waitForTimeout(300);
  await glide(page, away.x, away.y, 2);
  await shot(page, 'autosave-restored');
  // Restored work is not in a saved file: Open asks before it replaces it.
  await clickSelector(page, 'button[data-control="open"]');
  check((await page.locator('button[data-control="open"]').first().textContent()) === 'Discard all?', 'with unsaved work, Open asks first ("Discard all?")');
  await page.waitForTimeout(4300);
  check((await page.locator('button[data-control="open"]').first().textContent()) === 'Open', 'and lets it go after a few seconds');

  console.log('55. replace the tube with a revised file 10 mm longer');
  const tubeDecals = doc.decals.filter((d) => d.anchor.placedId === tube.id);
  const stripBefore = (await pageInfo(page)).stripLength;
  const beforeReplace = await documentOf(page);
  await clearLongTasks(page);
  await chooseFile(page, '.tree-row[data-placed-id="' + tube.id + '"] [data-action="replace-part"]', join(process.cwd(), 'test-models', 'tube-long.step'));
  await page.waitForTimeout(300);
  await settle(page);
  const tasks = await longTasks(page);
  doc = await documentOf(page);
  const newTube = requirePlacedIn(doc, tube.id);
  const toast = (await page.locator('.toast').first().textContent()) ?? '';
  check(newTube.partId !== tube.partId && JSON.stringify(newTube.transform) === JSON.stringify(requirePlacedIn(savedDoc, tube.id).transform), 'the tube takes the new file and keeps its place (' + newTube.partId + ')');
  let kept = true;
  let worstMove = 0;
  for (let i = 0; i < tubeDecals.length; i++) {
    const after = decalById(doc, tubeDecals[i].id);
    kept = kept && after.anchor.placedId === tube.id;
    worstMove = Math.max(worstMove, distance(after.anchor.position, tubeDecals[i].anchor.position));
  }
  check(kept && worstMove < 2 && /stayed in place/.test(toast), 'its ' + String(tubeDecals.length) + ' decals stay on it (moved at most ' + worstMove.toFixed(3) + ' mm), and it says so: "' + toast + '"');
  const stripAfter = (await pageInfo(page)).stripLength;
  // The tube was turned end for end in step 3, so the 10 mm are added at
  // its aft end: the boattail on that end moves 10 mm aft with it; the can
  // and nose on the other end stay put.
  const shiftOf = function shiftOf(name: string): number {
    const a = one(beforeReplace, names, name).transform.position;
    const b = one(doc, names, name).transform.position;
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * Math.sign(b[0] - a[0] + 1e-12);
  };
  check(Math.abs(shiftOf('boattail') - 10) < 0.01 && Math.abs(shiftOf('can')) < 1e-6 && Math.abs(shiftOf('nose')) < 1e-6, 'what hangs on the tube stays attached: the boattail moves out 10 mm (' + shiftOf('boattail').toFixed(3) + ' mm), can and nose stay (' + shiftOf('can').toFixed(3) + ', ' + shiftOf('nose').toFixed(3) + ' mm)');
  check(Math.abs(stripAfter - stripBefore - 10) < 0.5, 'the page strip is 10 mm longer (' + stripBefore.toFixed(1) + ' -> ' + stripAfter.toFixed(1) + ' mm)');
  let longest = 0;
  for (let i = 0; i < tasks.length; i++) {
    longest = Math.max(longest, tasks[i]);
  }
  console.log('  main thread while the part was replaced and the page rebuilt: ' + String(tasks.length) + ' long tasks, longest ' + longest.toFixed(0) + ' ms (the page build itself runs in the worker, ' + (await pageInfo(page)).buildMilliseconds.toFixed(0) + ' ms)');

  console.log('56. replace the fins with the canard: the decals that moved are listed');
  const fins = placedOfPart(doc, names, 'fin');
  const finDecalsBefore = doc.decals.filter((d) => fins.some((f) => f.id === d.anchor.placedId));
  await chooseFile(page, '.tree-row[data-placed-id="' + fins[0].id + '"] [data-action="replace-part"]', join(process.cwd(), 'test-models', 'canard.step'));
  await page.waitForTimeout(300);
  await settle(page);
  const notice = page.locator('.notice');
  const links = page.locator('.notice .notice-link');
  check((await notice.first().isVisible()) && (await links.count()) > 0, 'a notice lists ' + String(await links.count()) + ' decals to check: ' + ((await notice.first().textContent()) ?? '').replace('×', '').trim());
  await glide(page, away.x, away.y, 2);
  await shot(page, 'replace-notice');
  const firstLink = await page.locator('.notice .notice-link').first().boundingBox();
  const linkId = await page.evaluate(function read() {
    const link = document.querySelector('.notice .notice-link') as HTMLElement;
    return link.dataset.decalId as string;
  });
  if (firstLink !== null) {
    await click(page, firstLink.x + firstLink.width / 2, firstLink.y + firstLink.height / 2);
  }
  check((await page.evaluate(function read() {
    return window.dc6.selectedDecal();
  })) === linkId, 'clicking a name selects that decal');
  await glide(page, away.x, away.y, 2);
  await shot(page, 'replace-notice-selected');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await settle(page);
  doc = await documentOf(page);
  let restored = placedOfPart(doc, names, 'fin').length === 4;
  for (let i = 0; i < finDecalsBefore.length; i++) {
    restored = restored && JSON.stringify(decalById(doc, finDecalsBefore[i].id).anchor) === JSON.stringify(finDecalsBefore[i].anchor);
  }
  check(restored, 'one undo puts the fins and every decal on them back');
  await clickSelector(page, '.notice-close');
}

function requirePlacedIn(doc: AssemblyDocument, id: string): PlacedPart {
  const placed = doc.placed.find(function byId(p) {
    return p.id === id;
  });
  if (placed === undefined) {
    throw new Error('no placed part ' + id);
  }
  return placed;
}

await main();
