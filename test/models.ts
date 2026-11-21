// Loading the checked-in test parts once per test file.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOcc } from '../src/geometry/occ.ts';
import { importParts } from '../src/geometry/import-parts.ts';
import type { Part } from '../src/geometry/part.ts';

const here = dirname(fileURLToPath(import.meta.url));

export function modelBytes(name: string): Uint8Array {
  return readFileSync(join(here, '..', 'test-models', name + '.step'));
}

const cache = new Map<string, Part[]>();

export async function loadModel(name: string): Promise<Part[]> {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const oc = await loadOcc();
  const parts = importParts(oc, modelBytes(name), name + '.step');
  cache.set(name, parts);
  return parts;
}

export async function loadPart(name: string): Promise<Part> {
  const parts = await loadModel(name);
  if (parts.length !== 1) {
    throw new Error('expected one part in ' + name + ', found ' + String(parts.length));
  }
  return parts[0];
}
