import preact from '@preact/preset-vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The preact plugin is needed even for tests that only import PURE functions out of a
  // .tsx panel module (tree.tsx/diffs.tsx, Task 7) -- vitest still has to parse the whole
  // file, JSX included, to load it at all.
  plugins: [preact()],
  test: {
    // `.test.tsx` as well: a test that mounts a component to drive real DOM behaviour —
    // event propagation, focus, which listener wins an Escape — writes JSX like the
    // component it is testing.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // `node` stays the DEFAULT because it is what almost every test here needs (pure
    // reducers and helpers) and it is several times faster to spin up. The handful of
    // tests that need a document opt in per file with `@vitest-environment happy-dom`.
    environment: 'node',
    testTimeout: 5_000,
  },
})
