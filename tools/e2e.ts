// End-to-end check of stages 1 to 3, driving the built app with real mouse events
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
// Then decals (stage 2) and the cut file (stage 3): see decalSteps below.

import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Page, Playwright } from './playwright-types.ts';
import { readFileSync } from 'node:fs';
import type { DecalInfo } from '../src/app/test-hook.ts';
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

await main();
