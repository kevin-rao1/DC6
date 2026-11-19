// Messages between the page and the import worker.

import type { DcModel } from '../geometry/types.ts';

export interface ImportRequest {
  type: 'import';
  fileName: string;
  bytes: ArrayBuffer;
}

export type WorkerReply =
  | { type: 'status'; text: string }
  | { type: 'result'; model: DcModel; workerMs: number }
  | { type: 'error'; message: string };

// The typed arrays of a model, so they can be transferred instead of copied.
export function transferablesOf(model: DcModel): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const arrays = [
    model.mesh.positions,
    model.mesh.triangles,
    model.mesh.cornerNormals,
    model.mesh.triangleFace,
    model.topology.included,
    model.topology.neighbours,
    model.topology.component,
  ];
  for (let i = 0; i < arrays.length; i++) {
    const buffer = arrays[i].buffer;
    // Each array owns its buffer (they are made with slice() or new), so
    // transferring one never takes another's data.
    if (buffer instanceof ArrayBuffer && !buffers.includes(buffer)) {
      buffers.push(buffer);
    }
  }
  return buffers;
}
