// The page side of the import worker: one promise per file.

import type { Part } from '../geometry/part.ts';
import type { ImportRequest, ImportResponse } from './worker-protocol.ts';

export class Importer {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (parts: Part[]) => void; reject: (error: Error) => void }>();
  ready = false;

  constructor() {
    this.worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' });
    const self = this;
    this.worker.onmessage = function onMessage(event: MessageEvent<ImportResponse>) {
      const message = event.data;
      if (message.kind === 'ready') {
        self.ready = true;
        return;
      }
      const entry = self.waiting.get(message.id);
      if (entry === undefined) {
        return;
      }
      self.waiting.delete(message.id);
      if (message.kind === 'parts') {
        entry.resolve(message.parts);
      } else {
        entry.reject(new Error(message.message));
      }
    };
  }

  pendingCount(): number {
    return this.waiting.size;
  }

  importFile(fileName: string, bytes: ArrayBuffer): Promise<Part[]> {
    const id = this.nextId;
    this.nextId = this.nextId + 1;
    const self = this;
    const promise = new Promise<Part[]>(function start(resolve, reject) {
      self.waiting.set(id, { resolve: resolve, reject: reject });
    });
    const request: ImportRequest = { id: id, fileName: fileName, bytes: bytes };
    this.worker.postMessage(request, [bytes]);
    return promise;
  }
}
