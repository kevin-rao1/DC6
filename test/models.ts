// Shared helpers for the tests: load the checked-in test models once.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOcc } from '../src/geometry/occ.ts';
import { importStep } from '../src/geometry/step-import.ts';
import type { CadImport } from '../src/geometry/step-import.ts';
import { buildModel } from '../src/geometry/model.ts';
import type { DcModel, Vec3 } from '../src/geometry/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const modelFolder = join(here, '..', 'test-models');

export interface ManifestEntry {
  file: string;
  description: string;
  axis: Vec3;
  axisPoint: Vec3;
  noseKnown: boolean;
  unit: string;
  faceCount: number;
  structure: 'single' | 'assembly';
}

export const manifest: ManifestEntry[] = JSON.parse(readFileSync(join(modelFolder, 'manifest.json'), 'utf8'));

export function manifestEntry(name: string): ManifestEntry {
  for (let i = 0; i < manifest.length; i++) {
    if (manifest[i].file === name + '.step') {
      return manifest[i];
    }
  }
  throw new Error('no manifest entry for ' + name);
}

export function readModelText(name: string): string {
  return readFileSync(join(modelFolder, name + '.step'), 'latin1');
}

const cadCache = new Map<string, CadImport>();
const modelCache = new Map<string, DcModel>();

export async function loadCad(name: string): Promise<CadImport> {
  const cached = cadCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const oc = await loadOcc();
  const bytes = readFileSync(join(modelFolder, name + '.step'));
  const cad = importStep(oc, new Uint8Array(bytes), name + '.step');
  cadCache.set(name, cad);
  return cad;
}

export async function loadModel(name: string): Promise<DcModel> {
  const cached = modelCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const cad = await loadCad(name);
  const model = buildModel(cad);
  modelCache.set(name, model);
  return model;
}

export function partNamed(model: DcModel, name: string): number {
  for (let p = 0; p < model.parts.length; p++) {
    if (model.parts[p].name === name) {
      return p;
    }
  }
  throw new Error('no part named ' + name + ' in ' + model.fileName);
}
