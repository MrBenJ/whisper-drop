import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Root tsconfig.json (nearest to this file, and what esbuild's own
  // tsconfig discovery would pick) has no `jsx` option — it's the main
  // process's config, not the renderer's. Set explicitly so .tsx tests don't
  // depend on which tsconfig esbuild happens to resolve.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['test/integration/**', 'test/e2e/**'],
    // Component tests opt into jsdom with a `@vitest-environment jsdom`
    // docblock, so the node suite is not slowed down by a DOM it never uses.
    environment: 'node',
  },
})
