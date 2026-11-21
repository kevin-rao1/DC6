// Messages between the page and the import worker.

import type { Part } from '../geometry/part.ts';

export interface ImportRequest {
  id: number;
  fileName: string;
  bytes: ArrayBuffer;
}

export type ImportResponse =
  | { kind: 'ready' }
  | { kind: 'parts'; id: number; parts: Part[] }
  | { kind: 'error'; id: number; message: string };
