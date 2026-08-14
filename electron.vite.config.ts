import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import { cspForBuild } from './src/shared/csp.js'

/**
 * The CSP is injected here rather than hard-coded in index.html because dev
 * and production need different script-src rules and a meta tag cannot vary.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'whisper-drop-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const policy = cspForBuild(Boolean(context.server))
        return html.replace(
          '</head>',
          `  <meta http-equiv="Content-Security-Policy" content="${policy}">\n  </head>`,
        )
      },
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: 'src/main/index.ts' } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: 'src/preload/index.ts' },
        // A sandboxed preload is not an ES module. `.cjs` states that outright,
        // so the package's "type": "module" cannot claim otherwise.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), contentSecurityPolicy()],
    build: {
      rollupOptions: { input: { index: 'src/renderer/index.html' } },
    },
  },
})
