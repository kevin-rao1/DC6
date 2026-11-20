import { describe, expect, it } from 'vitest';
import { addParts, emptyDocument, removeParts } from '../src/model/document.ts';
import { addDecal, duplicateDecal, moveDecalLayer, removeDecal, setDecalColour, setPartColour, updateDecal } from '../src/model/decals.ts';
import type { NewDecal } from '../src/model/decals.ts';
import { History } from '../src/model/history.ts';
import { identityTransform } from '../src/geometry/transform.ts';

function decalOn(placedId: string, name: string): NewDecal {
  return {
    name: name,
    artworkId: 'a1',
    anchor: { placedId: placedId, triangle: 3, barycentric: [0.2, 0.3, 0.5], position: [0, 0, 33], normal: [0, 0, 1] },
    rotation: 0,
    width: 40,
    height: 20,
    flipX: false,
    flipY: false,
    hidden: false,
    locked: false,
    colourMap: {},
    symmetry: null,
  };
}

describe('decals in the document', () => {
  it('adds, orders, duplicates, edits and removes decals without touching the input', () => {
    let doc = addParts(emptyDocument(), { partId: 'tube', transforms: [identityTransform()], parentId: null, joint: null }).doc;
    const tube = doc.placed[0].id;
    const first = addDecal(doc, decalOn(tube, 'one'));
    const second = addDecal(first.doc, decalOn(tube, 'two'));
    doc = second.doc;
    expect(first.doc.decals.length).toBe(1);
    expect(doc.decals.map((d) => d.name)).toEqual(['one', 'two']);
    doc = moveDecalLayer(doc, first.id, 1);
    expect(doc.decals.map((d) => d.name)).toEqual(['two', 'one']);
    const copy = duplicateDecal(doc, second.id);
    expect(copy.doc.decals.map((d) => d.name)).toEqual(['two', 'two copy', 'one']);
    doc = updateDecal(copy.doc, copy.id, { width: 80, rotation: 1 });
    expect(doc.decals[1].width).toBe(80);
    expect(copy.doc.decals[1].width).toBe(40);
    doc = setDecalColour(doc, copy.id, '#000000', '#123456');
    expect(doc.vinylColours).toEqual(['#123456']);
    doc = setDecalColour(doc, copy.id, '#000000', '#e64097');
    expect(doc.vinylColours).toEqual(['#123456']); // presets are not added
    doc = removeDecal(doc, copy.id);
    expect(doc.decals.length).toBe(2);
  });

  it('removing a part removes the decals stuck on it; undo brings both back', () => {
    const history = new History(emptyDocument());
    const added = addParts(history.document, { partId: 'tube', transforms: [identityTransform()], parentId: null, joint: null });
    history.commit(added.doc);
    history.commit(addDecal(history.document, decalOn(added.ids[0], 'one')).doc);
    history.commit(setPartColour(history.document, added.ids[0], '#ffffff'));
    expect(history.document.partColours[added.ids[0]]).toBe('#ffffff');
    history.commit(removeParts(history.document, [added.ids[0]]));
    expect(history.document.decals.length).toBe(0);
    history.undo();
    expect(history.document.decals.length).toBe(1);
  });
});
