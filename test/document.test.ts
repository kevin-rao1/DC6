import { describe, expect, it } from 'vitest';
import { addParts, emptyDocument, movePart, removeParts, requirePlaced, setHidden, symmetryMembers } from '../src/model/document.ts';
import { History } from '../src/model/history.ts';
import { identityTransform, applyToPoint } from '../src/geometry/transform.ts';
import type { RigidTransform } from '../src/geometry/transform.ts';
import { symmetryTransforms, distanceFromAxis } from '../src/geometry/mating.ts';
import { distance } from '../src/geometry/vec3.ts';

function at(x: number, y: number, z: number): RigidTransform {
  return { position: [x, y, z], rotation: [0, 0, 0, 1] };
}

describe('assembly document', () => {
  it('makes the first part the root and moves children with their parent', () => {
    let doc = emptyDocument();
    const rootAdd = addParts(doc, { partId: 'tube', transforms: [identityTransform()], parentId: null, joint: null });
    doc = rootAdd.doc;
    expect(doc.rootId).toBe(rootAdd.ids[0]);
    const childAdd = addParts(doc, { partId: 'nose', transforms: [at(-260, 0, 0)], parentId: rootAdd.ids[0], joint: { ownFace: 0, parentFace: 1 } });
    doc = childAdd.doc;
    const moved = movePart(doc, rootAdd.ids[0], at(0, 10, 0));
    expect(requirePlaced(moved, childAdd.ids[0]).transform.position).toEqual([-260, 10, 0]);
    // The input document is unchanged.
    expect(requirePlaced(doc, childAdd.ids[0]).transform.position).toEqual([-260, 0, 0]);
    const removed = removeParts(moved, [rootAdd.ids[0]]);
    expect(removed.placed.length).toBe(0);
    expect(removed.rootId).toBeNull();
  });

  it('keeps symmetry members linked when one is moved or hidden', () => {
    let doc = addParts(emptyDocument(), { partId: 'tube', transforms: [identityTransform()], parentId: null, joint: null }).doc;
    const fins = addParts(doc, { partId: 'fin', transforms: symmetryTransforms(at(50, 33, 0), 4), parentId: doc.rootId, joint: { ownFace: 2, parentFace: null } });
    doc = fins.doc;
    expect(symmetryMembers(doc, fins.ids[2]).length).toBe(4);
    // Move member 2; all four follow, still evenly spaced.
    doc = movePart(doc, fins.ids[2], symmetryTransforms(at(80, 40, 0), 4)[2]);
    const probe: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const placed = requirePlaced(doc, fins.ids[k]);
      const expected = symmetryTransforms(at(80, 40, 0), 4)[k];
      expect(distance(applyToPoint(placed.transform, probe), applyToPoint(expected, probe))).toBeLessThan(1e-9);
      expect(distanceFromAxis(placed.transform.position)).toBeCloseTo(40, 9);
    }
    doc = setHidden(doc, fins.ids[1], true);
    for (let k = 0; k < 4; k++) {
      expect(requirePlaced(doc, fins.ids[k]).hidden).toBe(true);
    }
  });

  it('undoes and redoes', () => {
    const history = new History(emptyDocument());
    const first = addParts(history.document, { partId: 'a', transforms: [identityTransform()], parentId: null, joint: null });
    history.commit(first.doc);
    const second = addParts(history.document, { partId: 'b', transforms: [at(1, 0, 0)], parentId: null, joint: null });
    history.commit(second.doc);
    expect(history.document.placed.length).toBe(2);
    expect(history.undo()).toBe(true);
    expect(history.document.placed.length).toBe(1);
    expect(history.undo()).toBe(true);
    expect(history.document.placed.length).toBe(0);
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(true);
    expect(history.document.placed.length).toBe(1);
    // A new edit drops the redo branch.
    history.commit(addParts(history.document, { partId: 'c', transforms: [at(2, 0, 0)], parentId: null, joint: null }).doc);
    expect(history.canRedo()).toBe(false);
    expect(history.document.placed.map((p) => p.partId)).toEqual(['a', 'c']);
  });
});

describe('history replace', () => {
  it('adjusting the last step keeps it one undo step', () => {
    const history = new History(emptyDocument());
    history.commit(addParts(history.document, { partId: 'a', transforms: [identityTransform()], parentId: null, joint: null }).doc);
    const id = history.document.placed[0].id;
    history.commit(movePart(history.document, id, at(10, 0, 0)));
    history.replace(movePart(history.document, id, at(12, 0, 0)));
    expect(requirePlaced(history.document, id).transform.position).toEqual([12, 0, 0]);
    expect(history.undo()).toBe(true);
    expect(requirePlaced(history.document, id).transform.position).toEqual([0, 0, 0]);
  });
});
