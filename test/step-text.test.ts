// Reading names and units from the STEP text.

import { describe, expect, it } from 'vitest';
import { decodeStepString, readLengthUnit, solidOwners } from '../src/geometry/step-text.ts';
import { readModelText } from './models.ts';

describe('STEP text', () => {
  it('reads the length unit the file declares', () => {
    expect(readLengthUnit(readModelText('cone')).name).toBe('inch');
    expect(readLengthUnit(readModelText('cone')).millimetresPerUnit).toBe(25.4);
    expect(readLengthUnit(readModelText('rocket-assembly')).name).toBe('millimetre');
    expect(readLengthUnit(readModelText('rocket-assembly')).millimetresPerUnit).toBe(1);
  });

  it('decodes escaped strings', () => {
    expect(decodeStepString("it''s")).toBe("it's");
    expect(decodeStepString('\\X2\\00E9\\X0\\t\\X2\\00E9\\X0\\')).toBe('été');
    expect(decodeStepString('\\X\\E9')).toBe('é');
  });

  it('lists one named owner per solid of the assembly, in reader order', () => {
    const owners = solidOwners(readModelText('rocket-assembly'));
    const names: string[] = [];
    for (let i = 0; i < owners.length; i++) {
      names.push(String(owners[i].productName));
    }
    expect(names).toEqual([
      'nose cone',
      'body tube',
      'boattail',
      'fin',
      'fin',
      'fin',
      'fin',
      'canard',
      'canard',
      'canard',
      'canard',
    ]);
    expect(owners[3].instanceName).toBe('fin:1');
    expect(owners[6].instanceName).toBe('fin:4');
  });

  it('names the single product of a one-part file', () => {
    const owners = solidOwners(readModelText('rocket-fused'));
    expect(owners.length).toBe(1);
  });
});
