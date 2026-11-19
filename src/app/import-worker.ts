// The import worker: loads OpenCascade once, then turns STEP bytes into a
// DcModel. Runs off the page's thread so the page stays responsive while the
// 23 MB wasm module loads and the model is analysed.

import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { loadOcc } from '../geometry/occ.ts';
import { importStep } from '../geometry/step-import.ts';
import { buildModel } from '../geometry/model.ts';
import type { ImportRequest, WorkerReply } from './worker-protocol.ts';
import { transferablesOf } from './worker-protocol.ts';

function reply(message: WorkerReply, transfer: ArrayBuffer[]): void {
  postMessage(message, { transfer: transfer });
}

// Start loading as soon as the worker starts, before any file arrives.
reply({ type: 'status', text: 'Loading OpenCascade (about 23 MB, once per visit)…' }, []);
const occReady = loadOcc({ wasmUrl: wasmUrl });
occReady.then(
  function loaded(): void {
    reply({ type: 'status', text: 'Ready' }, []);
  },
  function failed(error: unknown): void {
    reply({ type: 'error', message: 'Could not load OpenCascade: ' + String(error) }, []);
  },
);

self.onmessage = async function onMessage(event: MessageEvent<ImportRequest>): Promise<void> {
  const request = event.data;
  if (request.type !== 'import') {
    return;
  }
  const start = performance.now();
  try {
    reply({ type: 'status', text: 'Loading OpenCascade…' }, []);
    const oc = await occReady;
    reply({ type: 'status', text: 'Reading ' + request.fileName + '…' }, []);
    const cad = importStep(oc, new Uint8Array(request.bytes), request.fileName);
    reply({ type: 'status', text: 'Finding the outer surface, axis and fins…' }, []);
    const model = buildModel(cad);
    const workerMs = performance.now() - start;
    reply({ type: 'result', model: model, workerMs: workerMs }, transferablesOf(model));
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    reply({ type: 'error', message: message }, []);
  }
};
