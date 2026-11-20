// Decal symmetry: linked copies round the axis, mirror images, copies on
// every fin of a fin set, editing one edits all, make unique.

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/geometry/vec3.ts';
import { cross, dot, length, sub } from '../src/geometry/vec3.ts';
import { applyToDirection } from '../src/geometry/transform.ts';
import type { Surface } from '../src/geometry/geodesic.ts';
import { nearestOnSurface, pieceIndex, worldNormal, worldPoint } from '../src/geometry/geodesic.ts';
import { anchorOf, defaultRight, frameAt, frameOf, upOf } from '../src/geometry/decal-map.ts';
import type { AssemblyDocument } from '../src/model/document.ts';
import { emptyDocument } from '../src/model/document.ts';
import type { Decal, NewDecal } from '../src/model/decals.ts';
import { addDecal, decalGroup, requireDecal, updateDecal } from '../src/model/decals.ts';
import { makeDecalUnique, setDecalSymmetry, syncDecalGroup } from '../src/model/decal-symmetry.ts';
import { cutPiecesOf } from '../src/model/cut-pieces.ts';
import { assembledRocket } from './rocket.ts';
import { body } from '../tools/test-model-dimensions.ts';

function decalAt(surface: Surface, placedId: string, world: Vec3, name: string): NewDecal {
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
    artworkId: 'a1',
    anchor: stored.anchor,
    rotation: stored.rotation,
    width: 40,
    height: 15,
    flipX: false,
    flipY: false,
    hidden: false,
    locked: false,
    colourMap: {},
    symmetry: null,
  };
}

function frameInfo(surface: Surface, decal: Decal): { point: Vec3; normal: Vec3; up: Vec3; right: Vec3 } {
  const frame = frameOf(surface, decal.anchor, decal.rotation);
  if (frame === null) {
    throw new Error('decal ' + decal.id + ' is not on the surface');
  }
  return { point: worldPoint(surface, frame.at), normal: worldNormal(surface, frame.at), up: upOf(surface, frame), right: frame.right };
}

function rollOf(p: Vec3): number {
  return Math.atan2(p[1], p[2]);
}

async function rocketWithDecal(placedId: string, world: Vec3): Promise<{ surface: Surface; doc: AssemblyDocument; id: string }> {
  const rocket = await assembledRocket('tube');
  const doc = emptyDocument();
  // The placed parts, as the document lists them (ids as in the surface).
  for (let i = 0; i < rocket.placed.length; i++) {
    doc.placed.push({ id: rocket.placed[i].id, partId: rocket.placed[i].part.id, transform: rocket.placed[i].transform, parentId: null, joint: null, symmetry: null, hidden: false });
  }
  const added = addDecal(doc, decalAt(rocket.surface, placedId, world, 'logo'));
  return { surface: rocket.surface, doc: added.doc, id: added.id };
}

