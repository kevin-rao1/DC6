// The project file (save and load), and replacing a part with a revised file.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Vec3 } from '../src/geometry/vec3.ts';
import { applyToDirection, applyToPoint } from '../src/geometry/transform.ts';
import type { Surface } from '../src/geometry/geodesic.ts';
import { nearestOnSurface, pieceIndex, worldNormal } from '../src/geometry/geodesic.ts';
import { anchorOf, defaultRight, frameAt, frameOf } from '../src/geometry/decal-map.ts';
import type { Artwork } from '../src/geometry/artwork.ts';
import { importSvg } from '../src/geometry/svg-import.ts';
import { cutFiles } from '../src/geometry/cut-export.ts';
import type { AssemblyDocument } from '../src/model/document.ts';
import { cloneDocument, emptyDocument } from '../src/model/document.ts';
import type { NewDecal } from '../src/model/decals.ts';
import { addDecal, requireDecal, setDecalColour } from '../src/model/decals.ts';
import { setDecalSymmetry } from '../src/model/decal-symmetry.ts';
import { cutPiecesOf } from '../src/model/cut-pieces.ts';
import type { ProjectContent } from '../src/model/project.ts';
import { fromBase64, hashBytes, readProject, toBase64, writeProject } from '../src/model/project.ts';
import { checkDistance, reattachDecals, reseatChildren, swapPart } from '../src/model/replace-part.ts';
import type { Part } from '../src/geometry/part.ts';
import { assembledRocket } from './rocket.ts';
import type { AssembledRocket } from './rocket.ts';
import { surfaceOf } from './surfaces.ts';
import type { Placed } from './surfaces.ts';
import { loadPart, modelBytes } from './models.ts';
import { body } from '../tools/test-model-dimensions.ts';

const here = dirname(fileURLToPath(import.meta.url));

function art(name: string): string {
  return readFileSync(join(here, '..', 'test-models', 'art', name + '.svg'), 'utf8');
}

