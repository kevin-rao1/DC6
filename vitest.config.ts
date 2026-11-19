import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Importing a test rocket takes 1-3 s (OpenCascade read and tessellate,
    // then ray casting); the first test in a file also loads the wasm module.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