describe('decal symmetry', () => {
  it('x4 round the tube: four linked copies a quarter turn apart, same station, same size; editing one edits all', async () => {
    // On the side of the tube facing the side view (+z), 40 mm forward of the fins.
    const start = await rocketWithDecal('tube', [-150, 0, body.outerRadius]);
    const result = setDecalSymmetry(start.doc, start.surface, start.id, 4, false, false);
    expect(result.made).toBe(4);
    const members = decalGroup(result.doc, start.id);
    expect(members.length).toBe(4);
    const rolls: number[] = [];
    for (let i = 0; i < members.length; i++) {
      const info = frameInfo(start.surface, members[i]);
      expect(members[i].anchor.placedId).toBe('tube');
      expect(Math.abs(info.point[0] - -150)).toBeLessThan(0.05);
      expect(Math.abs(Math.hypot(info.point[1], info.point[2]) - body.outerRadius)).toBeLessThan(0.1);
      rolls.push(rollOf(info.point));
    }
    rolls.sort((a, b) => a - b);
    for (let i = 1; i < rolls.length; i++) {
      expect(Math.abs(rolls[i] - rolls[i - 1] - Math.PI / 2)).toBeLessThan(0.01);
    }
    // Edit a copy (not the original): all four follow.
    const copy = members[2];
    let edited = updateDecal(result.doc, copy.id, { width: 60, height: 22.5, colourMap: { '#000000': '#e64097' } });
    edited = syncDecalGroup(edited, start.surface, copy.id);
    const after = decalGroup(edited, start.id);
    for (let i = 0; i < after.length; i++) {
      expect(after[i].width).toBe(60);
      expect(after[i].colourMap['#000000']).toBe('#e64097');
    }
    // Moved: the copies keep a quarter turn apart from where the edited one went.
    const moved = updateDecal(edited, copy.id, {});
    const editedFrame = frameInfo(start.surface, requireDecal(moved, copy.id));
    for (let i = 0; i < after.length; i++) {
      const info = frameInfo(start.surface, after[i]);
      expect(Math.abs(info.point[0] - editedFrame.point[0])).toBeLessThan(0.05);
    }
  });

  it('mirror: the copy lands on the other side; lettering on it reads the right way round unless the artwork is flipped', async () => {
    const start = await rocketWithDecal('tube', [-150, 10, Math.sqrt(body.outerRadius * body.outerRadius - 100)]);
    const readable = setDecalSymmetry(start.doc, start.surface, start.id, 1, true, false);
    expect(readable.made).toBe(2);
    const members = decalGroup(readable.doc, start.id);
    const original = frameInfo(start.surface, members[0]);
    const image = frameInfo(start.surface, members[1]);
    // Reflected through the vertical plane through the axis: z -> -z.
    expect(length(sub(image.point, [original.point[0], original.point[1], -original.point[2]]))).toBeLessThan(0.1);
    // Readable: still upright, and right is towards the nose as seen from that side.
    expect(dot(image.up, [original.up[0], original.up[1], -original.up[2]])).toBeGreaterThan(0.99);
    expect(image.up[1]).toBeGreaterThan(0.9);
    expect(image.right[0]).toBeLessThan(-0.99);
    expect(original.right[0]).toBeGreaterThan(0.99);
    // Seen from outside, the frame is right-handed (not mirrored).
    expect(dot(cross(image.right, image.up), image.normal)).toBeGreaterThan(0.99);
    expect(members[1].flipX).toBe(false);
    // The true mirror image: artwork flipped.
    const flipped = setDecalSymmetry(start.doc, start.surface, start.id, 1, true, true);
    const flippedMembers = decalGroup(flipped.doc, start.id);
    expect(flippedMembers[1].flipX).toBe(true);
    expect(flippedMembers[0].flipX).toBe(false);
    // Cut: the flipped image is a separate outline; the readable one is the same piece twice.
    const artworks = new Map([['a1', { id: 'a1', name: 'logo', width: 40, height: 15, colours: ['#000000'], shapes: [] }]]);
    const readablePieces = cutPiecesOf(readable.doc, artworks);
    expect(readablePieces.length).toBe(1);
    expect(readablePieces[0].quantity).toBe(2);
    const flippedPieces = cutPiecesOf(flipped.doc, artworks);
    expect(flippedPieces.length).toBe(2);
    expect(flippedPieces[0].quantity).toBe(1);
    expect(flippedPieces[1].quantity).toBe(1);
  });

  it('on every fin: a decal on one fin of the x4 set goes to the same place on the same side of each fin', async () => {
    const rocket = await assembledRocket('tube');
    const fin1 = rocket.surface.pieces[pieceIndex(rocket.surface, 'fin1')];
    // A point on a side of fin 1: the middle of a large flat triangle facing away from the axis' plane.
    let world: Vec3 = [0, 0, 0];
    for (let t = 0; t < fin1.mesh.triangles.length / 3; t++) {
      const at = { piece: pieceIndex(rocket.surface, 'fin1'), triangle: t, point: [0, 0, 0] as Vec3 };
      const n = worldNormal(rocket.surface, at);
      // The fin at 45 degrees: its sides face along (0, -cos 45, sin 45) or the opposite.
      if (Math.abs(n[1] * -Math.SQRT1_2 + n[2] * Math.SQRT1_2) > 0.99) {
        const a = fin1.mesh.triangles[3 * t];
        const local: Vec3 = [fin1.mesh.positions[3 * a], fin1.mesh.positions[3 * a + 1], fin1.mesh.positions[3 * a + 2]];
        world = worldPoint(rocket.surface, { piece: at.piece, triangle: t, point: local });
        break;
      }
    }
    // Nudge it off the edge onto the face (towards the fin's middle).
    const doc = addDecal(emptyDocument(), decalAt(rocket.surface, 'fin1', world, 'fin logo'));
    const decal = requireDecal(doc.doc, doc.id);
    const result = setDecalSymmetry(doc.doc, rocket.surface, doc.id, 4, false, false);
    expect(result.made).toBe(4);
    const members = decalGroup(result.doc, doc.id);
    const fins = new Set<string>();
    for (let i = 0; i < members.length; i++) {
      fins.add(members[i].anchor.placedId);
      // The same triangle of the same mesh: the same place on the same side.
      expect(members[i].anchor.triangle).toBe(decal.anchor.triangle);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(members[i].anchor.barycentric[k] - decal.anchor.barycentric[k])).toBeLessThan(1e-6);
      }
      // Turned with its fin: the same direction in the fin's own frame.
      const piece = rocket.surface.pieces[pieceIndex(rocket.surface, members[i].anchor.placedId)];
      const ownRight = applyToDirection(piece.inverse, frameInfo(rocket.surface, members[i]).right);
      const firstPiece = rocket.surface.pieces[pieceIndex(rocket.surface, decal.anchor.placedId)];
      const firstRight = applyToDirection(firstPiece.inverse, frameInfo(rocket.surface, decal).right);
      expect(dot(ownRight, firstRight)).toBeGreaterThan(0.999999);
    }
    expect(Array.from(fins).sort()).toEqual(['fin1', 'fin2', 'fin3', 'fin4']);
    // Mirror on as well: the images go on the other side of the fins.
    const both = setDecalSymmetry(doc.doc, rocket.surface, doc.id, 4, true, false);
    expect(both.made).toBe(8);
    const all = decalGroup(both.doc, doc.id);
    let otherSide = 0;
    for (let i = 0; i < all.length; i++) {
      const symmetry = all[i].symmetry;
      if (symmetry !== null && symmetry.mirrored && all[i].anchor.triangle !== decal.anchor.triangle) {
        otherSide = otherSide + 1;
      }
    }
    expect(otherSide).toBe(4);
  });

  it('make unique takes one copy out; the rest stay linked; changing the count replaces the set', async () => {
    const start = await rocketWithDecal('tube', [-150, 0, body.outerRadius]);
    const set = setDecalSymmetry(start.doc, start.surface, start.id, 3, false, false);
    const members = decalGroup(set.doc, start.id);
    const loner = members[1].id;
    const unique = makeDecalUnique(set.doc, loner);
    expect(requireDecal(unique, loner).symmetry).toBe(null);
    expect(decalGroup(unique, start.id).length).toBe(2);
    // Editing the set leaves the loner alone.
    const edited = syncDecalGroup(updateDecal(unique, start.id, { width: 70 }), start.surface, start.id);
    expect(requireDecal(edited, loner).width).toBe(40);
    // A new count from any member: the set is made again round it.
    const six = setDecalSymmetry(edited, start.surface, start.id, 6, false, false);
    expect(decalGroup(six.doc, start.id).length).toBe(6);
    expect(six.doc.decals.length).toBe(7);
    const back = setDecalSymmetry(six.doc, start.surface, start.id, 1, false, false);
    expect(back.doc.decals.length).toBe(2);
    expect(requireDecal(back.doc, start.id).symmetry).toBe(null);
  });
});
