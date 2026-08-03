import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // A hard edit step runs 30-60 s; a whole file can take five minutes.
    testTimeout: 900_000,
    hookTimeout: 60_000,
    env: { PRIVATECODE_INTEGRATION: '1' },
    // Whole-branch-review fix (Task-10 report, deviation #5/#6): the single-slot llama.cpp
    // server (`-np 1`) means concurrent files hitting it are real cross-file contention,
    // not just wasted parallelism -- serializing here also matches how the suite is
    // actually usable against one local model. It ALSO sidesteps the tinypool
    // "Worker exited unexpectedly" crash observed mid-run when the three integration files
    // ran concurrently under the default pool (Task-10 report, deviation #5): one forked
    // process, reused serially across files, never hits whatever race trips that crash.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
