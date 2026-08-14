import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    // Launching Electron, loading a model and transcribing a real clip.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One Electron instance at a time; they would fight over the user-data dir.
    fileParallelism: false,
  },
})
