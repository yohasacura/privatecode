import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    /**
     * Sixty seconds, and it is a machine-speed allowance rather than a slow-test allowance.
     *
     * A large part of this suite drives REAL git — checkpoints, the changes panel, the
     * per-folder repository discovery — on the grounds that a test against a mock is a test
     * of the mock. That means process spawns, and process spawns are what a small machine
     * with a virus scanner is worst at. Measured, on the same four tests:
     *
     *   that file alone, 20 cores          0.7 – 1.7 s
     *   whole suite, 20 cores              2.4 – 5.3 s   (~3x, from contention alone)
     *   whole suite, 4-core CI runner     10.7 – 15.1 s  (~16x)
     *
     * At 15 s that last row straddles the line, so a couple of tests failed each run and it
     * was a DIFFERENT couple each time — the signature of a threshold, not of a defect. Two
     * releases were blocked by it.
     *
     * Raising it costs nothing in detection power, which is the only reason a timeout exists.
     * It is here to catch a test that hangs, and a hang is unbounded: it fails at 60 s exactly
     * as surely as at 15, just a minute later. What 15 s was catching instead was a slow
     * computer.
     */
    testTimeout: 60_000,
  },
})
