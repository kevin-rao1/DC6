// Welding and stitching: closed parts, one connected and consistently
// oriented exterior where the parts are one solid, contact links where
// separate parts touch.

import { describe, expect, it } from 'vitest';
import type { DcModel } from '../src/geometry/types.ts';
import { SurfaceKind } from '../src/geometry/types.ts';
import { openEdgeCountOfPart } from '../src/geometry/topology.ts';
import { loadModel, partNamed } from './models.ts';

// Open edges (used by one triangle) over the whole mesh, with their lengths
// and faces.
function openEdges(model: DcModel): Array<{ length: number; face: number }> {
  const mesh = model.mesh;
  const vertexCount = mesh.positions.length / 3;
  const uses = new Map<number, number[]>();
  for (let t = 0; t < mesh.triangleFace.length; t++) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.triangles[3 * t + k];
      const b = mesh.triangles[3 * t + ((k + 1) % 3)];
      let key = b * vertexCount + a;
      if (a < b) {
        key = a * vertexCount + b;
      }
      let list = uses.get(key);
      if (list === undefined) {
        list = [];
        uses.set(key, list);
      }
      list.push(t);
    }
  }
  const result: Array<{ length: number; face: number }> = [];
  for (const entry of uses) {
    if (entry[1].length !== 1) {
      continue;
    }
    const a = Math.floor(entry[0] / vertexCount);
    const b = entry[0] - a * vertexCount;
    const dx = mesh.positions[3 * a] - mesh.positions[3 * b];
    const dy = mesh.positions[3 * a + 1] - mesh.positions[3 * b + 1];
    const dz = mesh.positions[3 * a + 2] - mesh.positions[3 * b + 2];
    result.push({ length: Math.sqrt(dx * dx + dy * dy + dz * dz), face: mesh.triangleFace[entry[1][0]] });
  }
  return result;
}

function componentsOfPart(model: DcModel, partId: number): Set<number> {
  const set = new Set<number>();
  for (let t = 0; t < model.mesh.triangleFace.length; t++) {
    const component = model.topology.component[t];
    if (component < 0) {
      continue;
    }
    if (model.faces[model.mesh.triangleFace[t]].part === partId) {
      set.add(component);
    }
  }
  return set;
}

describe('single solids are closed and their exterior is one oriented piece', () => {
  const names = ['cylinder-two-halves', 'cone', 'ogive-nose', 'spline-body'];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    it(name, async () => {
      const model = await loadModel(name);
      expect(openEdgeCountOfPart(model.mesh, model.faces, model.parts[0])).toBe(0);
      expect(model.topology.componentCount).toBe(1);
      expect(model.topology.nonManifoldEdgeCount).toBe(0);
      expect(model.topology.inconsistentEdgeCount).toBe(0);
    });
  }

  it('the two half cylinders are stitched to each other along both seams', async () => {
    const model = await loadModel('cylinder-two-halves');
    // Every edge between the two cylinder faces has a neighbour across it:
    // count triangles of one half that have a neighbour in the other half.
    const cylinderFaces: number[] = [];
    for (let f = 0; f < model.faces.length; f++) {
      if (model.faces[f].surface.kind === SurfaceKind.Cylinder) {
        cylinderFaces.push(f);
      }
    }
    expect(cylinderFaces.length).toBe(2);
    let crossings = 0;
    const first = model.faces[cylinderFaces[0]];
    for (let t = first.triangleStart; t < first.triangleStart + first.triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const other = model.topology.neighbours[3 * t + k];
        if (other >= 0 && model.mesh.triangleFace[other] === cylinderFaces[1]) {
          crossings = crossings + 1;
        }
      }
    }
    // Two straight seams of one segment each at least.
    expect(crossings).toBeGreaterThanOrEqual(2);
  });
});

describe('fused rocket', () => {
  it('has one connected, manifold, consistently oriented exterior', async () => {
    const model = await loadModel('rocket-fused');
    expect(model.topology.componentCount).toBe(1);
    expect(model.topology.nonManifoldEdgeCount).toBe(0);
    expect(model.topology.inconsistentEdgeCount).toBe(0);
  });

  it('has open edges only as micro-cracks in fillet faces (known OCCT tessellation weakness)', async () => {
    // OpenCascade's tessellation of one degenerate fillet corner leaves a few
    // short open edges whose ends do not coincide. This test pins down that
    // they stay small and confined to fillets; it does not claim the part is
    // watertight.
    const model = await loadModel('rocket-fused');
    const open = openEdges(model);
    let total = 0;
    for (let i = 0; i < open.length; i++) {
      total = total + open[i].length;
      expect(open[i].length).toBeLessThan(0.3);
      expect(model.faces[open[i].face].surface.kind).toBe(SurfaceKind.Freeform);
    }
    // Measured when this test was written: 44 edges, 5.0 mm in total. The
    // limit is that plus a margin; it is a fence around a known defect, not a
    // target.
    expect(total).toBeLessThan(6);
  });
});

describe('assembly', () => {
  it('nose, tube and boattail exterior are stitched into one piece; fins and canards are separate pieces', async () => {
    const model = await loadModel('rocket-assembly');
    const nose = componentsOfPart(model, partNamed(model, 'nose cone'));
    const tube = componentsOfPart(model, partNamed(model, 'body tube'));
    const boattail = componentsOfPart(model, partNamed(model, 'boattail'));
    expect(nose.size).toBe(1);
    expect(Array.from(tube)).toEqual(Array.from(nose));
    expect(Array.from(boattail)).toEqual(Array.from(nose));
    // 1 body + 4 fins + 4 canards.
    expect(model.topology.componentCount).toBe(9);
    expect(model.topology.inconsistentEdgeCount).toBe(0);
  });

  it('records contact links from every fin and canard to the body tube', async () => {
    const model = await loadModel('rocket-assembly');
    const tube = partNamed(model, 'body tube');
    const names = ['fin #1', 'fin #2', 'fin #3', 'fin #4', 'canard #1', 'canard #2', 'canard #3', 'canard #4'];
    for (let i = 0; i < names.length; i++) {
      const part = partNamed(model, names[i]);
      let links = 0;
      for (let c = 0; c < model.topology.contacts.length; c++) {
        const contact = model.topology.contacts[c];
        const ownPart = model.faces[model.mesh.triangleFace[contact.triangle]].part;
        if (ownPart === part) {
          expect(contact.otherPart).toBe(tube);
          expect(contact.distance).toBeLessThan(0.2);
          links = links + 1;
        }
      }
      expect(links).toBeGreaterThan(0);
    }
  });

  it('every part is closed, except for slivers at degenerate fillet corners', async () => {
    const model = await loadModel('rocket-assembly');
    for (let p = 0; p < model.parts.length; p++) {
      const open = openEdgeCountOfPart(model.mesh, model.faces, model.parts[p]);
      if (model.parts[p].productName === 'fin') {
        // Known: OCCT leaves a 5 micrometre sliver at one fillet corner of
        // some fin placements (see mesh.ts). Pin it down so it cannot grow.
        expect(open).toBeLessThanOrEqual(4);
      } else {
        expect(open).toBe(0);
      }
    }
    const nonManifoldShort = model.topology.nonManifoldEdgeCount;
    expect(nonManifoldShort).toBeLessThanOrEqual(2);
  });
});
