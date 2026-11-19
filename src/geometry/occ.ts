// Loading the OpenCascade WebAssembly module.
//
// The same function is used in three places:
//   - the browser Web Worker (wasmUrl is the URL Vite gives the .wasm file),
//   - vitest under Node (no wasmUrl: the module finds the .wasm next to its own .js file),
//   - the test-model generator script under Node (same as vitest).
//
// Package: replicad-opencascadejs (LGPL-2.1). See README.md for why this one was chosen.

import initOpenCascade from 'replicad-opencascadejs';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';

export type Occ = OpenCascadeInstance;

// OpenCascade prints transfer statistics to stdout on every STEP read and write.
// They are useful when debugging a file, so keep them available behind a flag.
export interface LoadOccOptions {
  wasmUrl?: string;
  showOcctMessages?: boolean;
}

let cachedOcc: Promise<Occ> | null = null;

export function loadOcc(options: LoadOccOptions = {}): Promise<Occ> {
  // The module is about 23 MB of wasm, so it is loaded once and kept.
  if (cachedOcc !== null) {
    return cachedOcc;
  }
  const quiet = options.showOcctMessages !== true;
  const initOptions: Parameters<typeof initOpenCascade>[0] = {};
  if (quiet) {
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

// A fresh progress range object. OpenCascade wants one on most long operations;
// we never show OCCT progress, so an empty one is enough.
export function noProgress(oc: Occ): InstanceType<Occ['Message_ProgressRange']> {
  return new oc.Message_ProgressRange();
}
