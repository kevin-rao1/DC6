// Decal symmetry (brief v1 4.5), KSP style: linked copies of a decal spaced
// evenly round the rocket axis, and mirror images through the vertical
// plane that contains the axis (the plane the side view looks at square on,
// so a mirror image lands on the far side).
//
// Every member of a set is one rigid motion of member 0:
//   member (k, mirrored) = turn by k/count of a turn about the axis,
//                          after reflecting z -> -z if mirrored.
// A member is stored like any decal (an anchor on a part, a rotation). When
// one member is edited, every other member is placed again from it: its
// centre, normal and up are carried back to member 0 by the inverse motion
// and out to each member by that member's motion, and the member is put at
// the surface point nearest that place whose normal agrees. A copy of a
// decal on a fin of a ×4 fin set so lands on the same place, on the same
// side, of each fin; a mirror image lands on the fin's other side.
//
// A mirror image keeps the artwork's up (reflected), so lettering reads
// the right way round on it: its right is up x normal, which is the
// reflected right turned round, and the artwork is not flipped. With
// flipMirror the artwork is flipped as well, which makes the true mirror
// image (every point of the artwork lands on the reflection of its point).
//
// Every function returns a new document and leaves its input untouched.

import type { Vec3 } from '../geometry/vec3.ts';
import { cross } from '../geometry/vec3.ts';
import { applyToDirection, applyToPoint } from '../geometry/transform.ts';
import { aboutAxis } from '../geometry/mating.ts';
import type { Surface } from '../geometry/geodesic.ts';
import { nearestOnSurface, worldNormal, worldPoint } from '../geometry/geodesic.ts';
import { anchorOf, frameAt, frameOf, upOf } from '../geometry/decal-map.ts';
import type { AssemblyDocument } from './document.ts';
import { cloneDocument } from './document.ts';
import type { Decal, DecalSymmetry } from './decals.ts';
import { decalGroup, requireDecal } from './decals.ts';

// How far from the carried place a member may land (mm). The surfaces of a
// part symmetry set are exact copies, so a copy on a fin lands within a
// rounding error; a copy round a tube within the tessellation's sag.
const landingReach = 3;

// The copy counts the toolbar steps through (as for parts).
export const decalSymmetryChoices = [1, 2, 3, 4, 6, 8];

function reflect(v: Vec3): Vec3 {
  return [v[0], v[1], -v[2]];
}

// A member's motion applied to a point or a direction.
function memberPoint(p: Vec3, index: number, count: number, mirrored: boolean): Vec3 {
  const first = mirrored ? reflect(p) : p;
  return applyToPoint(aboutAxis((2 * Math.PI * index) / count), first);
}

function memberDirection(v: Vec3, index: number, count: number, mirrored: boolean): Vec3 {
  const first = mirrored ? reflect(v) : v;
  return applyToDirection(aboutAxis((2 * Math.PI * index) / count), first);
}

// The inverse: from a member back to member 0.
function backPoint(p: Vec3, index: number, count: number, mirrored: boolean): Vec3 {
  const turned = applyToPoint(aboutAxis((-2 * Math.PI * index) / count), p);
  return mirrored ? reflect(turned) : turned;
}

function backDirection(v: Vec3, index: number, count: number, mirrored: boolean): Vec3 {
  const turned = applyToDirection(aboutAxis((-2 * Math.PI * index) / count), v);
  return mirrored ? reflect(turned) : turned;
}

// What a member needs from member 0: its centre, normal and up (world).
interface Base {
  point: Vec3;
  normal: Vec3;
  up: Vec3;
  // Member 0's horizontal flip.
  flipX: boolean;
}

function baseOf(surface: Surface, decal: Decal): Base | null {
  const symmetry = decal.symmetry;
  if (symmetry === null) {
    throw new Error('baseOf: expected a decal in a symmetry set');
  }
  const frame = frameOf(surface, decal.anchor, decal.rotation);
  if (frame === null) {
    return null; // its part is hidden or gone
  }
  const point = worldPoint(surface, frame.at);
  const normal = worldNormal(surface, frame.at);
  const up = upOf(surface, frame);
  return {
    point: backPoint(point, symmetry.index, symmetry.count, symmetry.mirrored),
    normal: backDirection(normal, symmetry.index, symmetry.count, symmetry.mirrored),
    up: backDirection(up, symmetry.index, symmetry.count, symmetry.mirrored),
    flipX: decal.flipX !== (symmetry.mirrored && symmetry.flipMirror),
  };
}

// Where member (index, mirrored) of a set goes: its anchor, rotation and
// horizontal flip, or null if no surface is there.
function placeMember(surface: Surface, base: Base, settings: DecalSymmetry, index: number, mirrored: boolean): Pick<Decal, 'anchor' | 'rotation' | 'flipX'> | null {
  const point = memberPoint(base.point, index, settings.count, mirrored);
  const normal = memberDirection(base.normal, index, settings.count, mirrored);
  const up = memberDirection(base.up, index, settings.count, mirrored);
  const landed = nearestOnSurface(surface, point, normal, landingReach, null);
  if (landed === null) {
    return null;
  }
  // Right = up x normal: a right-handed frame on the member's side, so a
  // mirror image keeps the artwork's up and reads the right way round.
  const right = cross(up, normal);
  const frame = frameAt(surface, landed.at, right);
  if (frame === null) {
    return null;
  }
  const stored = anchorOf(surface, frame);
  return { anchor: stored.anchor, rotation: stored.rotation, flipX: base.flipX !== (mirrored && settings.flipMirror) };
}

