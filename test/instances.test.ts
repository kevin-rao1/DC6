// Repeated parts around the axis.

import { describe, expect, it } from 'vitest';
import type { DcModel } from '../src/geometry/types.ts';
import { transformPoint } from '../src/geometry/vec3.ts';
import { triangleAreaOf } from '../src/geometry/mesh.ts';
import { loadModel } from './models.ts';

function setNamed(model: DcModel, name: string): DcModel['instanceSets'][number] {
  for (let i = 0; i < model.instanceSets.length; i++) {
    if (model.instanceSets[i].name === name) {
      return model.instanceSets[i];
    }
  }
  throw new Error('no instance set named ' + name + ' in ' + model.fileName);
}

const rockets = ['rocket-assembly', 'rocket-fused', 'rocket-internals', 'rocket-long'];

describe('repeated parts', () => {
  for (let i = 0; i < rockets.length; i++) {
    const name = rockets[i];
    it(name + ': four instances of fin and four instances of canard, evenly spaced', async () => {
      const model = await loadModel(name);
      expect(model.instanceSets.length).toBe(2);
      const fins = setNamed(model, 'fin');
      const canards = setNamed(model, 'canard');
      expect(fins.members.length).toBe(4);
      expect(canards.members.length).toBe(4);
      expect(fins.evenlySpaced).toBe(true);
      expect(canards.evenlySpaced).toBe(true);
      // Canards sit 45 degrees from the fins in every model.
      let offset = canards.members[0].rollDegrees - fins.members[0].rollDegrees;
      offset = ((offset % 90) + 90) % 90;
      expect(offset).toBeCloseTo(45, 1);
    });
  }

  it('in the assembly each fin instance is one fin part', async () => {
    const model = await loadModel('rocket-assembly');
    const fins = setNamed(model, 'fin');
    const partNames: string[] = [];
    for (let k = 0; k < fins.members.length; k++) {
      expect(fins.members[k].partIds.length).toBe(1);
      partNames.push(model.parts[fins.members[k].partIds[0]].name);
    }
    partNames.sort();
    expect(partNames).toEqual(['fin #1', 'fin #2', 'fin #3', 'fin #4']);
  });

  it('in the fused solid the fins are found from geometry alone', async () => {
    const model = await loadModel('rocket-fused');
    expect(model.parts.length).toBe(1);
    const fins = setNamed(model, 'fin');
    for (let k = 0; k < fins.members.length; k++) {
      expect(fins.members[k].partIds).toEqual([0]);
      expect(fins.members[k].faceIds.length).toBeGreaterThan(5);
    }
  });

  it('roll angles on the Z-axis assembly are the CAD placements', async () => {
    const model = await loadModel('rocket-assembly');
    const fins = setNamed(model, 'fin');
    // The frame's reference direction for a +Z axis is +X; fins are at 0, 90,
    // 180, 270. The roll is that of the fin's area centroid, which the
    // tessellation of the fillets moves by a few thousandths of a degree.
    const expected = [0, 90, 180, 270];
    for (let k = 0; k < fins.members.length; k++) {
      expect(Math.abs(fins.members[k].rollDegrees - expected[k])).toBeLessThan(0.01);
    }
  });

  it('the transform from the first instance maps its centroid onto each other instance', async () => {
    const model = await loadModel('rocket-fused');
    const fins = setNamed(model, 'fin');
    const mesh = model.mesh;
    // Area-weighted centroid (a vertex average would be skewed by the dense
    // tessellation at one fin's degenerate fillet corner).
    function centroidOf(faceIds: number[]): [number, number, number] {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let totalArea = 0;
      const p = mesh.positions;
      for (let i = 0; i < faceIds.length; i++) {
        const face = model.faces[faceIds[i]];
        for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t++) {
          const a = mesh.triangles[3 * t];
          const b = mesh.triangles[3 * t + 1];
          const c = mesh.triangles[3 * t + 2];
          const area = triangleAreaOf(p, a, b, c);
          sx = sx + (area * (p[3 * a] + p[3 * b] + p[3 * c])) / 3;
          sy = sy + (area * (p[3 * a + 1] + p[3 * b + 1] + p[3 * c + 1])) / 3;
          sz = sz + (area * (p[3 * a + 2] + p[3 * b + 2] + p[3 * c + 2])) / 3;
          totalArea = totalArea + area;
        }
      }
      return [sx / totalArea, sy / totalArea, sz / totalArea];
    }
    const first = centroidOf(fins.members[0].faceIds);
    for (let k = 1; k < fins.members.length; k++) {
      const moved = transformPoint(fins.members[k].transformFromFirst, first);
      const target = centroidOf(fins.members[k].faceIds);
      const dx = moved[0] - target[0];
      const dy = moved[1] - target[1];
      const dz = moved[2] - target[2];
      // Centroids of two tessellations (and one slightly different fillet)
      // differ a little; 0.5 mm is far below the 90-degree spacing (about
      // 135 mm between fin centroids).
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThan(0.5);
    }
  });
});
