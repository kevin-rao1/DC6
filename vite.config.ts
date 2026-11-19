import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the static build works from any folder or domain.
  base: './',
  // The checked-in test models are served at the site root (e.g.
  // ./rocket-assembly.step) so `?model=rocket-assembly` can load them.
  publicDir: 'test-models',
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // The OpenCascade module locates its .wasm itself; pre-bundling would
    // move the .js away from it.
    exclude: ['replicad-opencascadejs'],
  },
  build: {
    target: 'es2022',
    // The wasm file is 23 MB; do not warn about it on every build.
    chunkSizeWarningLimit: 4000,
  },
});
