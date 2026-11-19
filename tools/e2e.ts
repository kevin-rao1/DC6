// End-to-end check of stage 1, driving the built app with real mouse events
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

import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Page, Playwright } from './playwright-types.ts';
import type { AssemblyDocument, PlacedPart } from '../src/model/document.ts';
import type { TestHook, WorldFace } from '../src/app/test-hook.ts';
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
  page.on('pageerror', function report(error) {
    failures.push('page error: ' + error.message);
    console.log('page error: ' + error.message);
  });

  try {
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
    // On the tube, 60 mm forward of its aft end, a little above the side facing us.
    const angle = (30 * Math.PI) / 180;
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
    }
    angles.sort(function ascending(a, b) {
      return a - b;
    });
    for (let i = 0; i < angles.length; i++) {
      const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
      const spacing = ((next - angles[i]) * 180) / Math.PI;
      check(Math.abs(spacing - 90) < 1e-6, 'neighbouring fins are 90 degrees apart (' + spacing.toFixed(6) + ')');
    }
    const frameTimes = await page.evaluate(function times() {
      return window.dc6.frameTimes();
    });
    let total = 0;
    let longest = 0;
    for (let i = 0; i < frameTimes.length; i++) {
      total = total + frameTimes[i];
      longest = Math.max(longest, frameTimes[i]);
    }
    console.log('scripted assembly took ' + (assemblyMs / 1000).toFixed(1) + ' s (including the scripted waits)');
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

await main();
