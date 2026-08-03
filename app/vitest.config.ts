import preact from '@preact/preset-vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The preact plugin is needed even for tests that only import PURE functions out of a
  // .tsx panel module (tree.tsx/diffs.tsx, Task 7) -- vitest still has to parse the whole
  // file, JSX included, to load it at all.
  plugins: [preact()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
  },
})
