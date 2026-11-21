// STEP file -> finished parts. The one entry point the import worker and the
// tests call.

import type { Occ } from './occ.ts';
import type { Part } from './part.ts';
import { importStep } from './step-import.ts';
import { buildPart } from './build-part.ts';

export function importParts(oc: Occ, bytes: Uint8Array, fileName: string): Part[] {
  const imported = importStep(oc, bytes, fileName);
  const parts: Part[] = [];
  for (let i = 0; i < imported.parts.length; i++) {
    const part = buildPart(imported.parts[i], fileName, i, imported.sourceUnit);
    parts.push(part);
  }
  return parts;
}
