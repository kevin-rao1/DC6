// End-to-end check of stage 1, driving the built app with real mouse events
// (page.mouse move/down/up and real key presses; nothing is placed by calling
// the editor). window.dc6 is only used to find where things are on screen and
// to read the resulting document.
//
// Run with:   npm run e2e        (builds first, then runs this)
// Screenshots: one per step, in $DC6_E2E_OUT or the scratch folder below.

import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import type { AssemblyDocument, PlacedPart } from '../src/model/document.ts';
import type { TestHook, WorldFace } from '../src/app/test-hook.ts';
import type { Vec3 } from '../src/geometry/vec3.ts';

// Playwright is installed on the machine, not as a project dependency.
const require = createRequire(import.meta.url);
const playwright = require('playwright') as typeof import('playwright');

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
async function shot(page: Page, name: string): Promise<void> {
  stepNumber = stepNumber + 1;
  const file = join(outputDirectory, String(stepNumber).padStart(2, '0') + '-' + name + '.png');
  await page.screenshot({ path: file });
  console.log('screenshot ' + file);
}

async function documentOf(page: Page): Promise<AssemblyDocument> {
  return page.evaluate(function read() {
    return window.dc6.document();
  });
}

async function faces(page: Page, placedId: string): Promise<WorldFace[]> {
  return page.evaluate(function read(id) {
    return window.dc6.attachFaces(id);
  }, placedId);
}

async function screenOf(page: Page, point: Vec3): Promise<{ x: number; y: number }> {
  return page.evaluate(function project(p) {
    return window.dc6.screenOf(p);
  }, point);
}

async function click(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
}

async function clickSelector(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) {
    throw new Error('no element for ' + selector);
  }
  await click(page, box.x + box.width / 2, box.y + box.height / 2);
}

