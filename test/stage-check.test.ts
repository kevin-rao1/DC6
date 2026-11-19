// The stage 1 check from the brief, section 6:
// "a test assembly with internals shows only the outer shell; four fins are
// reported as four instances of one part."

import { describe, expect, it } from 'vitest';
import { loadModel } from './models.ts';

describe('stage 1 check', () => {
  it('the internals assembly shows only the outer shell, and four fins are four instances of one part', async () => {
    const model = await loadModel('rocket-internals');

    // Only the outer shell is shown: every shown triangle belongs to an
    // airframe part, and no face of the motor tube or sled is shown.
    const shownPartNames = new Set<string>();
    for (let t = 0; t < model.mesh.triangleFace.length; t++) {
      if (model.topology.included[t] === 1) {
        const part = model.parts[model.faces[model.mesh.triangleFace[t]].part];
        shownPartNames.add(part.productName as string);
      }
    }
    expect(Array.from(shownPartNames).sort()).toEqual(['boattail', 'body tube', 'canard', 'fin', 'nose cone']);

    // Four fins as four instances of one part.
    let finSet = null;
    for (let i = 0; i < model.instanceSets.length; i++) {
      if (model.instanceSets[i].name === 'fin') {
        finSet = model.instanceSets[i];
      }
    }
    expect(finSet).not.toBeNull();
    if (finSet !== null) {
      expect(finSet.members.length).toBe(4);
      const productNames = new Set<string>();
      for (let k = 0; k < finSet.members.length; k++) {
        expect(finSet.members[k].partIds.length).toBe(1);
        productNames.add(model.parts[finSet.members[k].partIds[0]].productName as string);
      }
      expect(Array.from(productNames)).toEqual(['fin']);
    }
  });
});

describe('stability', () => {
  it('loading the same file twice gives the same axis, parts and instances', async () => {
    const { loadOcc } = await import('../src/geometry/occ.ts');
    const { importStep } = await import('../src/geometry/step-import.ts');
    const { buildModel } = await import('../src/geometry/model.ts');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { modelFolder } = await import('./models.ts');
    const oc = await loadOcc();
    const bytes = new Uint8Array(readFileSync(join(modelFolder, 'rocket-fused.step')));
    const first = buildModel(importStep(oc, bytes, 'a'));
    const second = buildModel(importStep(oc, bytes, 'a'));
    expect(second.axis).toEqual(first.axis);
    expect(second.mesh.triangleFace.length).toBe(first.mesh.triangleFace.length);
    expect(second.instanceSets).toEqual(first.instanceSets);
    let identical = true;
    for (let i = 0; i < first.mesh.positions.length; i++) {
      if (first.mesh.positions[i] !== second.mesh.positions[i]) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(true);
  });
});
