import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Importing a test part takes up to 2 s (OpenCascade read and
    // tessellate, then hull and attach faces); the first test in a file also
    // loads the wasm module.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
