// Loading the OpenCascade WebAssembly module.
//
// The same function is used in three places:
//   - the browser Web Worker (wasmUrl is the URL Vite gives the .wasm file),
//   - vitest under Node (no wasmUrl: the module finds the .wasm next to its own .js file),
//   - the test-model generator under Node (same as vitest).
//
// Package: replicad-opencascadejs (LGPL-2.1). See README.md for why this one.

import initOpenCascade from 'replicad-opencascadejs';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';

export type Occ = OpenCascadeInstance;

export interface LoadOccOptions {
  // URL of the .wasm file, when the bundler moved it away from the .js file.
  wasmUrl?: string;
  // OpenCascade prints transfer statistics on every STEP read and write.
  // Useful when debugging a file, noise otherwise.
  showOcctMessages?: boolean;
}

let cachedOcc: Promise<Occ> | null = null;

export function loadOcc(options: LoadOccOptions = {}): Promise<Occ> {
  // About 23 MB of wasm: load once and keep it.
  if (cachedOcc !== null) {
    return cachedOcc;
  }
  const initOptions: Parameters<typeof initOpenCascade>[0] = {};
  if (options.showOcctMessages !== true) {
    initOptions.print = function ignore(): void {};
    initOptions.printErr = function ignore(): void {};
  }
  const wasmUrl = options.wasmUrl;
  if (wasmUrl !== undefined) {
    initOptions.locateFile = function locate(path: string): string {
      if (path.endsWith('.wasm')) {
        return wasmUrl;
      }
      return path;
    };
  }
  cachedOcc = initOpenCascade(initOptions);
  return cachedOcc;
}

// OpenCascade wants a progress range on most long operations. We never show
// its progress, so an empty one is enough.
export function noProgress(oc: Occ): InstanceType<Occ['Message_ProgressRange']> {
  return new oc.Message_ProgressRange();
}
