import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import { cspForBuild } from './src/shared/csp.js'

/**
 * Does the actual string surgery, split out from the plugin below so it can
 * be unit-tested (`test/build/csp-injection.test.ts`) directly against the
 * real `src/renderer/index.html` source — a whitespace or casing change to
 * that file's `</head>` would otherwise make this replace silently no-op,
 * shipping a CSP-less renderer behind a build that still exits 0. Throwing
 * instead turns that into a build failure.
 */
export function injectCsp(html: string, policy: string): string {
  if (!html.includes('</head>')) {
    throw new Error(
      "whisper-drop-csp: no '</head>' found in the renderer's index.html to inject the " +
        'Content-Security-Policy meta tag before — refusing to ship a CSP-less renderer.',
    )
  }
  return html.replace(
    '</head>',
    `  <meta http-equiv="Content-Security-Policy" content="${policy}">\n  </head>`,
  )
}

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
        return injectCsp(html, cspForBuild(Boolean(context.server)))
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