// After an edit to `sourceId`, bring the other members of its set into
// line with it: the same artwork, size, flips, colours, name and state, at
// their places round the rocket. A member that finds no surface (its part
// is hidden, say) keeps its old place.
export function syncDecalGroup(doc: AssemblyDocument, surface: Surface, sourceId: string): AssemblyDocument {
  const source = requireDecal(doc, sourceId);
  if (source.symmetry === null) {
    return doc;
  }
  const next = cloneDocument(doc);
  const settings = source.symmetry;
  const base = baseOf(surface, source);
  const members = decalGroup(next, sourceId);
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (member.id === sourceId || member.symmetry === null) {
      continue;
    }
    member.name = source.name;
    member.artworkId = source.artworkId;
    member.width = source.width;
    member.height = source.height;
    member.flipY = source.flipY;
    member.hidden = source.hidden;
    member.locked = source.locked;
    member.colourMap = JSON.parse(JSON.stringify(source.colourMap)) as Record<string, string>;
    member.symmetry = {
      group: settings.group,
      count: settings.count,
      mirror: settings.mirror,
      flipMirror: settings.flipMirror,
      index: member.symmetry.index,
      mirrored: member.symmetry.mirrored,
    };
    if (base === null) {
      continue;
    }
    const placed = placeMember(surface, base, settings, member.symmetry.index, member.symmetry.mirrored);
    if (placed === null) {
      continue;
    }
    member.anchor = placed.anchor;
    member.rotation = placed.rotation;
    member.flipX = placed.flipX;
  }
  return next;
}

// Give a decal a new symmetry set: `count` copies round the axis, each with
// a mirror image if `mirror`. The decal itself becomes member 0 and the old
// members of its set are replaced. Copies that find no surface are not
// made; how many were wanted and how many made is returned.
export function setDecalSymmetry(
  doc: AssemblyDocument,
  surface: Surface,
  decalId: string,
  count: number,
  mirror: boolean,
  flipMirror: boolean,
): { doc: AssemblyDocument; wanted: number; made: number } {
  if (count < 1 || Math.floor(count) !== count) {
    throw new Error('setDecalSymmetry: count must be a whole number of at least 1, got ' + String(count));
  }
  const next = cloneDocument(doc);
  const source = requireDecal(next, decalId);
  // Take the old members out (not the decal itself).
  const old = decalGroup(next, decalId);
  const doomed = new Set<string>();
  // A copy that is made again in the same place in the set keeps its id
  // (and so stays selected, and stays the same in undo).
  const oldIds = new Map<string, string>();
  for (let i = 0; i < old.length; i++) {
    if (old[i].id !== decalId) {
      doomed.add(old[i].id);
      const member = old[i].symmetry;
      if (member !== null) {
        oldIds.set(String(member.index) + '|' + String(member.mirrored), old[i].id);
      }
    }
  }
  const kept: Decal[] = [];
  for (let i = 0; i < next.decals.length; i++) {
    if (!doomed.has(next.decals[i].id)) {
      kept.push(next.decals[i]);
    }
  }
  next.decals = kept;
  if (count === 1 && !mirror) {
    source.symmetry = null;
    return { doc: next, wanted: 1, made: 1 };
  }
  const group = 'g' + String(next.nextId);
  next.nextId = next.nextId + 1;
  // The source's flip as member 0 (it may have been a flipped mirror image).
  let baseFlip = source.flipX;
  if (source.symmetry !== null && source.symmetry.mirrored && source.symmetry.flipMirror) {
    baseFlip = !baseFlip;
  }
  source.flipX = baseFlip;
  source.symmetry = { group: group, count: count, mirror: mirror, flipMirror: flipMirror, index: 0, mirrored: false };
  const base = baseOf(surface, source);
  let wanted = 1;
  let made = 1;
  const copies: Decal[] = [];
  for (let k = 0; k < count; k++) {
    for (let m = 0; m < 2; m++) {
      const mirrored = m === 1;
      if (mirrored && !mirror) {
        continue;
      }
      if (k === 0 && !mirrored) {
        continue; // the source itself
      }
      wanted = wanted + 1;
      if (base === null) {
        continue;
      }
      const placed = placeMember(surface, base, source.symmetry, k, mirrored);
      if (placed === null) {
        continue;
      }
      const copy = JSON.parse(JSON.stringify(source)) as Decal;
      const kept = oldIds.get(String(k) + '|' + String(mirrored));
      if (kept !== undefined) {
        copy.id = kept;
      } else {
        copy.id = 'd' + String(next.nextId);
        next.nextId = next.nextId + 1;
      }
      copy.anchor = placed.anchor;
      copy.rotation = placed.rotation;
      copy.flipX = placed.flipX;
      copy.symmetry = { group: group, count: count, mirror: mirror, flipMirror: flipMirror, index: k, mirrored: mirrored };
      copies.push(copy);
      made = made + 1;
    }
  }
  if (made === 1) {
    // No copy found a place: it stays a decal on its own.
    source.symmetry = null;
    return { doc: next, wanted: wanted, made: made };
  }
  // The copies go directly above the source in the layer stack.
  const at = next.decals.indexOf(source);
  for (let i = 0; i < copies.length; i++) {
    next.decals.splice(at + 1 + i, 0, copies[i]);
  }
  return { doc: next, wanted: wanted, made: made };
}

// Take one decal out of its set; the others stay linked. A set left with
// one member is no set.
export function makeDecalUnique(doc: AssemblyDocument, decalId: string): AssemblyDocument {
  const next = cloneDocument(doc);
  const decal = requireDecal(next, decalId);
  if (decal.symmetry === null) {
    return next;
  }
  const members = decalGroup(next, decalId);
  decal.symmetry = null;
  const rest: Decal[] = [];
  for (let i = 0; i < members.length; i++) {
    if (members[i].id !== decalId) {
      rest.push(members[i]);
    }
  }
  if (rest.length === 1) {
    rest[0].symmetry = null;
  }
  return next;
}