// Glide the mouse to a point in many small moves, as a hand would.
async function glide(page: Page, x: number, y: number, steps: number): Promise<void> {
  await page.mouse.move(x, y, { steps: steps });
  await page.waitForTimeout(120);
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

function fromAxis(p: Vec3): number {
  // The rocket axis is world X.
  return Math.hypot(p[1], p[2]);
}

function along(direction: Vec3, sign: number, list: WorldFace[], radius: number): WorldFace {
  for (let i = 0; i < list.length; i++) {
    const face = list[i];
    const r = face.radius === null ? -1 : face.radius;
    if (Math.abs(r - radius) < 0.05 && face.normal[0] * direction[0] * sign > 0.99) {
      return face;
    }
  }
  throw new Error('no face of radius ' + String(radius) + ' facing ' + String(sign));
}

const X: Vec3 = [1, 0, 0];

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
    const emptySpot = { x: canvas.x + canvas.width * 0.5, y: canvas.y + canvas.height * 0.17 };

    console.log('2. drop the tube as root');
    await clickSelector(page, '.bin-item[data-part-name="tube"]');
    await glide(page, middle.x, middle.y, 20);
    await shot(page, 'tube-held');
    await click(page, middle.x, middle.y);
    let doc = await documentOf(page);
    const tube = one(doc, names, 'tube');
    check(doc.rootId === tube.id, 'the tube is the root');
    await shot(page, 'tube-root');

    console.log('3. place on face: stand the tube on its other end');
    await clickSelector(page, 'button[data-tool="face"]');
    let tubeFaces = await faces(page, tube.id);
    let tubeCentre = tubeFaces[0].centre;
    let at = await screenOf(page, [(tubeFaces[0].centre[0] + tubeFaces[1].centre[0]) / 2, 0, 33]);
    await click(page, at.x, at.y); // select the tube
    await clickSelector(page, 'button[data-view="nose"]');
    await page.waitForTimeout(150);
    await shot(page, 'tube-faces-from-nose');
    // The tube end facing the nose view.
    const foreEnd = along(X, -1, tubeFaces, 33);
    at = await screenOf(page, foreEnd.centre);
    await click(page, at.x, at.y);
    doc = await documentOf(page);
    tubeFaces = await faces(page, tube.id);
    const aftEnd = along(X, 1, tubeFaces, 33);
    check(distance(aftEnd.centre, [0, 0, 0]) < 0.01, 'the clicked face is now the aft face, at the origin');
    check(doc.attachFaceByPart[tube.partId] !== undefined, 'the choice is remembered for the tube');
    void tubeCentre;
    await clickSelector(page, 'button[data-view="side"]');
    await clickSelector(page, 'button[data-view="fit"]');
    await page.waitForTimeout(150);
    await shot(page, 'tube-turned');

    console.log('4. attach the nose cone by stack snap');
    await clickSelector(page, 'button[data-tool="place"]');
    await clickSelector(page, '.bin-item[data-part-name="nose"]');
    await glide(page, emptySpot.x, emptySpot.y, 10);
    tubeFaces = await faces(page, tube.id);
    const tubeFore = along(X, -1, tubeFaces, 33);
    const forePoint = await screenOf(page, tubeFore.centre);
    // Come in from up and to the left, stopping on the node.
    await glide(page, forePoint.x - 60, forePoint.y - 80, 15);
    await glide(page, forePoint.x - 4, forePoint.y - 3, 15);
    const snapKind = await page.evaluate(function snap() {
      return window.dc6.heldSnap();
    });
    check(snapKind === 'stack', 'the held nose snaps onto the tube end (' + String(snapKind) + ')');
    await shot(page, 'nose-snapped');
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    doc = await documentOf(page);
    const nose = one(doc, names, 'nose');
    check(nose.parentId === tube.id, 'the nose is a child of the tube');
    await shot(page, 'nose-dropped');

    console.log('5. join the can with place on face');
    await clickSelector(page, '.bin-item[data-part-name="can"]');
    await glide(page, emptySpot.x, emptySpot.y, 15);
    await click(page, emptySpot.x, emptySpot.y);
    doc = await documentOf(page);
    const can = one(doc, names, 'can');
    check(can.parentId === null, 'the can was dropped free, beside the rocket');
    await clickSelector(page, 'button[data-tool="face"]');
    let canFaces = await faces(page, can.id);
    at = await screenOf(page, canFaces[0].centre);
    // Select the can by clicking its body (a little off the face centre).
    const canBody = await page.evaluate(function centre(id) {
      const list = window.dc6.attachFaces(id);
      const a = list[0].centre;
      const b = list[1].centre;
      return window.dc6.screenOf([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 30, (a[2] + b[2]) / 2 + 2]);
    }, can.id);
    await click(page, canBody.x, canBody.y);
    await clickSelector(page, 'button[data-view="nose"]');
    await page.waitForTimeout(150);
    canFaces = await faces(page, can.id);
    // The can's shoulder step: the 33 mm disc facing the same way as the
    // spigot end (30 mm). Click it outside the spigot's disc.
    const spigotEnd = canFaces.find(function spigot(f) {
      return f.radius !== null && Math.abs(f.radius - 30) < 0.05;
    });
    if (spigotEnd === undefined) {
      throw new Error('no spigot end on the can');
    }
    const step = canFaces.find(function stepFace(f) {
      const sameWay = f.normal[0] * spigotEnd.normal[0] + f.normal[1] * spigotEnd.normal[1] + f.normal[2] * spigotEnd.normal[2] > 0.99;
      return f.radius !== null && Math.abs(f.radius - 33) < 0.05 && sameWay;
    });
    if (step === undefined) {
      throw new Error('no shoulder step on the can');
    }
    at = await screenOf(page, [step.centre[0], step.centre[1] + 31.5, step.centre[2]]);
    await shot(page, 'can-faces');
    await click(page, at.x, at.y);
    await clickSelector(page, 'button[data-view="tail"]');
    await page.waitForTimeout(150);
    await shot(page, 'can-face-chosen');
    tubeFaces = await faces(page, tube.id);
    const tubeAft = along(X, 1, tubeFaces, 33);
    at = await screenOf(page, [tubeAft.centre[0], tubeAft.centre[1] - 32, tubeAft.centre[2]]);
    await click(page, at.x, at.y);
    doc = await documentOf(page);
    const canAfter = one(doc, names, 'can');
    check(canAfter.parentId === tube.id, 'the can is joined to the tube');
    await clickSelector(page, 'button[data-view="side"]');
    await clickSelector(page, 'button[data-view="fit"]');
    await page.waitForTimeout(150);
    await shot(page, 'can-joined');

    console.log('6. attach the boattail by stack snap');
    await clickSelector(page, 'button[data-tool="place"]');
    await clickSelector(page, '.bin-item[data-part-name="boattail"]');
    await glide(page, emptySpot.x, emptySpot.y, 10);
    canFaces = await faces(page, can.id);
    const rim = canFaces.find(function rimFace(f) {
      return f.radius !== null && Math.abs(f.radius - 33) < 0.05 && f.normal[0] > 0.99;
    });
    if (rim === undefined) {
      throw new Error('no free rim on the can');
    }
    const rimPoint = await screenOf(page, rim.centre);
    await glide(page, rimPoint.x + 70, rimPoint.y - 60, 15);
    await glide(page, rimPoint.x + 3, rimPoint.y + 2, 15);
    const tailSnap = await page.evaluate(function snap() {
      return window.dc6.heldSnap();
    });
    check(tailSnap === 'stack', 'the held boattail snaps onto the can rim (' + String(tailSnap) + ')');
    await shot(page, 'boattail-snapped');
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    doc = await documentOf(page);
    const boattail = one(doc, names, 'boattail');
    check(boattail.parentId === can.id, 'the boattail is a child of the can');
    await shot(page, 'boattail-dropped');

    console.log('7. one fin with x4 symmetry');
    for (let i = 0; i < 3; i++) {
      await clickSelector(page, 'button[data-control="symmetry"]');
    }
    const symmetryText = await page.locator('button[data-control="symmetry"]').textContent();
    check(symmetryText === '×4', 'symmetry set to x4');
    await clickSelector(page, '.bin-item[data-part-name="fin"]');
    await glide(page, emptySpot.x, emptySpot.y, 10);
    // On the near side of the tube, 30 mm forward of its aft end.
    const finPoint = await screenOf(page, [-30, 0, 33]);
    await glide(page, finPoint.x, finPoint.y, 20);
    const finSnap = await page.evaluate(function snap() {
      return window.dc6.heldSnap();
    });
    check(finSnap === 'surface', 'the held fin attaches to the tube surface (' + String(finSnap) + ')');
    await shot(page, 'fin-held');
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    await shot(page, 'fins-dropped');

    console.log('8. hide the sled');
    await clickSelector(page, '.bin-item[data-part-name="sled"]');
    await glide(page, emptySpot.x, emptySpot.y, 15);
    await click(page, emptySpot.x, emptySpot.y);
    doc = await documentOf(page);
    const sled = one(doc, names, 'sled');
    await clickSelector(page, '.tree-row[data-placed-id="' + sled.id + '"] .eye');
    doc = await documentOf(page);
    check(one(doc, names, 'sled').hidden, 'the sled is hidden');
    await shot(page, 'sled-hidden');

    console.log('9. undo twice, redo once');
    await page.mouse.move(middle.x, canvas.y + canvas.height - 40);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    doc = await documentOf(page);
    check(!one(doc, names, 'sled').hidden, 'first undo shows the sled again');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    doc = await documentOf(page);
    check(placedOfPart(doc, names, 'sled').length === 0, 'second undo removes the sled');
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(100);
    doc = await documentOf(page);
    check(placedOfPart(doc, names, 'sled').length === 1, 'redo puts the sled back');
    const assemblyMs = Date.now() - assemblyStart;
    await clickSelector(page, 'button[data-view="fit"]');
    await page.mouse.move(canvas.x + 5, canvas.y + canvas.height - 5);
    await page.waitForTimeout(200);
    await shot(page, 'final');

    console.log('10. check the assembly');
    doc = await documentOf(page);
    const sections = ['tube', 'nose', 'can', 'boattail'];
    for (let i = 0; i < sections.length; i++) {
      const placed = one(doc, names, sections[i]);
      const list = await faces(page, placed.id);
      let worst = 0;
      let worstAngle = 0;
      for (let k = 0; k < list.length; k++) {
        if (list[k].radius === null) {
          continue;
        }
        worst = Math.max(worst, fromAxis(list[k].centre));
        worstAngle = Math.max(worstAngle, 1 - Math.abs(list[k].normal[0]));
      }
      check(worst < 0.01 && worstAngle < 1e-9, sections[i] + ' is coaxial with the rocket axis (off by ' + worst.toExponential(2) + ' mm)');
    }
    for (let i = 0; i < doc.placed.length; i++) {
      const child = doc.placed[i];
      if (child.parentId === null || child.joint === null || child.joint.parentFace === null) {
        continue;
      }
      const own = (await faces(page, child.id))[child.joint.ownFace];
      const theirs = (await faces(page, child.parentId))[child.joint.parentFace];
      const gap = distance(own.centre, theirs.centre);
      const facing = own.normal[0] * theirs.normal[0] + own.normal[1] * theirs.normal[1] + own.normal[2] * theirs.normal[2];
      check(gap < 0.01 && facing < -1 + 1e-9, names[child.partId] + ' touches its parent face to face (gap ' + gap.toExponential(2) + ' mm)');
    }
    const fins = placedOfPart(doc, names, 'fin');
    check(fins.length === 4, 'four fins');
    const groups = new Set(fins.map(function group(f) {
      return f.symmetry === null ? 'none' : f.symmetry.group;
    }));
    check(groups.size === 1 && !groups.has('none'), 'the four fins are one linked symmetry set');
    const angles: number[] = [];
    for (let i = 0; i < fins.length; i++) {
      const list = await faces(page, fins[i].id);
      const root = list[fins[i].joint === null ? 0 : fins[i].joint.ownFace];
      check(Math.abs(fromAxis(root.centre) - 33) < 0.05, 'fin ' + String(i + 1) + ' root sits on the tube surface (r = ' + fromAxis(root.centre).toFixed(3) + ' mm)');
      angles.push(Math.atan2(root.centre[2], root.centre[1]));
    }
    angles.sort(function ascending(a, b) {
      return a - b;
    });
    for (let i = 0; i < angles.length; i++) {
      const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
      const spacing = ((next - angles[i]) * 180) / Math.PI;
      check(Math.abs(spacing - 90) < 1e-6, 'fins ' + String(i + 1) + ' and ' + String(((i + 1) % 4) + 1) + ' are 90 degrees apart (' + spacing.toFixed(6) + ')');
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
  if (failures.length > 0) {
    console.log(String(failures.length) + ' check(s) failed');
    process.exit(1);
  }
  console.log('all checks passed');
}

await main();
