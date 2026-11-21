// The window's side of the page worker: one promise per build.

import type { Page } from '../geometry/page.ts';
import type { PageRequest, PageResponse, PageWorkerPart, PageWorkerPiece } from './page-protocol.ts';

export class PageBuilder {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (page: Page | null) => void; reject: (error: Error) => void }>();

  private start(): Worker {
    if (this.worker !== null) {
      return this.worker;
    }
    const worker = new Worker(new URL('./page-worker.ts', import.meta.url), { type: 'module' });
    const self = this;
    worker.onmessage = function onMessage(event: MessageEvent<PageResponse>) {
      const message = event.data;
      const entry = self.waiting.get(message.id);
      if (entry === undefined) {
        return;
      }
      self.waiting.delete(message.id);
      if (message.kind === 'page') {
        entry.resolve(message.page);
      } else {
        entry.reject(new Error(message.message));
      }
    };
    this.worker = worker;
    return worker;
  }

  // Build a page. `parts` are the meshes the worker has not been sent yet.
  build(parts: PageWorkerPart[], pieces: PageWorkerPiece[]): Promise<Page | null> {
    const worker = this.start();
    const id = this.nextId;
    this.nextId = this.nextId + 1;
    const self = this;
    const promise = new Promise<Page | null>(function wait(resolve, reject) {
      self.waiting.set(id, { resolve: resolve, reject: reject });
    });
    const request: PageRequest = { id: id, parts: parts, pieces: pieces };
    // Copied, not transferred: the window keeps using the meshes.
    worker.postMessage(request);
    return promise;
  }
}
