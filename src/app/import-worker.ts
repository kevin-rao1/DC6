// Web Worker that owns OpenCascade. It starts loading the wasm (about 23 MB)
// as soon as it starts, so the first file dropped imports without waiting
// for the download if the user takes a moment.

import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { loadOcc } from '../geometry/occ.ts';
import { importParts } from '../geometry/import-parts.ts';
import type { ImportRequest, ImportResponse } from './worker-protocol.ts';

const occReady = loadOcc({ wasmUrl: wasmUrl });

occReady.then(
  function announce() {
    const message: ImportResponse = { kind: 'ready' };
    self.postMessage(message);
  },
  function failed(error: unknown) {
    const message: ImportResponse = { kind: 'error', id: -1, message: 'OpenCascade failed to load: ' + String(error) };
    self.postMessage(message);
  },
);

self.onmessage = async function onMessage(event: MessageEvent<ImportRequest>) {
  const request = event.data;
  try {
    const oc = await occReady;
    const parts = importParts(oc, new Uint8Array(request.bytes), request.fileName);
    const message: ImportResponse = { kind: 'parts', id: request.id, parts: parts };
    self.postMessage(message);
  } catch (error) {
    let text = String(error);
    if (error instanceof Error) {
      text = error.message;
    }
    const message: ImportResponse = { kind: 'error', id: request.id, message: text };
    self.postMessage(message);
  }
};
