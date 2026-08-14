import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['test/integration/**', 'test/e2e/**'],
    // Component tests opt into jsdom with a `@vitest-environment jsdom`
    // docblock, so the node suite is not slowed down by a DOM it never uses.
    environment: 'node',
  },
})
