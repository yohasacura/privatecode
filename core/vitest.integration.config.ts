import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // A hard edit step runs 30-60 s; a whole file can take five minutes.
    testTimeout: 900_000,
    hookTimeout: 60_000,
    env: { PRIVATECODE_INTEGRATION: '1' },
  },
})
