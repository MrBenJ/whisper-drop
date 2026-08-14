import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // A tiny-model run on a 3-second clip is fast, but a cold start on a
    // loaded CI machine is not.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