function decalAt(surface: Surface, placedId: string, world: Vec3, name: string, artwork: Artwork): NewDecal {
  const piece = pieceIndex(surface, placedId);
  const found = nearestOnSurface(surface, world, null, 5, [piece]);
  if (found === null) {
    throw new Error('no surface near ' + JSON.stringify(world));
  }
  const frame = frameAt(surface, found.at, defaultRight(worldNormal(surface, found.at)));
  if (frame === null) {
    throw new Error('no frame');
  }
  const stored = anchorOf(surface, frame);
  return {
    name: name,
    artworkId: artwork.id,
    anchor: stored.anchor,
    rotation: stored.rotation,
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

// The document of an assembled rocket (placed parts named as in the surface).
function documentOf(rocket: AssembledRocket): AssemblyDocument {
  const doc = emptyDocument();
  for (let i = 0; i < rocket.placed.length; i++) {
    const placed = rocket.placed[i];
    doc.placed.push({ id: placed.id, partId: placed.part.id, transform: placed.transform, parentId: placed.id === 'tube' ? null : 'tube', joint: null, symmetry: null, hidden: false });
  }
  doc.rootId = 'tube';
  return doc;
}

describe('the project file', () => {
  it('base64 and the hash are what they should be', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
    expect(Array.from(fromBase64(toBase64(bytes.slice(0, 5))))).toEqual(Array.from(bytes.slice(0, 5)));
    expect(await hashBytes(new TextEncoder().encode('abc'))).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('save then load gives the same document, the same STEP files and the same cut files', async () => {
    const rocket = await assembledRocket('tube');
    const logo = importSvg(art('logo'), 'logo', 'a1').artwork as Artwork;
    const lettering = importSvg(art('lettering'), 'lettering', 'a2').artwork as Artwork;
    let doc = documentOf(rocket);
    const first = addDecal(doc, decalAt(rocket.surface, 'tube', [-150, 0, body.outerRadius], 'logo', logo));
    doc = setDecalSymmetry(first.doc, rocket.surface, first.id, 3, true, true).doc;
    const second = addDecal(doc, decalAt(rocket.surface, 'tube', [-60, 20, Math.sqrt(33 * 33 - 400)], 'lettering', lettering));
    doc = setDecalColour(second.doc, second.id, '#000000', '#e64097');
    doc.partColours['tube'] = '#f2f2f2';
    const files = [];
    for (const name of ['tube', 'nose']) {
      const bytes = new Uint8Array(modelBytes(name));
      files.push({ name: name + '.step', bytes: bytes, hash: await hashBytes(bytes) });
    }
    const content: ProjectContent = {
      document: doc,
      partOrder: ['tube.step#0', 'nose.step#0'],
      parts: [
        { id: 'tube.step#0', file: 0, solid: 0 },
        { id: 'nose.step#0', file: 1, solid: 0 },
      ],
      files: files,
      artworks: [
        { id: 'a1', name: 'logo', fileName: 'logo.svg', svg: art('logo') },
        { id: 'a2', name: 'lettering', fileName: 'lettering.svg', svg: art('lettering') },
      ],
      artworkOrder: ['a1', 'a2'],
    };
    const text = await writeProject(content);
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe('dc6-project');
    expect(parsed.version).toBe(1);
    expect(parsed.files[0].encoding).toBe('gzip-base64');
    const loaded = await readProject(text);
    expect(JSON.stringify(loaded.document)).toBe(JSON.stringify(doc));
    expect(loaded.partOrder).toEqual(content.partOrder);
    expect(loaded.parts).toEqual(content.parts);
    for (let i = 0; i < files.length; i++) {
      expect(loaded.files[i].hash).toBe(files[i].hash);
      expect(Buffer.from(loaded.files[i].bytes).equals(Buffer.from(files[i].bytes))).toBe(true);
    }
    // The artwork, read again from the saved SVG text, cuts the same.
    const artworks = new Map<string, Artwork>();
    for (let i = 0; i < loaded.artworks.length; i++) {
      const read = importSvg(loaded.artworks[i].svg, loaded.artworks[i].name, loaded.artworks[i].id).artwork as Artwork;
      artworks.set(read.id, read);
    }
    const before = new Map<string, Artwork>([
      ['a1', logo],
      ['a2', lettering],
    ]);
    for (const options of [
      { files: 'layers' as const, overlaps: 'layered' as const },
      { files: 'per-colour' as const, overlaps: 'knockout' as const },
    ]) {
      const a = cutFiles(cutPiecesOf(doc, before), options);
      const b = cutFiles(cutPiecesOf(loaded.document, artworks), options);
      expect(b.map((f) => f.fileName)).toEqual(a.map((f) => f.fileName));
      for (let i = 0; i < a.length; i++) {
        expect(b[i].text).toBe(a[i].text);
      }
    }
    // The linked copies are one row of the cut file each: 3 readable ... the flipped images separately.
    const pieces = cutPiecesOf(loaded.document, artworks);
    expect(pieces.map((p) => p.name + ' x' + String(p.quantity))).toEqual(['logo x3', 'logo (mirrored) x3', 'lettering x1']);
  });

  it('a damaged file is refused, not loaded wrong', async () => {
    const bytes = new TextEncoder().encode('ISO-10303-21; not really');
    const text = await writeProject({
      document: emptyDocument(),
      partOrder: [],
      parts: [],
      files: [{ name: 'x.step', bytes: bytes, hash: await hashBytes(bytes) }],
      artworks: [],
      artworkOrder: [],
    });
    const stored = JSON.parse(text);
    stored.files[0].hash = 'sha256:00';
    await expect(readProject(JSON.stringify(stored))).rejects.toThrow(/damaged/);
    await expect(readProject('{"format":"something else"}')).rejects.toThrow(/not a DC6 project/);
  });
});

describe('replacing a part with a revised file', () => {
  it('the tube 10 mm longer: every decal on it stays where it was, nothing to report', async () => {
    const rocket = await assembledRocket('tube');
    const logo = importSvg(art('logo'), 'logo', 'a1').artwork as Artwork;
    let doc = documentOf(rocket);
    const places: Vec3[] = [
      [-150, 0, body.outerRadius],
      [-60, body.outerRadius, 0],
      [-250, -20, -Math.sqrt(33 * 33 - 400)],
    ];
    const ids: string[] = [];
    for (let i = 0; i < places.length; i++) {
      const added = addDecal(doc, decalAt(rocket.surface, 'tube', places[i], 'logo ' + String(i + 1), logo));
      doc = added.doc;
      ids.push(added.id);
    }
    // A set of copies too: each copy is re-attached as it is.
    doc = setDecalSymmetry(doc, rocket.surface, ids[0], 4, false, false).doc;
    const longTube = await loadPart('tube-long');
    longTube.id = 'tube-long.step#0';
    const oldTube = rocket.placed.filter((p) => p.id === 'tube')[0];
    const swapped = swapPart(doc, oldTube.part.id, longTube.id, oldTube.part, longTube);
    expect(swapped.placed.filter((p) => p.id === 'tube')[0].partId).toBe(longTube.id);
    // The new surface: the same placements, the long tube in the tube's place.
    const list: Placed[] = rocket.placed.map((p) => (p.id === 'tube' ? { id: 'tube', part: longTube, transform: p.transform } : p));
    const newSurface = surfaceOf(list);
    const result = reattachDecals(swapped, rocket.surface, newSurface, new Set(['tube']));
    expect(result.report).toEqual([]);
    for (let i = 0; i < doc.decals.length; i++) {
      const before = doc.decals[i];
      const after = requireDecal(result.doc, before.id);
      const frame = frameOf(newSurface, after.anchor, after.rotation);
      expect(frame).not.toBe(null);
      const moved = Math.hypot(after.anchor.position[0] - before.anchor.position[0], after.anchor.position[1] - before.anchor.position[1], after.anchor.position[2] - before.anchor.position[2]);
      expect(moved).toBeLessThan(checkDistance);
      // The same way round.
      const oldFrame = frameOf(rocket.surface, before.anchor, before.rotation);
      if (frame === null || oldFrame === null) {
        throw new Error('no frame');
      }
      expect(frame.right[0] * oldFrame.right[0] + frame.right[1] * oldFrame.right[1] + frame.right[2] * oldFrame.right[2]).toBeGreaterThan(0.999);
    }
  });

  it('the tube 10 mm longer: what is stacked on its grown end moves out 10 mm, keeping any offset; the rest stays', async () => {
    const rocket = await assembledRocket('tube');
    const tube = rocket.placed.filter((p) => p.id === 'tube')[0];
    // The tube's two end faces, by which way they face.
    let fore = -1;
    let aft = -1;
    for (let f = 0; f < tube.part.attachFaces.length; f++) {
      const n = applyToDirection(tube.transform, tube.part.attachFaces[f].normal);
      if (n[0] < -0.99) {
        fore = f;
      }
      if (n[0] > 0.99) {
        aft = f;
      }
    }
    const doc = documentOf(rocket);
    for (let i = 0; i < doc.placed.length; i++) {
      const placed = doc.placed[i];
      if (placed.id === 'can') {
        // Snapped by its internals on the fore end, then pushed in: the joint says which faces.
        placed.joint = { ownFace: 0, parentFace: fore };
      } else if (placed.id === 'boattail') {
        placed.joint = { ownFace: 0, parentFace: aft };
      } else if (placed.id.startsWith('fin')) {
        const part = rocket.placed[i].part;
        placed.joint = { ownFace: part.guessedAttachFace, parentFace: null };
      } else if (placed.id === 'nose') {
        placed.parentId = 'can';
        placed.joint = { ownFace: 0, parentFace: 0 };
      }
    }
    const longTube = await loadPart('tube-long');
    longTube.id = 'tube-long.step#0';
    const parts = new Map<string, Part>();
    for (let i = 0; i < rocket.placed.length; i++) {
      parts.set(rocket.placed[i].part.id, rocket.placed[i].part);
    }
    parts.set(longTube.id, longTube);
    const swapped = swapPart(doc, tube.part.id, longTube.id, tube.part, longTube);
    const list: Placed[] = rocket.placed.map((p) => (p.id === 'tube' ? { id: 'tube', part: longTube, transform: p.transform } : p));
    const result = reseatChildren(doc, swapped, tube.part.id, tube.part, longTube, parts, rocket.surface, surfaceOf(list));
    function shift(id: string): Vec3 {
      const a = doc.placed.filter((p) => p.id === id)[0].transform.position;
      const b = result.doc.placed.filter((p) => p.id === id)[0].transform.position;
      return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    }
    const canShift = shift('can');
    const tailShift = shift('boattail');
    console.log('tube 10 mm longer: can moved ' + canShift.map((v) => v.toFixed(3)).join(', ') + ' mm, boattail ' + tailShift.map((v) => v.toFixed(3)).join(', ') + ' mm');
    // One end grew by 10 mm: the part on it moves 10 mm along the axis, outwards; the other stays.
    const moves = [Math.hypot(canShift[0], canShift[1], canShift[2]), Math.hypot(tailShift[0], tailShift[1], tailShift[2])].sort((a, b) => a - b);
    expect(moves[0]).toBeLessThan(1e-6);
    expect(Math.abs(moves[1] - 10)).toBeLessThan(1e-3);
    expect(Math.abs(Math.abs(canShift[0] + tailShift[0]) - 10)).toBeLessThan(1e-3);
    if (Math.abs(canShift[0]) > 1) {
      expect(canShift[0]).toBeLessThan(0); // out towards the nose
      // The nose on the can comes with it.
      expect(Math.abs(shift('nose')[0] - canShift[0])).toBeLessThan(1e-9);
    } else {
      expect(tailShift[0]).toBeGreaterThan(0); // out towards the tail
    }
    // The fins stand on the same radius: they stay (within the tessellation).
    for (let k = 1; k <= 4; k++) {
      const finShift = shift('fin' + String(k));
      expect(Math.hypot(finShift[0], finShift[1], finShift[2])).toBeLessThan(0.1);
    }
  });

  it('a fin replaced by a smaller one: a decal near the old tip has nowhere near to go and is reported with the distance', async () => {
    const rocket = await assembledRocket('tube');
    const logo = importSvg(art('logo'), 'logo', 'a1').artwork as Artwork;
    const fin1 = rocket.placed.filter((p) => p.id === 'fin1')[0];
    // Two points on a side of fin 1: near its root, and near its tip.
    const pieceNumber = pieceIndex(rocket.surface, 'fin1');
    const piece = rocket.surface.pieces[pieceNumber];
    let lowest: Vec3 | null = null;
    let highest: Vec3 | null = null;
    let lowReach = Infinity;
    let highReach = 0;
    for (let t = 0; t < piece.mesh.triangles.length / 3; t++) {
      const n = worldNormal(rocket.surface, { piece: pieceNumber, triangle: t, point: [0, 0, 0] });
      if (Math.abs(-n[1] * Math.SQRT1_2 + n[2] * Math.SQRT1_2) < 0.99) {
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const v = piece.mesh.triangles[3 * t + k];
        const local: Vec3 = [piece.mesh.positions[3 * v], piece.mesh.positions[3 * v + 1], piece.mesh.positions[3 * v + 2]];
        const world = applyToPoint(piece.transform, local);
        const reach = Math.hypot(world[1], world[2]);
        if (reach > highReach) {
          highReach = reach;
          highest = world;
        }
        if (reach < lowReach) {
          lowReach = reach;
          lowest = world;
        }
      }
    }
    if (lowest === null || highest === null) {
      throw new Error('no fin side');
    }
    // A fifth of the way from the root to the tip, and nearly at the tip.
    const rootPoint: Vec3 = [lowest[0] * 0.8 + highest[0] * 0.2, lowest[1] * 0.8 + highest[1] * 0.2, lowest[2] * 0.8 + highest[2] * 0.2];
    const tipPoint: Vec3 = [lowest[0] * 0.05 + highest[0] * 0.95, lowest[1] * 0.05 + highest[1] * 0.95, lowest[2] * 0.05 + highest[2] * 0.95];
    let doc = documentOf(rocket);
    const nearRoot = addDecal(doc, decalAt(rocket.surface, 'fin1', rootPoint, 'root logo', logo));
    const nearTip = addDecal(nearRoot.doc, decalAt(rocket.surface, 'fin1', tipPoint, 'tip logo', logo));
    doc = nearTip.doc;
    // The canard (30 mm span, in inches) in the fin's place.
    const canard = await loadPart('canard');
    canard.id = 'canard.step#0';
    const list: Placed[] = rocket.placed.map((p) => (p.id === 'fin1' ? { id: 'fin1', part: canard, transform: fin1.transform } : p));
    const swapped = swapPart(doc, fin1.part.id, canard.id, fin1.part, canard);
    const result = reattachDecals(cloneDocument(swapped), rocket.surface, surfaceOf(list), new Set(['fin1']));
    const tip = result.report.filter((r) => r.decalId === nearTip.id)[0];
    expect(tip).not.toBe(undefined);
    expect(tip.distance).toBeGreaterThan(checkDistance);
    // Still on the part: nothing is dropped.
    expect(requireDecal(result.doc, nearTip.id).anchor.placedId).toBe('fin1');
    expect(result.doc.decals.length).toBe(2);
  });
});
