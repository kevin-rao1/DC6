// Decals in the document: a flat piece of vinyl stuck on at an anchor.
//
// A decal is stored as where it is stuck (an anchor on a placed part), how
// it is turned about the surface normal there, its size in millimetres, its
// flips, and which artwork it shows. Never as coordinates on a page: the
// page and the cut file are computed from this.
//
// The artwork itself (the SVG's shapes) is not in the document but in the
// editor's artwork library, referenced by id, the way placed parts reference
// loaded parts. The document is copied whole for every undo step and for
// every preview frame while something is dragged; the artwork never changes,
// so it is kept once. The project file (a later stage) writes the library
// beside the document.
//
// Every function returns a new document and leaves its input untouched.

import type { SurfaceAnchor } from '../geometry/decal-map.ts';
import type { AssemblyDocument } from './document.ts';
import { cloneDocument, symmetryMembers } from './document.ts';

export interface Decal {
  id: string;
  name: string;
  artworkId: string;
  anchor: SurfaceAnchor;
  // Radians about the outward surface normal, counterclockwise seen from
  // outside, from the default orientation (artwork up = world up as seen on
  // the surface; see defaultUp in decal-map.ts).
  rotation: number;
  // The size of the artwork's bounding box on the rocket, mm.
  width: number;
  height: number;
  flipX: boolean;
  flipY: boolean;
  hidden: boolean;
  locked: boolean;
  // Artwork colour -> vinyl colour, for colours the user has remapped.
  colourMap: Record<string, string>;
}

// The vinyl colours always offered.
export const presetVinyl: Array<{ name: string; colour: string }> = [
  { name: 'cerise', colour: '#e64097' },
  { name: 'black', colour: '#000000' },
];

export function findDecal(doc: AssemblyDocument, id: string): Decal | null {
  for (let i = 0; i < doc.decals.length; i++) {
    if (doc.decals[i].id === id) {
      return doc.decals[i];
    }
  }
  return null;
}

export function requireDecal(doc: AssemblyDocument, id: string): Decal {
  const decal = findDecal(doc, id);
  if (decal === null) {
    throw new Error('expected a decal with id ' + id);
  }
  return decal;
}

function decalIndex(doc: AssemblyDocument, id: string): number {
  for (let i = 0; i < doc.decals.length; i++) {
    if (doc.decals[i].id === id) {
      return i;
    }
  }
  throw new Error('expected a decal with id ' + id);
}

// What a new decal needs; the id is given by the document.
export type NewDecal = Omit<Decal, 'id'>;

// Add a decal on top of the others. Returns the new document and its id.
export function addDecal(doc: AssemblyDocument, decal: NewDecal): { doc: AssemblyDocument; id: string } {
  const next = cloneDocument(doc);
  const id = 'd' + String(next.nextId);
  next.nextId = next.nextId + 1;
  const added: Decal = JSON.parse(JSON.stringify(Object.assign({ id: id }, decal))) as Decal;
  next.decals.push(added);
  return { doc: next, id: id };
}

// Change some fields of a decal.
export function updateDecal(doc: AssemblyDocument, id: string, changes: Partial<NewDecal>): AssemblyDocument {
  const next = cloneDocument(doc);
  const decal = requireDecal(next, id);
  const copied = JSON.parse(JSON.stringify(changes)) as Partial<NewDecal>;
  Object.assign(decal, copied);
  return next;
}

export function removeDecal(doc: AssemblyDocument, id: string): AssemblyDocument {
  const next = cloneDocument(doc);
  const index = decalIndex(next, id);
  next.decals.splice(index, 1);
  return next;
}

// Put a decal at layer `index` (0 = bottom).
export function moveDecalLayer(doc: AssemblyDocument, id: string, index: number): AssemblyDocument {
  const next = cloneDocument(doc);
  const from = decalIndex(next, id);
  const decal = next.decals[from];
  next.decals.splice(from, 1);
  const to = Math.max(0, Math.min(next.decals.length, index));
  next.decals.splice(to, 0, decal);
  return next;
}

// A copy of a decal, directly above it, named "name copy".
export function duplicateDecal(doc: AssemblyDocument, id: string): { doc: AssemblyDocument; id: string } {
  const next = cloneDocument(doc);
  const from = decalIndex(next, id);
  const original = next.decals[from];
  const copy = JSON.parse(JSON.stringify(original)) as Decal;
  copy.id = 'd' + String(next.nextId);
  next.nextId = next.nextId + 1;
  copy.name = original.name + ' copy';
  copy.locked = false;
  copy.hidden = false;
  next.decals.splice(from + 1, 0, copy);
  return { doc: next, id: copy.id };
}

export function setDecalColour(doc: AssemblyDocument, id: string, artworkColour: string, vinyl: string): AssemblyDocument {
  const next = cloneDocument(doc);
  const decal = requireDecal(next, id);
  decal.colourMap[artworkColour] = vinyl;
  if (next.vinylColours.indexOf(vinyl) < 0 && !isPreset(vinyl)) {
    next.vinylColours.push(vinyl);
  }
  return next;
}

export function addVinylColour(doc: AssemblyDocument, colour: string): AssemblyDocument {
  const next = cloneDocument(doc);
  if (next.vinylColours.indexOf(colour) < 0 && !isPreset(colour)) {
    next.vinylColours.push(colour);
  }
  return next;
}

function isPreset(colour: string): boolean {
  for (let i = 0; i < presetVinyl.length; i++) {
    if (presetVinyl[i].colour === colour) {
      return true;
    }
  }
  return false;
}

// The preview colour of a placed part (and its symmetry partners); null
// puts back the plain part grey.
export function setPartColour(doc: AssemblyDocument, placedId: string, colour: string | null): AssemblyDocument {
  const next = cloneDocument(doc);
  const members = symmetryMembers(next, placedId);
  for (let i = 0; i < members.length; i++) {
    if (colour === null) {
      delete next.partColours[members[i].id];
    } else {
      next.partColours[members[i].id] = colour;
    }
  }
  return next;
}

// The vinyl colour an artwork colour is cut in for this decal.
export function vinylFor(decal: Decal, artworkColour: string): string {
  const mapped = decal.colourMap[artworkColour];
  if (mapped === undefined) {
    return artworkColour;
  }
  return mapped;
}
