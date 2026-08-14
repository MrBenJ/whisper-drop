# whisper-drop Part 3 — Electron App, IPC and UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a window in front of parts 1 and 2. An Electron shell with a hardened renderer, a narrow typed IPC surface that validates everything crossing it, and a React UI with five states — drop a file, watch honest progress, read the transcript, save it next to the source.

**Architecture:** Four electron-importing files and nothing else. `src/main/index.ts` is the composition root: it is the only place that reads `app.getPath('userData')` and the only place that knows the real `probe`/`extract`/`runWhisper` collaborators exist. Every IPC handler module takes its dependencies by injection and knows nothing about Electron, so the whole boundary — id validation, the one-job-at-a-time rule, the reveal allowlist, error translation — is unit-tested without an app harness. The renderer is React with no router, no state library and no CSS framework; its state is one pure reducer, tested as pure data.

**Tech Stack:** TypeScript 5 (ESM), Vitest 4, Node 22, Electron 43, electron-vite 5, Vite 7, React 19, `@vitejs/plugin-react` 5, Testing Library 16 + jsdom for components, `playwright`'s `_electron` for one smoke test.

**Spec:** `docs/superpowers/specs/2026-08-14-part3-electron-app-design.md`
**Parent spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md` — binding authority.

## Scope

This is plan 3 of 4. Parts 1 and 2 are merged on `main`: 211 tests, all green, `tsc --noEmit` clean.

**In scope:** the electron-vite scaffold, the main-process entry and window lifecycle with the spec's security posture, the preload bridge, the shared IPC contract types, five IPC handler modules, the composition root, `before-quit` cleanup, the React UI (drop zone, working, done, error, model picker), export-to-file with the collision rule, and one Playwright-on-Electron smoke test.

**Out of scope, deferred to plan 4:** `electron-builder` packaging, code signing, releases, GitHub Actions, the README and the Licenses screen. Also out, per the parent spec's Later list: batch queue, translation, custom vocabulary, word-level timestamps.

**Deliverable:** `npm run dev` opens a working app. `npm test` passes the unit suite in seconds. `npm run test:e2e` launches the built app, transcribes `test/fixtures/hello.mp4`, and asserts the transcript renders.

## Deviations from the spec

Three, recorded here so none of them is silent.

1. **Four files may import `electron`, not one directory.** The part 3 spec says "`src/main/ipc/` is the only directory permitted to import `electron`" and, two paragraphs later, that `src/main/index.ts` calls `app.getPath('userData')`. Those cannot both hold: `src/main/index.ts` is the Electron entry point and must call `app.whenReady()`. The rule this plan enforces — and enforces with a test, not a convention — is an explicit four-file allowlist: `src/main/index.ts`, `src/main/window.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`. Every handler module, and everything under `src/main/` that carries logic, stays plain Node. The parent spec's actual wording ("Modules under `src/main/` other than `ipc/` must not import `electron`") is about logic modules, and that intent is preserved exactly.

2. **The shared types the renderer needs move to `src/shared/types.ts`.** The parent spec's "Shared types" section declares `ModelBaseId`, `ModelId`, `ModelEntry`, `DownloadProgress` and `Settings` as shared. Part 2 declared them inside `models/catalog.ts`, `models/download.ts` and `settings.ts` instead, which was correct while nothing else needed them. It is not correct now: the renderer must name them, and the renderer must not import from `src/main/`. Task 2 moves the declarations to `src/shared/types.ts` and re-exports them from their current homes, so every existing import keeps working. **Verified:** this move alone leaves all 211 existing tests green and `tsc --noEmit` clean.

3. **The IPC surface gains `droppedFile.pathFor(file)`.** Neither spec lists it, and without it the drop zone cannot work at all: Electron 32 removed the `File.path` property, and a dropped file's real path is now obtainable only from a preload calling `webUtils.getPathForFile(file)`. This is the one addition to the contract, and it is a getter over an OS-supplied `File`, not a new capability.

## Global Constraints

Every task's requirements implicitly include these.

- **Only four files may import `electron`:** `src/main/index.ts`, `src/main/window.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`. Everything else — every handler module, every logic module, the whole renderer — is plain Node or plain browser. This is what keeps the suite running without an app harness. Task 1 adds `test/main/electron-boundary.test.ts`, which fails the build if the allowlist is broken.
- **Only `src/main/ipc/index.ts` touches `ipcMain`.** Handler modules take dependencies by injection and return plain functions.
- **`jobId` is generated in main with `randomUUID()`, is a `Map` key, and is never a path component.** Part 1's `tempWavPath(id)` interpolates the id straight into a filesystem path; a renderer-supplied id would be a traversal. Handlers look jobs up in the map and reject an unknown id.
- **The renderer never constructs a filesystem path.** It reads `JobState.filePath` to show a filename and it passes back opaque ids and format literals. `exportTranscript.save` derives the output path from main's own record of the job. `shell.reveal` accepts only a path main itself previously returned.
- **No new runtime dependency beyond the spec's list:** `electron`, `electron-vite`, `vite`, `react`, `react-dom`, `@vitejs/plugin-react`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `playwright`. No UI component library, no CSS framework, no state-management library, no icon font.
- **The renderer loads nothing from the network,** at any point, in dev or in production.
- **`ErrorCode` stays at nine values.** The three boundary conditions this part introduces live in a separate `IpcBoundaryCode` union.
- **The existing 211 tests stay green and stay fast.** After this plan the suite is 385 tests and still runs in about four seconds. Component tests opt into jsdom per-file; the node tests never pay for a DOM.
- **Comments succinct and terse, only where the reasoning is non-obvious.** A comment restating the code is a defect.
- ESM throughout; relative imports carry `.js` extensions. `strict` and `noUncheckedIndexedAccess: true`.
- **Progress bands, ETA threshold, and the nine error messages are fixed by the parent spec** and are not re-litigated here.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | New deps, `main` entry, dev/build/e2e scripts |
| `tsconfig.json` | The node program: main, shared, node tests, config files |
| `tsconfig.web.json` | The web program: renderer, preload, shared, renderer tests |
| `electron.vite.config.ts` | Three builds; CSP injection; preload as CJS |
| `vitest.config.ts` | Unit suite, now including `.tsx` and excluding e2e |
| `vitest.e2e.config.ts` | Playwright-on-Electron suite |
| `src/shared/types.ts` | **Modified.** Gains the types the renderer needs, plus `ERROR_CODES` |
| `src/shared/ipc.ts` | Channels, `IpcResult`, `IpcFailure`, `ModelRow`, `WhisperDropApi` |
| `src/shared/csp.ts` | The dev and production Content-Security-Policy strings |
| `src/preload/index.ts` | `contextBridge.exposeInMainWorld`. Nothing else |
| `src/main/index.ts` | Composition root. The only reader of `app.getPath('userData')` |
| `src/main/window.ts` | Window creation and the security posture |
| `src/main/navigation.ts` | The navigation predicate, so it is testable |
| `src/main/ipc/index.ts` | The only `ipcMain.handle` calls |
| `src/main/ipc/errors.ts` | `IpcError`, `toFailure`, `toResult` |
| `src/main/ipc/validate.ts` | The three boundary validators |
| `src/main/ipc/transcribe.ts` | Job map, one-job-at-a-time, throughput recording |
| `src/main/ipc/models.ts` | Picker rows, download, cancel, remove |
| `src/main/ipc/settings.ts` | Read, and a whitelisted patch |
| `src/main/ipc/export.ts` | Save, and the reveal allowlist |
| `src/main/ipc/dialog.ts` | The browse fallback |
| `src/main/export/save.ts` | Next-to-source naming and the ` (2)` collision rule |
| `src/renderer/index.html` | Document shell. CSP is injected at build time |
| `src/renderer/main.tsx` | React root |
| `src/renderer/App.tsx` | The five-state shell and all IPC wiring |
| `src/renderer/state/app-state.ts` | The pure reducer |
| `src/renderer/format.ts` | ETA, duration, percent, bytes, realtime factor |
| `src/renderer/errors.ts` | `ErrorCode` → message, suggestion, action |
| `src/renderer/components/*.tsx` | DropZone, Working, Done, ErrorView, ModelPicker, Toast, Header |
| `src/renderer/styles.css` | The whole stylesheet |
| `test/renderer/fake-api.ts` | The fake preload bridge every component test renders against |
| `test/e2e/smoke.test.ts` | Launch, transcribe the fixture, assert the transcript |

---

### Task 1: Electron scaffold, window, and the boundary guard

electron-vite, React and TypeScript alongside the existing Vitest setup, with the security posture in place from the first commit rather than retrofitted. No IPC yet: this task ends with a window that opens and a test that fails if anyone imports `electron` outside the allowlist.

**Files:**
- Modify: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `tsconfig.web.json`, `electron.vite.config.ts`, `vitest.e2e.config.ts`
- Create: `src/shared/csp.ts`, `src/main/navigation.ts`, `src/main/window.ts`, `src/main/index.ts`
- Create: `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`, `src/renderer/env.d.ts`
- Test: `test/shared/csp.test.ts`, `test/main/navigation.test.ts`, `test/main/electron-boundary.test.ts`

**Interfaces:**
- Consumes: nothing from parts 1 and 2.
- Produces:
  - `CSP_PRODUCTION`, `CSP_DEVELOPMENT`, `cspFor(mode)`
  - `isAllowedNavigation(currentUrl, targetUrl): boolean`
  - `createMainWindow(options): BrowserWindow`

- [ ] **Step 1: Install the dependencies**

The version matrix matters. `electron-vite@5` peers on `vite@^5 || ^6 || ^7`, but Vitest 4 resolves `vite@8` transitively; installing electron-vite without pinning fails with `ERESOLVE`. `@vitejs/plugin-react@6` then peers on `vite@^8`, so it has to come down a major too. **Vite 7 + electron-vite 5 + plugin-react 5 + Vitest 4 is the combination that installs cleanly and leaves the existing suite green** — this was verified, not assumed.

Run:

```bash
npm install react react-dom
npm install -D electron electron-vite 'vite@^7.3.0' '@vitejs/plugin-react@^5.0.0' \
  @types/react @types/react-dom @testing-library/react @testing-library/user-event jsdom playwright
```

Expected: installs with no `ERESOLVE` error. Verify the resolved majors:

```bash
for p in electron electron-vite vite @vitejs/plugin-react react vitest; do \
  echo -n "$p "; node -p "require('./node_modules/$p/package.json').version"; done
```

Expected: `electron 43.x`, `electron-vite 5.x`, `vite 7.x`, `@vitejs/plugin-react 5.x`, `react 19.x`, `vitest 4.x`.

- [ ] **Step 2: Update `package.json`**

Add the `main` field and the new scripts. Leave the existing `test`, `test:watch`, `test:integration` and `setup` scripts exactly as they are.

```json
{
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "npm run build && node scripts/fetch-test-model.mjs && vitest run --config vitest.e2e.config.ts",
    "test:integration": "node scripts/fetch-test-model.mjs && vitest run --config vitest.integration.config.ts",
    "setup": "node scripts/build-whisper.mjs"
  }
}
```

Also add `out/` to `.gitignore`.

- [ ] **Step 3: Split the TypeScript programs**

The renderer needs `DOM` and JSX; the main process must not have them. The preload needs both DOM and Node, because it is a renderer-context script that imports `electron`. Two programs, typechecked in sequence.

Replace `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": [
    "src/main",
    "src/shared",
    "src/types",
    "test/main",
    "test/shared",
    "test/integration",
    "test/e2e",
    "electron.vite.config.ts",
    "vitest.config.ts",
    "vitest.integration.config.ts",
    "vitest.e2e.config.ts"
  ]
}
```

Create `tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/renderer", "src/preload", "src/shared", "test/renderer"]
}
```

`src/shared` is in both programs deliberately: it must compile under DOM-free Node rules *and* Node-free browser rules, which is the cheapest possible proof that nothing platform-specific leaks into it. There are no project references and no `composite`, so nothing objects to the overlap.

- [ ] **Step 4: Update the Vitest configs**

Replace `vitest.config.ts`:

```ts
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
```

Do **not** add `esbuild: { jsx: 'automatic' }`. Vitest 4 transforms with oxc, ignores the `esbuild` key, and prints a warning about it. Oxc's default handles `.tsx` with the automatic runtime already — verified by rendering a real component.

Create `vitest.e2e.config.ts`:

```ts
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
```

- [ ] **Step 5: Write the failing test for the Content-Security-Policy**

Create `test/shared/csp.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CSP_DEVELOPMENT, CSP_PRODUCTION, cspFor } from '../../src/shared/csp.js'

describe('the production policy', () => {
  it('allows scripts only from the app itself', () => {
    expect(CSP_PRODUCTION).toContain("script-src 'self'")
    expect(CSP_PRODUCTION).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(CSP_PRODUCTION).not.toContain('unsafe-eval')
  })

  it('names no remote origin', () => {
    expect(CSP_PRODUCTION).not.toMatch(/https?:/)
    expect(CSP_PRODUCTION).not.toMatch(/wss?:/)
    expect(CSP_PRODUCTION).not.toContain('*')
  })

  it('defaults to self and blocks plugins, base tags, forms and framing', () => {
    expect(CSP_PRODUCTION).toContain("default-src 'self'")
    expect(CSP_PRODUCTION).toContain("object-src 'none'")
    expect(CSP_PRODUCTION).toContain("base-uri 'none'")
    expect(CSP_PRODUCTION).toContain("form-action 'none'")
    expect(CSP_PRODUCTION).toContain("frame-ancestors 'none'")
  })

  it('allows inline styles, which Vite needs and which execute no script', () => {
    expect(CSP_PRODUCTION).toContain("style-src 'self' 'unsafe-inline'")
  })
})

describe('cspFor', () => {
  it('returns the strict policy for production', () => {
    expect(cspFor('production')).toBe(CSP_PRODUCTION)
  })

  it('relaxes only script-src for development', () => {
    expect(cspFor('development')).toBe(CSP_DEVELOPMENT)
    expect(CSP_DEVELOPMENT).toContain("script-src 'self' 'unsafe-inline'")
    expect(CSP_DEVELOPMENT.replace(" 'unsafe-inline'", '')).toBe(CSP_PRODUCTION)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/shared/csp.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/csp.js`.

- [ ] **Step 7: Implement `src/shared/csp.ts`**

```ts
/**
 * The renderer loads nothing from the network, so the policy is `'self'`
 * throughout. `style-src` allows inline styles because Vite injects CSS as
 * `<style>` elements; inline *style* is not a script-execution vector.
 */
export const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Dev only. `@vitejs/plugin-react` injects its Fast Refresh preamble as an
 * inline module script, which `script-src 'self'` blocks. `'self'` already
 * covers the HMR websocket: CSP matches `ws://` against an `http://` document
 * origin. This string must never reach a packaged build.
 */
export const CSP_DEVELOPMENT = CSP_PRODUCTION.replace(
  "script-src 'self'",
  "script-src 'self' 'unsafe-inline'",
)

export function cspFor(mode: 'development' | 'production'): string {
  return mode === 'production' ? CSP_PRODUCTION : CSP_DEVELOPMENT
}
```

Run: `npx vitest run test/shared/csp.test.ts` — expected PASS.

- [ ] **Step 8: Create `electron.vite.config.ts`**

```ts
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import { cspFor } from './src/shared/csp.js'

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
        const policy = cspFor(context.server ? 'development' : 'production')
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
```

`externalizeDepsPlugin()` on the main build is load-bearing: `ffmpeg-static` and `ffprobe-static` resolve their binaries from their own `__dirname` and break if bundled.

- [ ] **Step 9: Create the placeholder renderer**

`src/renderer/index.html` — note there is no CSP meta tag here; step 8 injects it.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>whisper-drop</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/renderer/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('renderer: #root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/renderer/App.tsx` — a placeholder, replaced in Task 4:

```tsx
export function App() {
  return <main><h1>whisper-drop</h1></main>
}
```

`src/renderer/styles.css`:

```css
:root { color-scheme: dark; }
```

`src/renderer/env.d.ts` — the `Window` augmentation is added in Task 2:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 10: Write the failing test for the navigation predicate**

Create `test/main/navigation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isAllowedNavigation } from '../../src/main/navigation.js'

describe('isAllowedNavigation', () => {
  it('allows a reload of the document already loaded', () => {
    expect(isAllowedNavigation('http://localhost:5173/', 'http://localhost:5173/')).toBe(true)
  })

  it('denies anything a transcript could point at', () => {
    const current = 'file:///Applications/whisper-drop.app/renderer/index.html'

    for (const target of [
      'https://example.com/',
      'http://localhost:5173/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///Applications/whisper-drop.app/renderer/index.html#x',
    ]) {
      expect(isAllowedNavigation(current, target), target).toBe(false)
    }
  })
})
```

Run: `npx vitest run test/main/navigation.test.ts` — expected FAIL, cannot resolve `navigation.js`.

- [ ] **Step 11: Implement `src/main/navigation.ts`**

```ts
/**
 * The shell only ever stays on the document it loaded. A transcript is
 * arbitrary text, so any navigation it can provoke — a link, a redirect, a
 * `location.assign` — is denied. Reloads target the same URL and are allowed,
 * which is what keeps Vite's dev HMR working.
 */
export function isAllowedNavigation(currentUrl: string, targetUrl: string): boolean {
  return targetUrl === currentUrl
}
```

Run: `npx vitest run test/main/navigation.test.ts` — expected PASS.

- [ ] **Step 12: Create `src/main/window.ts`**

```ts
import { BrowserWindow } from 'electron'
import { isAllowedNavigation } from './navigation.js'

export type WindowOptions = {
  preloadPath: string
  /** Set by electron-vite in dev. When absent, the built HTML is loaded. */
  rendererUrl?: string
  rendererFile: string
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'whisper-drop',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const denyNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAllowedNavigation(window.webContents.getURL(), url)) event.preventDefault()
  }
  window.webContents.on('will-navigate', denyNavigation)
  window.webContents.on('will-frame-navigate', (event) => denyNavigation(event, event.url))

  // The app needs no device permissions. Refusing them all means a compromised
  // renderer cannot prompt for a microphone on a machine holding client audio.
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )

  if (options.rendererUrl) void window.loadURL(options.rendererUrl)
  else void window.loadFile(options.rendererFile)

  return window
}
```

- [ ] **Step 13: Create a minimal `src/main/index.ts`**

Task 3 replaces this with the full composition root. For now it only has to open a window.

```ts
import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { createMainWindow } from './window.js'

function openWindow(): BrowserWindow {
  return createMainWindow({
    preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(import.meta.dirname, '../renderer/index.html'),
  })
}

app.whenReady().then(() => {
  openWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

`import.meta.dirname` needs Node 20.11+; Electron 43 ships Node 22. electron-vite emits main as ESM and leaves `import.meta.dirname` intact — verified in the built output.

Until Task 2 exists there is no `src/preload/index.cjs`, so Electron logs a preload-not-found warning and the window still opens. That is expected at this step.

- [ ] **Step 14: Write the boundary guard**

Create `test/main/electron-boundary.test.ts`. Task 3 adds one more assertion to this file.

```ts
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

/**
 * The four files that own the Electron surface. Everything else stays plain
 * Node, which is what keeps the unit suite running without an app harness.
 */
const MAY_IMPORT_ELECTRON = new Set([
  'main/index.ts',
  'main/window.ts',
  'main/ipc/index.ts',
  'preload/index.ts',
])

const ELECTRON_IMPORT = /(?:from|import|require)\s*\(?\s*['"]electron['"]/
const NODE_BUILTIN_IMPORT = /(?:from|import|require)\s*\(?\s*['"]node:/

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)))
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }

  return found
}

const FILES = await sourceFiles(SRC)
const key = (file: string): string => relative(SRC, file).split(sep).join('/')

describe('the Electron boundary', () => {
  it('finds source files to check, so a broken walk cannot pass silently', () => {
    expect(FILES.length).toBeGreaterThan(15)
  })

  it('lets only the four shell files import electron', async () => {
    const offenders: string[] = []

    for (const file of FILES) {
      const name = key(file)
      if (MAY_IMPORT_ELECTRON.has(name)) continue
      if (ELECTRON_IMPORT.test(await readFile(file, 'utf8'))) offenders.push(name)
    }

    expect(offenders).toEqual([])
  })

  it('keeps node builtins out of the renderer', async () => {
    const offenders: string[] = []

    for (const file of FILES.filter((f) => key(f).startsWith('renderer/'))) {
      if (NODE_BUILTIN_IMPORT.test(await readFile(file, 'utf8'))) offenders.push(key(file))
    }

    expect(offenders).toEqual([])
  })

  it('keeps main out of the renderer, so the renderer cannot reach the filesystem', async () => {
    const offenders: string[] = []

    for (const file of FILES.filter((f) => key(f).startsWith('renderer/'))) {
      if (/from\s+['"][^'"]*\/main\//.test(await readFile(file, 'utf8'))) offenders.push(key(file))
    }

    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 15: Prove the existing suite is untouched and still fast**

Run: `npm test`
Expected: PASS. The 211 pre-existing tests plus the new csp, navigation and boundary tests. Duration under 10 seconds — if it is not, something has pulled jsdom or a browser environment into the node suite.

Run: `npm run typecheck`
Expected: both programs clean, no output.

- [ ] **Step 16: Prove the build works**

Run: `npm run build`
Expected: three builds succeed —

```
out/main/index.js
out/preload/index.cjs
out/renderer/index.html + assets
```

Verify the CSP landed and the preload is CommonJS:

```bash
grep -o 'Content-Security-Policy[^>]*' out/renderer/index.html
head -2 out/preload/index.cjs
```

Expected: the production policy string, with `script-src 'self'` and no `unsafe-inline` in it; and `"use strict";` followed by `const electron = require("electron");`.

Verify the main bundle externalises the binary packages:

```bash
grep -oE 'from "[a-z@][^"]*"' out/main/index.js | sort -u
```

Expected: `electron`, `ffmpeg-static`, `ffprobe-static` and `node:*` only — nothing from `src/`.

- [ ] **Step 17: Open the window**

Run: `npm run dev`
Expected: an Electron window titled `whisper-drop` showing the placeholder heading. Close it to end the run.

- [ ] **Step 18: Commit**

```bash
git add package.json package-lock.json .gitignore tsconfig.json tsconfig.web.json \
  electron.vite.config.ts vitest.config.ts vitest.e2e.config.ts src test
git commit -m "feat: electron-vite scaffold with a hardened window and a boundary guard"
```

---

### Task 2: The IPC contract types and the preload bridge

The typed surface both sides compile against, so main and renderer cannot drift. This task also performs the shared-type move described under Deviations, which is what lets the renderer name `ModelBaseId` and `Settings` without reaching into `src/main/`.

**Files:**
- Modify: `src/shared/types.ts`, `src/main/models/catalog.ts`, `src/main/models/download.ts`, `src/main/settings.ts`, `src/main/export/formatters.ts`, `src/renderer/env.d.ts`
- Create: `src/shared/ipc.ts`, `src/preload/index.ts`

**Interfaces:**
- Consumes: `ErrorCode`, `JobState`, `Unsubscribe` from `src/shared/types.ts`.
- Produces:
  - `ERROR_CODES`, `EXPORT_FORMATS`, and the moved `ModelBaseId` / `ModelId` / `ModelEntry` / `DownloadProgress` / `Settings` / `ExportFormat`
  - `CHANNELS`, `Channel`, `IpcBoundaryCode`, `IpcErrorCode`, `IPC_BOUNDARY_CODES`, `IpcFailure`, `IpcResult<T>`, `ModelRow`, `WhisperDropApi`
  - `window.whisperDrop`

- [ ] **Step 1: Move the shared types into `src/shared/types.ts`**

Replace the `ErrorCode` union with an iterable const plus a derived type, and append the five moved declarations plus `ExportFormat`. Everything else in the file stays as it is.

```ts
/** Iterable form, so the renderer's message table can be proved exhaustive. */
export const ERROR_CODES = [
  'NO_AUDIO_STREAM',
  'UNREADABLE_MEDIA',
  'NO_MODEL_INSTALLED',
  'MODEL_FILE_MISSING',
  'INSUFFICIENT_DISK_SPACE',
  'DOWNLOAD_CHECKSUM_MISMATCH',
  'DOWNLOAD_NETWORK_ERROR',
  'WHISPER_FAILED',
  'FFMPEG_FAILED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** A row in the model picker. */
export type ModelBaseId = 'tiny' | 'base' | 'small' | 'large-v3-turbo' | 'large-v3'

/** A concrete model file. */
export type ModelId = ModelBaseId | 'tiny.en' | 'base.en' | 'small.en'

export type ModelEntry = {
  id: ModelId
  base: ModelBaseId
  label: string
  bytes: number
  sha256: string
  url: string
  blurb: string
  englishOnly: boolean
}

export type DownloadProgress = {
  id: ModelId
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
}

export type Settings = {
  version: 1
  englishOnly: boolean
  activeModel: ModelBaseId | null
  /** ISO 639-1 code, or 'auto'. Ignored while englishOnly. */
  language: string
  throughput: Partial<Record<ModelId, { realtimeFactor: number; samples: number }>>
}

export const EXPORT_FORMATS = ['txt', 'srt', 'vtt'] as const

export type ExportFormat = (typeof EXPORT_FORMATS)[number]
```

- [ ] **Step 2: Re-export from the modules that used to declare them**

Four edits, each replacing a declaration with an import plus a re-export. Nothing else in these files changes, and no consumer's import path changes.

`src/main/models/catalog.ts` — replace the `ModelBaseId` / `ModelId` / `ModelEntry` declarations at the top of the file with:

```ts
import type { ModelBaseId, ModelEntry, ModelId } from '../../shared/types.js'

// Declared in shared/types so the renderer can name them without importing
// anything from main. Re-exported here because this module remains the place
// the rest of main imports them from.
export type { ModelBaseId, ModelEntry, ModelId }
```

`src/main/models/download.ts` — add `import type { DownloadProgress } from '../../shared/types.js'` beside the existing `AppError` import, and replace the `DownloadProgress` declaration with `export type { DownloadProgress }`.

`src/main/settings.ts` — add `import type { Settings } from '../shared/types.js'` above the catalog import, and replace the `Settings` declaration with `export type { Settings }`. `CURRENT_VERSION` stays; `version: typeof CURRENT_VERSION` and `version: 1` are the same type.

`src/main/export/formatters.ts` — change the type import to `import type { ExportFormat, Segment } from '../../shared/types.js'` and replace the `ExportFormat` declaration with `export type { ExportFormat }`.

- [ ] **Step 3: Prove the move changed no behaviour**

Run: `npm test && npm run typecheck`
Expected: PASS, all pre-existing tests included, no type errors. **This was verified against the real tree: 211/211 green, both programs clean.** If anything fails here, the move is wrong — do not proceed.

- [ ] **Step 4: Create `src/shared/ipc.ts`**

```ts
import type {
  DownloadProgress,
  ErrorCode,
  ExportFormat,
  JobState,
  ModelBaseId,
  ModelEntry,
  Settings,
  Unsubscribe,
} from './types.js'

/** Every channel the renderer can reach. Anything not here is unreachable. */
export const CHANNELS = {
  transcribeStart: 'transcribe:start',
  transcribeCancel: 'transcribe:cancel',
  /** main -> renderer */
  transcribeState: 'transcribe:state',
  modelsList: 'models:list',
  modelsDownload: 'models:download',
  modelsCancelDownload: 'models:cancelDownload',
  modelsRemove: 'models:remove',
  /** main -> renderer */
  modelsProgress: 'models:progress',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  exportSave: 'export:save',
  dialogOpenFile: 'dialog:openFile',
  shellReveal: 'shell:reveal',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

/**
 * `ErrorCode` covers failures of real operations and is fixed by the parent
 * spec. These three are boundary conditions the renderer can only reach by
 * being wrong or malicious, so they live here rather than widening `ErrorCode`.
 */
export type IpcBoundaryCode = 'INVALID_REQUEST' | 'JOB_ALREADY_RUNNING' | 'UNEXPECTED'

export type IpcErrorCode = ErrorCode | IpcBoundaryCode

export const IPC_BOUNDARY_CODES = [
  'INVALID_REQUEST',
  'JOB_ALREADY_RUNNING',
  'UNEXPECTED',
] as const satisfies readonly IpcBoundaryCode[]

export type IpcFailure = {
  code: IpcErrorCode
  /** Plain language, shown directly. */
  message: string
  /** Technical detail, shown behind a disclosure. */
  detail?: string
}

/**
 * Every handler answers with this. Errors travel as data because
 * `contextBridge` copies only `message` and `stack` off a thrown Error, which
 * would drop the `code` and `detail` the error UI is built from.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcFailure }

/** One picker row, already resolved against the English-only toggle. */
export type ModelRow = {
  base: ModelBaseId
  resolved: ModelEntry
  installed: boolean
  /** Measured on this machine. Absent if this model has never been run. */
  realtimeFactor?: number
  downloading?: DownloadProgress
}

/** The complete surface exposed on `window.whisperDrop`. */
export type WhisperDropApi = {
  transcribe: {
    start(filePath: string): Promise<string>
    cancel(jobId: string): Promise<void>
    onState(callback: (state: JobState) => void): Unsubscribe
  }
  models: {
    list(): Promise<ModelRow[]>
    download(base: ModelBaseId): Promise<void>
    cancelDownload(base: ModelBaseId): Promise<void>
    remove(base: ModelBaseId): Promise<void>
    onProgress(callback: (progress: DownloadProgress) => void): Unsubscribe
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  exportTranscript: {
    save(jobId: string, format: ExportFormat): Promise<string>
  }
  dialog: {
    openFile(): Promise<string | null>
  }
  shell: {
    reveal(path: string): Promise<void>
  }
  droppedFile: {
    /**
     * Electron 32 removed `File.path`. A dropped file's real path is only
     * obtainable from the preload, via `webUtils.getPathForFile`.
     */
    pathFor(file: File): string
  }
}
```

- [ ] **Step 5: Create `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CHANNELS, type IpcResult, type ModelRow, type WhisperDropApi } from '../shared/ipc.js'
import type { DownloadProgress, JobState, Settings, Unsubscribe } from '../shared/types.js'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (result.ok) return result.value
  // Rejected with the plain failure object rather than an Error: contextBridge
  // copies only `message` and `stack` off an Error, which would drop `code`
  // and `detail` — the two fields the error UI is built from.
  throw result.error
}

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const api: WhisperDropApi = {
  transcribe: {
    start: (filePath) => invoke<string>(CHANNELS.transcribeStart, filePath),
    cancel: (jobId) => invoke<void>(CHANNELS.transcribeCancel, jobId),
    onState: (callback) => subscribe<JobState>(CHANNELS.transcribeState, callback),
  },
  models: {
    list: () => invoke<ModelRow[]>(CHANNELS.modelsList),
    download: (base) => invoke<void>(CHANNELS.modelsDownload, base),
    cancelDownload: (base) => invoke<void>(CHANNELS.modelsCancelDownload, base),
    remove: (base) => invoke<void>(CHANNELS.modelsRemove, base),
    onProgress: (callback) => subscribe<DownloadProgress>(CHANNELS.modelsProgress, callback),
  },
  settings: {
    get: () => invoke<Settings>(CHANNELS.settingsGet),
    set: (patch) => invoke<Settings>(CHANNELS.settingsSet, patch),
  },
  exportTranscript: {
    save: (jobId, format) => invoke<string>(CHANNELS.exportSave, jobId, format),
  },
  dialog: {
    openFile: () => invoke<string | null>(CHANNELS.dialogOpenFile),
  },
  shell: {
    reveal: (path) => invoke<void>(CHANNELS.shellReveal, path),
  },
  droppedFile: {
    pathFor: (file) => webUtils.getPathForFile(file),
  },
}

contextBridge.exposeInMainWorld('whisperDrop', api)
```

Three things here are not optional. The preload imports no Node builtin, because a sandboxed preload has no `require` for them. `webUtils` is available in a sandboxed preload and is the only place `getPathForFile` can be called. And the unsubscribe function returned by `subscribe` crosses the bridge as a proxied function, which contextBridge supports in both directions.

- [ ] **Step 6: Declare the global in `src/renderer/env.d.ts`**

```ts
/// <reference types="vite/client" />

import type { WhisperDropApi } from '../shared/ipc.js'

declare global {
  interface Window {
    /** The complete surface the renderer has. There is no other way out. */
    readonly whisperDrop: WhisperDropApi
  }
}
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: both programs clean; all tests pass; `out/preload/index.cjs` now begins `"use strict";` / `const electron = require("electron");`.

Run: `npm run dev`, then in the window's devtools console (`View → Toggle Developer Tools`), type `Object.keys(window.whisperDrop)`.
Expected: `['transcribe','models','settings','exportTranscript','dialog','shell','droppedFile']`. Also confirm `typeof require === 'undefined'` and `typeof process === 'undefined'`.

- [ ] **Step 8: Commit**

```bash
git add src test
git commit -m "feat: shared IPC contract types and the preload bridge"
```

---

### Task 3: IPC handlers, boundary validation, and the composition root

The security-critical task. Every handler module takes its dependencies by injection, so all of it is unit-tested without launching Electron; `src/main/ipc/index.ts` is the only file that calls `ipcMain.handle`, and `src/main/index.ts` is the only file that reads `app.getPath('userData')`.

**Files:**
- Create: `src/main/ipc/errors.ts`, `src/main/ipc/validate.ts`, `src/main/ipc/transcribe.ts`, `src/main/ipc/models.ts`, `src/main/ipc/settings.ts`, `src/main/ipc/export.ts`, `src/main/ipc/dialog.ts`, `src/main/ipc/index.ts`
- Create: `src/main/export/save.ts`
- Replace: `src/main/index.ts`
- Modify: `test/main/electron-boundary.test.ts`
- Test: `test/main/ipc/errors.test.ts`, `test/main/ipc/transcribe.test.ts`, `test/main/ipc/models.test.ts`, `test/main/ipc/settings.test.ts`, `test/main/ipc/export.test.ts`, `test/main/ipc/dialog.test.ts`, `test/main/export/save.test.ts`

**Interfaces:**
- Consumes: `TranscriptionJob` + `JobInput` (`main/jobs/transcription-job.ts`); `probe`, `extractWav`, `runWhisper`; `createModelStore`, `createSettingsStore`; `resolveModelId`, `entryFor`, `MODEL_BASE_ORDER`; `format`; `AppError`; everything from Task 2.
- Produces: `IpcError`, `toFailure`, `toResult`; `requireNonEmptyString`, `requireModelBaseId`, `requireExportFormat`; `createTranscribeHandlers`, `createModelHandlers`, `createSettingsHandlers`, `createExportHandlers`, `createDialogHandlers`; `registerIpcHandlers`; `candidatePath`, `saveTranscript`.

- [ ] **Step 1: Write the failing tests for the error envelope**

Create `test/main/ipc/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { IpcError, toFailure, toResult } from '../../../src/main/ipc/errors.js'
import { AppError } from '../../../src/shared/errors.js'

describe('toFailure', () => {
  it('keeps an AppError’s code, message and detail', () => {
    expect(toFailure(new AppError('NO_AUDIO_STREAM', 'No audio.', 'stderr'))).toEqual({
      code: 'NO_AUDIO_STREAM',
      message: 'No audio.',
      detail: 'stderr',
    })
  })

  it('keeps an IpcError’s code, message and detail', () => {
    expect(toFailure(new IpcError('INVALID_REQUEST', 'Nope.', 'jobId=x'))).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Nope.',
      detail: 'jobId=x',
    })
  })

  it('replaces the message of an unrecognised error, keeping the original as detail', () => {
    const failure = toFailure(new Error('ENOENT: no such file or directory'))

    expect(failure.code).toBe('UNEXPECTED')
    expect(failure.message).toBe('Something went wrong.')
    expect(failure.detail).toContain('ENOENT')
  })

  it('handles a thrown non-error', () => {
    expect(toFailure('boom')).toMatchObject({ code: 'UNEXPECTED', detail: 'boom' })
  })

  it('produces a structured-clone-safe object', () => {
    expect(() => structuredClone(toFailure(new Error('x')))).not.toThrow()
    expect(() => structuredClone(toFailure(new AppError('WHISPER_FAILED', 'x')))).not.toThrow()
  })
})

describe('toResult', () => {
  it('wraps a value', async () => {
    expect(await toResult(() => 'job-1')).toEqual({ ok: true, value: 'job-1' })
  })

  it('wraps an awaited value', async () => {
    expect(await toResult(async () => 7)).toEqual({ ok: true, value: 7 })
  })

  it('wraps a rejection as data rather than letting it throw', async () => {
    const result = await toResult(async () => {
      throw new AppError('FFMPEG_FAILED', "Couldn't prepare the audio.")
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'FFMPEG_FAILED', message: "Couldn't prepare the audio.", detail: undefined },
    })
  })

  it('wraps a synchronous throw too', async () => {
    const result = await toResult(() => {
      throw new IpcError('INVALID_REQUEST', 'Nope.')
    })

    expect(result.ok).toBe(false)
  })

  it('never rejects', async () => {
    await expect(
      toResult(() => {
        throw new Error('boom')
      }),
    ).resolves.toBeDefined()
  })
})
```

Run: `npx vitest run test/main/ipc/errors.test.ts` — expected FAIL.

- [ ] **Step 2: Implement `src/main/ipc/errors.ts`**

```ts
import { AppError } from '../../shared/errors.js'
import type { IpcErrorCode, IpcFailure, IpcResult } from '../../shared/ipc.js'

/** A boundary rejection: the request itself was wrong, not the operation. */
export class IpcError extends Error {
  readonly code: IpcErrorCode
  readonly detail?: string

  constructor(code: IpcErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Anything that isn't an AppError or an IpcError is a bug, so its message is
 * replaced rather than forwarded — the UI must never surface a bare `ENOENT`.
 * The original text survives in `detail`, behind the disclosure.
 */
export function toFailure(cause: unknown): IpcFailure {
  if (cause instanceof AppError || cause instanceof IpcError) {
    return { code: cause.code, message: cause.message, detail: cause.detail }
  }

  return {
    code: 'UNEXPECTED',
    message: 'Something went wrong.',
    detail: cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : String(cause),
  }
}

export async function toResult<T>(run: () => T | Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (cause) {
    return { ok: false, error: toFailure(cause) }
  }
}
```

Run: `npx vitest run test/main/ipc/errors.test.ts` — expected PASS.

- [ ] **Step 3: Implement `src/main/ipc/validate.ts`**

No separate test file: every validator is exercised through the handler tests that follow, which is where its rejection actually matters.

```ts
import { EXPORT_FORMATS, type ExportFormat, type ModelBaseId } from '../../shared/types.js'
import { MODEL_BASE_ORDER } from '../models/catalog.js'
import { IpcError } from './errors.js'

/** Bounded and quoted: a rejected value is attacker-controlled and ends up in a log. */
function describe(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(value.slice(0, 120))
    : Object.prototype.toString.call(value)
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IpcError(
      'INVALID_REQUEST',
      'That request was not understood.',
      `${field} must be a non-empty string, received ${describe(value)}`,
    )
  }
  return value
}

export function requireModelBaseId(value: unknown): ModelBaseId {
  if (typeof value !== 'string' || !(MODEL_BASE_ORDER as readonly string[]).includes(value)) {
    throw new IpcError(
      'INVALID_REQUEST',
      'That model is not in the catalog.',
      `base=${describe(value)}`,
    )
  }
  return value as ModelBaseId
}

export function requireExportFormat(value: unknown): ExportFormat {
  if (typeof value !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(value)) {
    throw new IpcError(
      'INVALID_REQUEST',
      'That export format is not supported.',
      `format=${describe(value)}`,
    )
  }
  return value as ExportFormat
}
```

- [ ] **Step 4: Write the failing tests for the transcribe handlers**

Create `test/main/ipc/transcribe.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTranscribeHandlers, type JobLike } from '../../../src/main/ipc/transcribe.js'
import type { JobInput } from '../../../src/main/jobs/transcription-job.js'
import type { JobPhase, JobState, ModelId, Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

/** A TranscriptionJob stand-in whose phases the test drives by hand. */
function createFakeJob(input: JobInput) {
  const listeners = new Set<(state: JobState) => void>()
  let resolveStart: () => void = () => {}
  let current: JobState = {
    id: input.id,
    filePath: input.filePath,
    phase: 'probing',
    progress: 0,
    segments: [],
  }

  const emit = (patch: Partial<JobState>): void => {
    current = { ...current, ...patch }
    for (const listener of listeners) listener(current)
  }

  const job: JobLike = {
    id: input.id,
    get state() {
      return current
    },
    start: () =>
      new Promise<void>((resolve) => {
        resolveStart = resolve
      }),
    cancel: () => emit({ phase: 'cancelled' }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return { job, input, emit, finishStart: () => resolveStart() }
}

function harness(overrides: Partial<Parameters<typeof createTranscribeHandlers>[0]> = {}) {
  const created: ReturnType<typeof createFakeJob>[] = []
  const states: JobState[] = []
  const recordThroughput = vi.fn(async () => undefined)
  let counter = 0

  const handlers = createTranscribeHandlers({
    newJobId: () => `job-${++counter}`,
    readSettings: async () => SETTINGS,
    modelPathFor: (id: ModelId) => `/models/${id}.bin`,
    isInstalled: async () => true,
    createJob: (input) => {
      const fake = createFakeJob(input)
      created.push(fake)
      return fake.job
    },
    recordThroughput,
    emitState: (state) => states.push(state),
    ...overrides,
  })

  return { handlers, created, states, recordThroughput }
}

const done = (durationMs = 10_000): Partial<JobState> => ({
  phase: 'done' as JobPhase,
  progress: 1,
  realtimeFactor: durationMs / 1_000,
})

describe('transcribe.start', () => {
  it('returns a job id generated in main, not anything the caller supplied', async () => {
    const { handlers, created } = harness()
    const id = await handlers.start('/videos/interview.mp4')

    expect(id).toBe('job-1')
    expect(created[0]?.input.id).toBe('job-1')
  })

  it('passes the dropped path through unchanged — it is the one path from outside', async () => {
    const { handlers, created } = harness()
    await handlers.start('/videos/weird name (1).m4v')

    expect(created[0]?.input.filePath).toBe('/videos/weird name (1).m4v')
  })

  it('rejects a non-string or empty file path', async () => {
    const { handlers } = harness()

    await expect(handlers.start(42)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.start('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.start(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('resolves the model against the English-only toggle', async () => {
    const { handlers, created } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    await handlers.start('/a.wav')

    expect(created[0]?.input.modelPath).toBe('/models/base.en.bin')
  })

  it('forces language to en while English-only is on', async () => {
    const { handlers, created } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true, language: 'fr' }),
    })
    await handlers.start('/a.wav')

    expect(created[0]?.input.language).toBe('en')
  })

  it('passes the chosen language through when English-only is off', async () => {
    const { handlers, created } = harness({
      readSettings: async () => ({ ...SETTINGS, language: 'fr' }),
    })
    await handlers.start('/a.wav')

    expect(created[0]?.input.language).toBe('fr')
  })

  it('refuses with NO_MODEL_INSTALLED when no model is chosen', async () => {
    const { handlers } = harness({ readSettings: async () => ({ ...SETTINGS, activeModel: null }) })

    await expect(handlers.start('/a.wav')).rejects.toMatchObject({ code: 'NO_MODEL_INSTALLED' })
  })

  it('refuses with MODEL_FILE_MISSING when the resolved model is not on disk', async () => {
    const { handlers } = harness({ isInstalled: async () => false })

    await expect(handlers.start('/a.wav')).rejects.toMatchObject({ code: 'MODEL_FILE_MISSING' })
  })

  it('refuses a second job while one is running', async () => {
    const { handlers } = harness()
    await handlers.start('/a.wav')

    await expect(handlers.start('/b.wav')).rejects.toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
    })
  })

  it('refuses a second job that races the first across its first await', async () => {
    const { handlers, created } = harness()
    const results = await Promise.allSettled([handlers.start('/a.wav'), handlers.start('/b.wav')])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(created).toHaveLength(1)
  })

  it('allows a new job once the previous one finishes', async () => {
    const { handlers, created } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit(done())

    await expect(handlers.start('/b.wav')).resolves.toBe('job-2')
  })

  it('allows a new job once the previous one is cancelled', async () => {
    const { handlers } = harness()
    const id = await handlers.start('/a.wav')
    await handlers.cancel(id)

    await expect(handlers.start('/b.wav')).resolves.toBe('job-2')
  })

  it('allows a new job once the previous one fails', async () => {
    const { handlers, created } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit({ phase: 'failed', error: { code: 'WHISPER_FAILED', message: 'boom' } })

    await expect(handlers.start('/b.wav')).resolves.toBe('job-2')
  })

  it('forwards every state update to the renderer', async () => {
    const { handlers, created, states } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit({ phase: 'transcribing', progress: 0.5 })

    expect(states.at(-1)).toMatchObject({ phase: 'transcribing', progress: 0.5 })
  })

  it('records measured throughput against the resolved model id on completion', async () => {
    const { handlers, created, recordThroughput } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    await handlers.start('/a.wav')
    created[0]?.emit(done(12_000))

    expect(recordThroughput).toHaveBeenCalledWith('base.en', 12)
  })

  it('records throughput once, not on every later update', async () => {
    const { handlers, created, recordThroughput } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit(done())
    created[0]?.emit(done())

    expect(recordThroughput).toHaveBeenCalledTimes(1)
  })

  it('does not record throughput for a cancelled or failed job', async () => {
    const { handlers, recordThroughput } = harness()
    const id = await handlers.start('/a.wav')
    await handlers.cancel(id)

    expect(recordThroughput).not.toHaveBeenCalled()
  })

  it('survives a throughput write that rejects', async () => {
    const { handlers, created } = harness({
      recordThroughput: async () => {
        throw new Error('disk full')
      },
    })
    await handlers.start('/a.wav')

    expect(() => created[0]?.emit(done())).not.toThrow()
  })
})

describe('transcribe.cancel', () => {
  it('cancels a known job', async () => {
    const { handlers, created } = harness()
    const id = await handlers.start('/a.wav')
    await handlers.cancel(id)

    expect(created[0]?.job.state.phase).toBe('cancelled')
  })

  it('rejects an unknown job id rather than treating it as anything else', async () => {
    const { handlers } = harness()
    await handlers.start('/a.wav')

    await expect(handlers.cancel('job-999')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a path-shaped job id', async () => {
    const { handlers } = harness()

    await expect(handlers.cancel('../../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects a non-string job id', async () => {
    const { handlers } = harness()

    await expect(handlers.cancel({ id: 'job-1' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe('transcribe.stateOf', () => {
  it('returns the state of a known job', async () => {
    const { handlers } = harness()
    const id = await handlers.start('/a.wav')

    expect(handlers.stateOf(id)?.filePath).toBe('/a.wav')
  })

  it('returns undefined for an unknown job', () => {
    const { handlers } = harness()

    expect(handlers.stateOf('nope')).toBeUndefined()
  })

  it('forgets the previous job once a new one starts, so nothing accumulates', async () => {
    const { handlers, created } = harness()
    const first = await handlers.start('/a.wav')
    created[0]?.emit(done())
    await handlers.start('/b.wav')

    expect(handlers.stateOf(first)).toBeUndefined()
  })
})

describe('transcribe.cancelActive', () => {
  it('cancels the running job and waits for its cleanup to finish', async () => {
    const { handlers, created } = harness()
    await handlers.start('/a.wav')

    let settled = false
    const quit = handlers.cancelActive().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(created[0]?.job.state.phase).toBe('cancelled')
    expect(settled).toBe(false)

    created[0]?.finishStart()
    await quit
    expect(settled).toBe(true)
  })

  it('resolves immediately when nothing is running', async () => {
    const { handlers } = harness()

    await expect(handlers.cancelActive()).resolves.toBeUndefined()
  })
})
```

Run: `npx vitest run test/main/ipc/transcribe.test.ts` — expected FAIL.

- [ ] **Step 5: Implement `src/main/ipc/transcribe.ts`**

```ts
import { AppError } from '../../shared/errors.js'
import type { JobPhase, JobState, ModelId, Settings, Unsubscribe } from '../../shared/types.js'
import type { JobInput } from '../jobs/transcription-job.js'
import { resolveModelId } from '../models/catalog.js'
import { IpcError } from './errors.js'
import { requireNonEmptyString } from './validate.js'

/** The part of `TranscriptionJob` this module uses, so tests can inject a fake. */
export type JobLike = {
  readonly id: string
  readonly state: JobState
  start(): Promise<void>
  cancel(): void
  subscribe(listener: (state: JobState) => void): Unsubscribe
}

export type TranscribeDeps = {
  newJobId: () => string
  readSettings: () => Promise<Settings>
  modelPathFor: (id: ModelId) => string
  isInstalled: (id: ModelId) => Promise<boolean>
  createJob: (input: JobInput) => JobLike
  recordThroughput: (id: ModelId, realtimeFactor: number) => Promise<unknown>
  emitState: (state: JobState) => void
}

export type TranscribeHandlers = {
  start(filePath: unknown): Promise<string>
  cancel(jobId: unknown): Promise<void>
  /** For the export handler. Not reachable over IPC. */
  stateOf(jobId: string): JobState | undefined
  /** For `before-quit`: cancel and wait for the temp WAV to be deleted. */
  cancelActive(): Promise<void>
}

function isTerminal(phase: JobPhase): boolean {
  return phase === 'done' || phase === 'cancelled' || phase === 'failed'
}

export function createTranscribeHandlers(deps: TranscribeDeps): TranscribeHandlers {
  // The id is a key here and nothing else. It is generated in main and never
  // reaches a path builder the renderer can influence.
  const jobs = new Map<string, JobLike>()
  let activeId: string | null = null
  // Set before the first await so two starts racing across it can't both pass
  // the busy check.
  let starting = false
  let activeRun: Promise<void> = Promise.resolve()

  async function start(filePath: unknown): Promise<string> {
    const path = requireNonEmptyString(filePath, 'filePath')

    if (starting || activeId !== null) {
      throw new IpcError(
        'JOB_ALREADY_RUNNING',
        'whisper-drop transcribes one file at a time. Cancel the current one first.',
      )
    }
    starting = true

    try {
      const settings = await deps.readSettings()
      if (settings.activeModel === null) {
        throw new AppError('NO_MODEL_INSTALLED', 'Choose a model first.')
      }

      const modelId = resolveModelId(settings.activeModel, settings.englishOnly)
      if (!(await deps.isInstalled(modelId))) {
        throw new AppError(
          'MODEL_FILE_MISSING',
          "That model isn't on disk anymore.",
          `model=${modelId}`,
        )
      }

      const id = deps.newJobId()
      const job = deps.createJob({
        id,
        filePath: path,
        modelPath: deps.modelPathFor(modelId),
        language: settings.englishOnly ? 'en' : settings.language,
      })

      // Starting a new file means the UI has left Done, so the previous job's
      // segments are unreachable. Clearing here is what keeps the map at one
      // entry instead of retaining every transcript of the session.
      jobs.clear()
      jobs.set(id, job)
      activeId = id

      let recorded = false
      job.subscribe((state) => {
        deps.emitState(state)

        if (!recorded && state.phase === 'done' && state.realtimeFactor !== undefined) {
          recorded = true
          void deps.recordThroughput(modelId, state.realtimeFactor).catch(() => {})
        }

        if (isTerminal(state.phase) && activeId === id) activeId = null
      })

      activeRun = job.start()
      void activeRun.catch(() => {})

      return id
    } finally {
      starting = false
    }
  }

  async function cancel(jobId: unknown): Promise<void> {
    const id = requireNonEmptyString(jobId, 'jobId')
    const job = jobs.get(id)
    if (!job) {
      throw new IpcError('INVALID_REQUEST', 'That transcription is no longer running.', `jobId=${id}`)
    }
    job.cancel()
  }

  function stateOf(jobId: string): JobState | undefined {
    return jobs.get(jobId)?.state
  }

  async function cancelActive(): Promise<void> {
    if (activeId !== null) jobs.get(activeId)?.cancel()
    await activeRun.catch(() => {})
  }

  return { start, cancel, stateOf, cancelActive }
}
```

Run: `npx vitest run test/main/ipc/transcribe.test.ts` — expected PASS, 24 tests.

- [ ] **Step 6: Write the failing tests for the model handlers**

Create `test/main/ipc/models.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createModelHandlers, type ModelsDeps } from '../../../src/main/ipc/models.js'
import type { DownloadProgress, ModelId, Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (cause: unknown) => void }

function deferred(): Deferred {
  let resolve: () => void = () => {}
  let reject: (cause: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(overrides: Partial<ModelsDeps> = {}) {
  const installs: { id: ModelId; signal: AbortSignal; onProgress: (p: DownloadProgress) => void }[] =
    []
  const gate = deferred()
  const removed: ModelId[] = []
  const emitted: DownloadProgress[] = []

  const handlers = createModelHandlers({
    readSettings: async () => SETTINGS,
    isInstalled: async () => false,
    install: async (id, options) => {
      installs.push({ id, ...options })
      await gate.promise
    },
    remove: async (id) => {
      removed.push(id)
    },
    emitProgress: (progress) => emitted.push(progress),
    ...overrides,
  })

  return { handlers, installs, removed, emitted, gate }
}

const progress = (received: number): DownloadProgress => ({
  id: 'base',
  receivedBytes: received,
  totalBytes: 147_951_465,
  bytesPerSecond: 1_000_000,
})

describe('models.list', () => {
  it('returns one row per picker row, in capability order', async () => {
    const { handlers } = harness()

    expect((await handlers.list()).map((row) => row.base)).toEqual([
      'tiny',
      'base',
      'small',
      'large-v3-turbo',
      'large-v3',
    ])
  })

  it('resolves each row against the English-only toggle', async () => {
    const { handlers } = harness({ readSettings: async () => ({ ...SETTINGS, englishOnly: true }) })
    const rows = await handlers.list()

    expect(rows.map((row) => row.resolved.id)).toEqual([
      'tiny.en',
      'base.en',
      'small.en',
      'large-v3-turbo',
      'large-v3',
    ])
  })

  it('reports install state per resolved model', async () => {
    const { handlers } = harness({ isInstalled: async (id) => id === 'small' })
    const rows = await handlers.list()

    expect(rows.find((row) => row.base === 'small')?.installed).toBe(true)
    expect(rows.find((row) => row.base === 'base')?.installed).toBe(false)
  })

  it('shows a measured realtime factor only for models actually run here', async () => {
    const { handlers } = harness({
      readSettings: async () => ({
        ...SETTINGS,
        throughput: { base: { realtimeFactor: 12.5, samples: 3 } },
      }),
    })
    const rows = await handlers.list()

    expect(rows.find((row) => row.base === 'base')?.realtimeFactor).toBe(12.5)
    expect(rows.find((row) => row.base === 'tiny')?.realtimeFactor).toBeUndefined()
  })

  it('reads throughput for the resolved id, not the row, so the toggle swaps it too', async () => {
    const { handlers } = harness({
      readSettings: async () => ({
        ...SETTINGS,
        englishOnly: true,
        throughput: { base: { realtimeFactor: 12.5, samples: 3 } },
      }),
    })
    const rows = await handlers.list()

    expect(rows.find((row) => row.base === 'base')?.realtimeFactor).toBeUndefined()
  })

  it('reports an in-flight download on its row', async () => {
    const { handlers, installs } = harness()
    void handlers.download('base')
    await Promise.resolve()
    installs[0]?.onProgress(progress(1_000))

    const rows = await handlers.list()
    expect(rows.find((row) => row.base === 'base')?.downloading?.receivedBytes).toBe(1_000)
    expect(rows.find((row) => row.base === 'tiny')?.downloading).toBeUndefined()
  })
})

describe('models.download', () => {
  it('installs the model the row resolves to', async () => {
    const { handlers, installs, gate } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    const running = handlers.download('small')
    gate.resolve()
    await running

    expect(installs[0]?.id).toBe('small.en')
  })

  it('forwards progress to the renderer', async () => {
    const { handlers, installs, emitted } = harness()
    void handlers.download('base')
    await Promise.resolve()
    installs[0]?.onProgress(progress(2_000))

    expect(emitted).toEqual([progress(2_000)])
  })

  it('joins an in-flight download instead of starting a second one', async () => {
    const { handlers, installs, gate } = harness()
    const first = handlers.download('base')
    const second = handlers.download('base')
    gate.resolve()
    await Promise.all([first, second])

    expect(installs).toHaveLength(1)
  })

  it('rejects a base id that is not a catalog row', async () => {
    const { handlers } = harness()

    await expect(handlers.download('huge')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.download('../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(handlers.download('tiny.en')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.download(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('propagates a real download failure', async () => {
    const { handlers } = harness({
      install: async () => {
        throw Object.assign(new Error('nope'), { code: 'DOWNLOAD_NETWORK_ERROR' })
      },
    })

    await expect(handlers.download('base')).rejects.toThrow('nope')
  })

  it('allows a retry after a failure', async () => {
    let attempts = 0
    const { handlers } = harness({
      install: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('nope')
      },
    })

    await expect(handlers.download('base')).rejects.toThrow('nope')
    await expect(handlers.download('base')).resolves.toBeUndefined()
  })
})

describe('models.cancelDownload', () => {
  it('aborts the in-flight download for that row', async () => {
    const { handlers, installs } = harness()
    void handlers.download('base')
    await Promise.resolve()
    await handlers.cancelDownload('base')

    expect(installs[0]?.signal.aborted).toBe(true)
  })

  it('resolves rather than erroring when nothing is downloading', async () => {
    const { handlers } = harness()

    await expect(handlers.cancelDownload('base')).resolves.toBeUndefined()
  })

  it('reports a cancelled download as success, not as an error', async () => {
    const abort = vi.fn()
    const { handlers, installs } = harness({
      install: async (_id, options) => {
        abort()
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve))
        throw new Error('downloadModel: aborted')
      },
    })

    const running = handlers.download('base')
    await Promise.resolve()
    await handlers.cancelDownload('base')

    await expect(running).resolves.toBeUndefined()
    expect(installs).toHaveLength(0)
    expect(abort).toHaveBeenCalled()
  })

  it('rejects a base id that is not a catalog row', async () => {
    const { handlers } = harness()

    await expect(handlers.cancelDownload('nope')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe('models.remove', () => {
  it('removes the model the row resolves to', async () => {
    const { handlers, removed } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    await handlers.remove('tiny')

    expect(removed).toEqual(['tiny.en'])
  })

  it('rejects a base id that is not a catalog row before touching the store', async () => {
    const { handlers, removed } = harness()

    await expect(handlers.remove('../../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(removed).toEqual([])
  })
})
```

- [ ] **Step 7: Implement `src/main/ipc/models.ts`**

```ts
import type { ModelRow } from '../../shared/ipc.js'
import type { DownloadProgress, ModelBaseId, ModelId, Settings } from '../../shared/types.js'
import { MODEL_BASE_ORDER, entryFor, resolveModelId } from '../models/catalog.js'
import { requireModelBaseId } from './validate.js'

export type ModelsDeps = {
  readSettings: () => Promise<Settings>
  isInstalled: (id: ModelId) => Promise<boolean>
  install: (
    id: ModelId,
    options: { onProgress: (progress: DownloadProgress) => void; signal: AbortSignal },
  ) => Promise<void>
  remove: (id: ModelId) => Promise<void>
  emitProgress: (progress: DownloadProgress) => void
}

export type ModelHandlers = {
  list(): Promise<ModelRow[]>
  download(base: unknown): Promise<void>
  cancelDownload(base: unknown): Promise<void>
  remove(base: unknown): Promise<void>
}

type Pending = {
  controller: AbortController
  promise: Promise<void>
  latest?: DownloadProgress
}

export function createModelHandlers(deps: ModelsDeps): ModelHandlers {
  // Keyed by picker row, not by concrete id: the row is what the user clicked,
  // and it is what Cancel and the progress bar are attached to.
  const pending = new Map<ModelBaseId, Pending>()

  async function list(): Promise<ModelRow[]> {
    const settings = await deps.readSettings()

    return Promise.all(
      MODEL_BASE_ORDER.map(async (base): Promise<ModelRow> => {
        const resolved = entryFor(resolveModelId(base, settings.englishOnly))
        return {
          base,
          resolved,
          installed: await deps.isInstalled(resolved.id),
          realtimeFactor: settings.throughput[resolved.id]?.realtimeFactor,
          downloading: pending.get(base)?.latest,
        }
      }),
    )
  }

  // `async` so a validation failure arrives as a rejection like every other
  // handler's. The body still registers into `pending` before its first await,
  // which is what makes the double-click guard below race-free.
  async function download(base: unknown): Promise<void> {
    const row = requireModelBaseId(base)

    const existing = pending.get(row)
    if (existing) return existing.promise

    const controller = new AbortController()
    const record: Pending = { controller, promise: Promise.resolve() }
    // Registered before the first await, so a double-clicked button joins this
    // download rather than starting a second one with its own controller.
    pending.set(row, record)

    record.promise = (async () => {
      try {
        const settings = await deps.readSettings()
        await deps.install(resolveModelId(row, settings.englishOnly), {
          signal: controller.signal,
          onProgress: (progress) => {
            record.latest = progress
            deps.emitProgress(progress)
          },
        })
      } catch (cause) {
        // Cancellation is not an error. Part 2 rejects with a plain Error on
        // abort and keeps the `.part` file, so Retry resumes.
        if (!controller.signal.aborted) throw cause
      } finally {
        pending.delete(row)
      }
    })()

    return record.promise
  }

  async function cancelDownload(base: unknown): Promise<void> {
    pending.get(requireModelBaseId(base))?.controller.abort()
  }

  async function remove(base: unknown): Promise<void> {
    const row = requireModelBaseId(base)
    const settings = await deps.readSettings()
    await deps.remove(resolveModelId(row, settings.englishOnly))
  }

  return { list, download, cancelDownload, remove }
}
```

Run: `npx vitest run test/main/ipc/models.test.ts` — expected PASS, 18 tests.

Note on `download` being `async`: an earlier draft made it a plain function so the synchronous `pending.set` was obvious, and a validation failure then threw synchronously instead of rejecting. `ipcMain.handle`'s wrapper catches both, but every caller in the renderer would have had to. Marking it `async` fixes that without losing the synchronous registration, because an async body runs synchronously up to its first `await`. **This was caught by running the tests, not by reading the code.**

Note on `remove`: it deliberately does not clear `activeModel`. Removing the active model leaves `transcribe.start` refusing with `MODEL_FILE_MISSING`, whose UI action is "download it again" — which is a better outcome than silently deselecting.

- [ ] **Step 8: Write the failing tests for the settings handlers**

Create `test/main/ipc/settings.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createSettingsHandlers } from '../../../src/main/ipc/settings.js'
import type { Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: { base: { realtimeFactor: 9, samples: 2 } },
}

function harness() {
  const write = vi.fn(async (patch: Partial<Settings>) => ({ ...SETTINGS, ...patch }))
  const handlers = createSettingsHandlers({ read: async () => SETTINGS, write })
  return { handlers, write }
}

describe('settings.get', () => {
  it('returns the persisted settings', async () => {
    const { handlers } = harness()

    expect(await handlers.get()).toEqual(SETTINGS)
  })
})

describe('settings.set', () => {
  it('writes englishOnly', async () => {
    const { handlers, write } = harness()
    const result = await handlers.set({ englishOnly: true })

    expect(write).toHaveBeenCalledWith({ englishOnly: true })
    expect(result.englishOnly).toBe(true)
  })

  it('writes activeModel, including null', async () => {
    const { handlers, write } = harness()
    await handlers.set({ activeModel: 'large-v3-turbo' })
    await handlers.set({ activeModel: null })

    expect(write).toHaveBeenNthCalledWith(1, { activeModel: 'large-v3-turbo' })
    expect(write).toHaveBeenNthCalledWith(2, { activeModel: null })
  })

  it('writes an ISO 639-1 language and auto', async () => {
    const { handlers, write } = harness()
    await handlers.set({ language: 'fr' })
    await handlers.set({ language: 'auto' })

    expect(write).toHaveBeenNthCalledWith(1, { language: 'fr' })
    expect(write).toHaveBeenNthCalledWith(2, { language: 'auto' })
  })

  it('rejects a patch that is not a plain object', async () => {
    const { handlers, write } = harness()

    for (const patch of [null, 'englishOnly', 42, ['englishOnly']]) {
      await expect(handlers.set(patch)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects an unknown key rather than dropping it silently', async () => {
    const { handlers, write } = harness()

    await expect(handlers.set({ modelsDir: '/tmp' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses to let the renderer write throughput — it is measured, not asserted', async () => {
    const { handlers } = harness()

    await expect(
      handlers.set({ throughput: { base: { realtimeFactor: 999, samples: 1 } } }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('refuses to let the renderer set version', async () => {
    const { handlers } = harness()

    await expect(handlers.set({ version: 2 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a mistyped englishOnly', async () => {
    const { handlers } = harness()

    await expect(handlers.set({ englishOnly: 'yes' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects an activeModel that is not a picker row', async () => {
    const { handlers } = harness()

    await expect(handlers.set({ activeModel: 'base.en' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(handlers.set({ activeModel: '../../etc' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects a language that is not auto or an ISO 639-1 code', async () => {
    const { handlers } = harness()

    for (const language of ['english', 'EN', '', '-l --output-file /etc/x', 42]) {
      await expect(handlers.set({ language })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
  })

  it('rejects the whole patch when any key is bad, rather than writing the good half', async () => {
    const { handlers, write } = harness()

    await expect(handlers.set({ englishOnly: true, language: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('accepts an empty patch', async () => {
    const { handlers, write } = harness()
    await handlers.set({})

    expect(write).toHaveBeenCalledWith({})
  })
})
```

- [ ] **Step 9: Implement `src/main/ipc/settings.ts`**

```ts
import type { ModelBaseId, Settings } from '../../shared/types.js'
import { MODEL_BASE_ORDER } from '../models/catalog.js'
import { IpcError } from './errors.js'

export type SettingsDeps = {
  read: () => Promise<Settings>
  write: (patch: Partial<Settings>) => Promise<Settings>
}

export type SettingsHandlers = {
  get(): Promise<Settings>
  set(patch: unknown): Promise<Settings>
}

/** 'auto', or an ISO 639-1 code. Reaches whisper-cli as an argv element. */
const LANGUAGE = /^([a-z]{2}|auto)$/

const WRITABLE_KEYS = new Set(['englishOnly', 'activeModel', 'language'])

function reject(detail: string): never {
  throw new IpcError('INVALID_REQUEST', 'That settings change was not understood.', detail)
}

/**
 * The store re-validates everything it writes, but `throughput` and `version`
 * are not the renderer's to set at all — throughput is measured, not asserted —
 * so unknown and read-only keys are refused here rather than silently dropped.
 */
export function createSettingsHandlers(deps: SettingsDeps): SettingsHandlers {
  async function set(patch: unknown): Promise<Settings> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      reject(`patch must be an object, received ${Object.prototype.toString.call(patch)}`)
    }

    const entries = Object.entries(patch as Record<string, unknown>)
    const clean: Partial<Settings> = {}

    for (const [key, value] of entries) {
      if (!WRITABLE_KEYS.has(key)) reject(`unknown or read-only key ${JSON.stringify(key)}`)

      if (key === 'englishOnly') {
        if (typeof value !== 'boolean') reject('englishOnly must be a boolean')
        clean.englishOnly = value
      }

      if (key === 'activeModel') {
        if (value !== null && !(MODEL_BASE_ORDER as readonly unknown[]).includes(value)) {
          reject(`activeModel must be null or a catalog row, received ${JSON.stringify(value)}`)
        }
        clean.activeModel = value as ModelBaseId | null
      }

      if (key === 'language') {
        if (typeof value !== 'string' || !LANGUAGE.test(value)) {
          reject(`language must be 'auto' or an ISO 639-1 code, received ${JSON.stringify(value)}`)
        }
        clean.language = value
      }
    }

    return deps.write(clean)
  }

  return { get: () => deps.read(), set }
}
```

Run: `npx vitest run test/main/ipc/settings.test.ts` — expected PASS, 13 tests.

- [ ] **Step 10: Write the failing tests for `save.ts`**

Create `test/main/export/save.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { candidatePath, saveTranscript } from '../../../src/main/export/save.js'
import type { Segment } from '../../../src/shared/types.js'

const SEGMENTS: Segment[] = [
  { index: 0, startMs: 0, endMs: 2_000, text: 'Hello there.' },
  { index: 1, startMs: 2_000, endMs: 4_500, text: 'This is a test.' },
]

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whisper-drop-save-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('candidatePath', () => {
  it('swaps the extension for the export format', () => {
    expect(candidatePath('/videos/interview.mp4', 'srt', 1)).toBe('/videos/interview.srt')
  })

  it('appends " (2)" for the second attempt', () => {
    expect(candidatePath('/videos/interview.mp4', 'srt', 2)).toBe('/videos/interview (2).srt')
  })

  it('keeps counting past two', () => {
    expect(candidatePath('/videos/interview.mp4', 'txt', 7)).toBe('/videos/interview (7).txt')
  })

  it('handles a source file with no extension', () => {
    expect(candidatePath('/videos/memo', 'txt', 1)).toBe('/videos/memo.txt')
  })

  it('strips only the last extension of a double extension', () => {
    expect(candidatePath('/videos/archive.tar.gz', 'txt', 1)).toBe('/videos/archive.tar.txt')
  })

  it('keeps a name that already contains a bracketed number', () => {
    expect(candidatePath('/videos/take (2).mp4', 'srt', 1)).toBe('/videos/take (2).srt')
    expect(candidatePath('/videos/take (2).mp4', 'srt', 2)).toBe('/videos/take (2) (2).srt')
  })
})

describe('saveTranscript', () => {
  it('writes next to the source file with the same basename', async () => {
    const path = await saveTranscript({
      segments: SEGMENTS,
      sourcePath: join(dir, 'interview.mp4'),
      as: 'srt',
    })

    expect(path).toBe(join(dir, 'interview.srt'))
    expect(await readFile(path, 'utf8')).toContain('00:00:00,000 --> 00:00:02,000')
  })

  it('writes the format the caller asked for', async () => {
    const source = join(dir, 'a.wav')

    expect(await readFile(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'txt' }), 'utf8'))
      .toBe('Hello there.\nThis is a test.\n')
    expect(await readFile(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'vtt' }), 'utf8'))
      .toContain('WEBVTT')
  })

  it('appends " (2)" rather than overwriting an existing file', async () => {
    const source = join(dir, 'interview.mp4')
    await writeFile(join(dir, 'interview.srt'), 'do not touch me', 'utf8')

    const path = await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'srt' })

    expect(path).toBe(join(dir, 'interview (2).srt'))
    expect(await readFile(join(dir, 'interview.srt'), 'utf8')).toBe('do not touch me')
  })

  it('keeps counting up when " (2)" is also taken', async () => {
    const source = join(dir, 'interview.mp4')
    await writeFile(join(dir, 'interview.srt'), 'x', 'utf8')
    await writeFile(join(dir, 'interview (2).srt'), 'x', 'utf8')

    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'srt' })).toBe(
      join(dir, 'interview (3).srt'),
    )
  })

  it('treats each format separately, so saving all three collides with none', async () => {
    const source = join(dir, 'interview.mp4')

    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'txt' })).toBe(
      join(dir, 'interview.txt'),
    )
    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'srt' })).toBe(
      join(dir, 'interview.srt'),
    )
    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'vtt' })).toBe(
      join(dir, 'interview.vtt'),
    )
  })

  it('writes an empty transcript rather than failing', async () => {
    const path = await saveTranscript({ segments: [], sourcePath: join(dir, 'silent.wav'), as: 'txt' })

    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('propagates a real filesystem error instead of looping', async () => {
    await expect(
      saveTranscript({
        segments: SEGMENTS,
        sourcePath: join(dir, 'missing-folder', 'a.mp4'),
        as: 'txt',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
```

- [ ] **Step 11: Implement `src/main/export/save.ts`**

```ts
import { writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import type { ExportFormat, Segment } from '../../shared/types.js'
import { format } from './formatters.js'

/** Enough to be certain the loop terminates; a real folder never gets here. */
const MAX_ATTEMPTS = 999

export type SaveOptions = {
  segments: Segment[]
  /** The media file the transcript came from. Always a path main already holds. */
  sourcePath: string
  as: ExportFormat
}

/**
 * `interview.mp4` -> `interview.srt`, then `interview (2).srt`.
 *
 * `parse().name` strips one extension only, so `archive.tar.gz` becomes
 * `archive.tar.srt` — which is the honest answer for a double extension.
 */
export function candidatePath(sourcePath: string, as: ExportFormat, attempt: number): string {
  const { dir, name } = parse(sourcePath)
  const suffix = attempt === 1 ? '' : ` (${attempt})`
  return join(dir, `${name}${suffix}.${as}`)
}

/**
 * Write next to the source file, never overwriting. `wx` makes the
 * existence check and the write one step, so nothing can land in the gap
 * between them.
 */
export async function saveTranscript(options: SaveOptions): Promise<string> {
  const text = format(options.segments, options.as)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const target = candidatePath(options.sourcePath, options.as, attempt)
    try {
      await writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
      return target
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    }
  }

  throw new Error(
    `saveTranscript: ${MAX_ATTEMPTS} names already taken beside ${options.sourcePath}`,
  )
}
```

Run: `npx vitest run test/main/export/save.test.ts` — expected PASS, 13 tests.

- [ ] **Step 12: Write the failing tests for the export and dialog handlers**

Create `test/main/ipc/export.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createExportHandlers, type ExportDeps } from '../../../src/main/ipc/export.js'
import { AppError } from '../../../src/shared/errors.js'
import type { JobState } from '../../../src/shared/types.js'

const DONE: JobState = {
  id: 'job-1',
  filePath: '/videos/interview.mp4',
  phase: 'done',
  progress: 1,
  segments: [{ index: 0, startMs: 0, endMs: 1_000, text: 'Hello.' }],
}

function harness(overrides: Partial<ExportDeps> = {}) {
  const revealed: string[] = []
  const writeTranscript = vi.fn(
    async (options: { sourcePath: string; as: string }) =>
      `${options.sourcePath.replace(/\.[^.]+$/, '')}.${options.as}`,
  )

  const handlers = createExportHandlers({
    lookupJob: (jobId) => (jobId === DONE.id ? DONE : undefined),
    writeTranscript,
    reveal: (path) => revealed.push(path),
    ...overrides,
  })

  return { handlers, revealed, writeTranscript }
}

describe('exportTranscript.save', () => {
  it('writes next to the source file with the same basename', async () => {
    const { handlers } = harness()

    expect(await handlers.save('job-1', 'srt')).toBe('/videos/interview.srt')
  })

  it('passes the source path from main’s own record, never from the caller', async () => {
    const { handlers, writeTranscript } = harness()
    await handlers.save('job-1', 'txt')

    expect(writeTranscript).toHaveBeenCalledWith({
      segments: DONE.segments,
      sourcePath: '/videos/interview.mp4',
      as: 'txt',
    })
  })

  it('accepts exactly the three formats', async () => {
    const { handlers } = harness()

    for (const format of ['txt', 'srt', 'vtt']) {
      await expect(handlers.save('job-1', format)).resolves.toContain(`.${format}`)
    }
  })

  it('rejects any other format', async () => {
    const { handlers, writeTranscript } = harness()

    for (const format of ['pdf', 'TXT', '', '../../x', null, { as: 'txt' }]) {
      await expect(handlers.save('job-1', format)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(writeTranscript).not.toHaveBeenCalled()
  })

  it('rejects an unknown job id', async () => {
    const { handlers } = harness()

    await expect(handlers.save('job-999', 'txt')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects a non-string job id', async () => {
    const { handlers } = harness()

    await expect(handlers.save(null, 'txt')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a job that has not finished', async () => {
    const { handlers } = harness({
      lookupJob: () => ({ ...DONE, phase: 'transcribing', progress: 0.4 }),
    })

    await expect(handlers.save('job-1', 'txt')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('turns a raw filesystem error into a plain-language failure', async () => {
    const { handlers } = harness({
      writeTranscript: async () => {
        throw Object.assign(new Error('EACCES: permission denied, open /videos/interview.srt'), {
          code: 'EACCES',
        })
      },
    })

    const failure = await handlers.save('job-1', 'srt').catch((cause: unknown) => cause)
    expect(failure).toMatchObject({ code: 'UNEXPECTED' })
    expect((failure as Error).message).not.toContain('EACCES')
    expect((failure as { detail: string }).detail).toContain('EACCES')
  })

  it('passes an AppError through unchanged', async () => {
    const { handlers } = harness({
      writeTranscript: async () => {
        throw new AppError('INSUFFICIENT_DISK_SPACE', 'Not enough free space.')
      },
    })

    await expect(handlers.save('job-1', 'srt')).rejects.toMatchObject({
      code: 'INSUFFICIENT_DISK_SPACE',
    })
  })
})

describe('shell.reveal', () => {
  it('reveals a path this process returned from save', async () => {
    const { handlers, revealed } = harness()
    const path = await handlers.save('job-1', 'srt')
    await handlers.reveal(path)

    expect(revealed).toEqual(['/videos/interview.srt'])
  })

  it('refuses a path the renderer made up', async () => {
    const { handlers, revealed } = harness()
    await handlers.save('job-1', 'srt')

    for (const path of ['/etc/passwd', '/videos/interview.mp4', '/videos/interview.srt/../..']) {
      await expect(handlers.reveal(path)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(revealed).toEqual([])
  })

  it('refuses everything before anything has been saved', async () => {
    const { handlers } = harness()

    await expect(handlers.reveal('/videos/interview.srt')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('refuses a non-string path', async () => {
    const { handlers } = harness()

    await expect(handlers.reveal(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('remembers every saved path, not only the last', async () => {
    const { handlers, revealed } = harness()
    const txt = await handlers.save('job-1', 'txt')
    const srt = await handlers.save('job-1', 'srt')

    await handlers.reveal(txt)
    await handlers.reveal(srt)
    expect(revealed).toEqual([txt, srt])
  })
})
```

Create `test/main/ipc/dialog.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createDialogHandlers } from '../../../src/main/ipc/dialog.js'

describe('dialog.openFile', () => {
  it('returns the chosen path', async () => {
    const handlers = createDialogHandlers({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/videos/a.mp4'] }),
    })

    expect(await handlers.openFile()).toBe('/videos/a.mp4')
  })

  it('returns null when the user cancels', async () => {
    const handlers = createDialogHandlers({
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    })

    expect(await handlers.openFile()).toBeNull()
  })

  it('returns null when the dialog reports success with no path', async () => {
    const handlers = createDialogHandlers({
      showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
    })

    expect(await handlers.openFile()).toBeNull()
  })

  it('takes the first path when several come back', async () => {
    const handlers = createDialogHandlers({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/a.mp4', '/b.mp4'] }),
    })

    expect(await handlers.openFile()).toBe('/a.mp4')
  })
})
```

- [ ] **Step 13: Implement `src/main/ipc/export.ts` and `src/main/ipc/dialog.ts`**

`src/main/ipc/export.ts`:

```ts
import { AppError } from '../../shared/errors.js'
import type { ExportFormat, JobState, Segment } from '../../shared/types.js'
import { IpcError } from './errors.js'
import { requireExportFormat, requireNonEmptyString } from './validate.js'

export type ExportDeps = {
  lookupJob: (jobId: string) => JobState | undefined
  writeTranscript: (options: {
    segments: Segment[]
    sourcePath: string
    as: ExportFormat
  }) => Promise<string>
  reveal: (path: string) => void
}

export type ExportHandlers = {
  save(jobId: unknown, as: unknown): Promise<string>
  reveal(path: unknown): Promise<void>
}

export function createExportHandlers(deps: ExportDeps): ExportHandlers {
  // Reveal only ever surfaces a path this process itself produced. The
  // renderer cannot name one.
  const revealable = new Set<string>()

  async function save(jobId: unknown, as: unknown): Promise<string> {
    const id = requireNonEmptyString(jobId, 'jobId')
    const format = requireExportFormat(as)

    const state = deps.lookupJob(id)
    if (!state) {
      throw new IpcError('INVALID_REQUEST', 'That transcript is no longer available.', `jobId=${id}`)
    }
    if (state.phase !== 'done') {
      throw new IpcError(
        'INVALID_REQUEST',
        'That transcript is not finished yet.',
        `phase=${state.phase}`,
      )
    }

    let path: string
    try {
      // sourcePath comes from main's own record of the job, never from the
      // renderer — the renderer supplies a Map key and a format literal, and
      // nothing else reaches the filesystem.
      path = await deps.writeTranscript({
        segments: state.segments,
        sourcePath: state.filePath,
        as: format,
      })
    } catch (cause) {
      if (cause instanceof AppError || cause instanceof IpcError) throw cause
      throw new IpcError(
        'UNEXPECTED',
        "Couldn't save the transcript. Check you can write to that folder.",
        cause instanceof Error ? cause.message : String(cause),
      )
    }

    revealable.add(path)
    return path
  }

  async function reveal(path: unknown): Promise<void> {
    const target = requireNonEmptyString(path, 'path')
    if (!revealable.has(target)) {
      throw new IpcError(
        'INVALID_REQUEST',
        "That file wasn't written by whisper-drop.",
        `path=${target}`,
      )
    }
    deps.reveal(target)
  }

  return { save, reveal }
}
```

`src/main/ipc/dialog.ts`:

```ts
export type DialogDeps = {
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
}

export type DialogHandlers = {
  openFile(): Promise<string | null>
}

/**
 * No extension filter: file validity is ffprobe's answer, not a list of
 * extensions. The dialog is the click-to-browse fallback for the drop zone.
 */
export function createDialogHandlers(deps: DialogDeps): DialogHandlers {
  return {
    async openFile(): Promise<string | null> {
      const result = await deps.showOpenDialog()
      if (result.canceled) return null
      return result.filePaths[0] ?? null
    },
  }
}
```

Run: `npx vitest run test/main/ipc` — expected PASS, 73 tests across five files.

- [ ] **Step 14: Implement `src/main/ipc/index.ts`**

```ts
import { ipcMain } from 'electron'
import { CHANNELS, type Channel } from '../../shared/ipc.js'
import type { DialogHandlers } from './dialog.js'
import { toResult } from './errors.js'
import type { ExportHandlers } from './export.js'
import type { ModelHandlers } from './models.js'
import type { SettingsHandlers } from './settings.js'
import type { TranscribeHandlers } from './transcribe.js'

export type AppHandlers = {
  transcribe: TranscribeHandlers
  models: ModelHandlers
  settings: SettingsHandlers
  export: ExportHandlers
  dialog: DialogHandlers
}

/**
 * The only place `ipcMain` is touched. Every handler is wrapped so a rejection
 * crosses as data rather than as an Error whose `code` the bridge would strip.
 */
export function registerIpcHandlers(handlers: AppHandlers): void {
  function handle<T>(channel: Channel, run: (...args: unknown[]) => T | Promise<T>): void {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => toResult(() => run(...args)))
  }

  handle(CHANNELS.transcribeStart, (filePath) => handlers.transcribe.start(filePath))
  handle(CHANNELS.transcribeCancel, (jobId) => handlers.transcribe.cancel(jobId))

  handle(CHANNELS.modelsList, () => handlers.models.list())
  handle(CHANNELS.modelsDownload, (base) => handlers.models.download(base))
  handle(CHANNELS.modelsCancelDownload, (base) => handlers.models.cancelDownload(base))
  handle(CHANNELS.modelsRemove, (base) => handlers.models.remove(base))

  handle(CHANNELS.settingsGet, () => handlers.settings.get())
  handle(CHANNELS.settingsSet, (patch) => handlers.settings.set(patch))

  handle(CHANNELS.exportSave, (jobId, format) => handlers.export.save(jobId, format))
  handle(CHANNELS.dialogOpenFile, () => handlers.dialog.openFile())
  handle(CHANNELS.shellReveal, (path) => handlers.export.reveal(path))
}
```

- [ ] **Step 15: Replace `src/main/index.ts` with the composition root**

The collaborator wiring is the same shape part 1's integration test already uses; reuse it rather than inventing a second one.

```ts
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { CHANNELS } from '../shared/ipc.js'
import { saveTranscript } from './export/save.js'
import { registerIpcHandlers } from './ipc/index.js'
import { createDialogHandlers } from './ipc/dialog.js'
import { createExportHandlers } from './ipc/export.js'
import { createModelHandlers } from './ipc/models.js'
import { createSettingsHandlers } from './ipc/settings.js'
import { createTranscribeHandlers, type TranscribeHandlers } from './ipc/transcribe.js'
import { TranscriptionJob } from './jobs/transcription-job.js'
import { extractWav } from './media/extract.js'
import { probe } from './media/probe.js'
import { createModelStore } from './models/store.js'
import { createSettingsStore } from './settings.js'
import { runWhisper } from './whisper/runner.js'
import { createMainWindow } from './window.js'

let transcribe: TranscribeHandlers | null = null
let quitting = false

function bootstrap(): void {
  // Two mains would race each other over settings.json and the model store.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.whenReady().then(() => {
    // The one place the user-data directory is read. Everything below takes it
    // by injection, which is what keeps those modules Electron-free.
    const userData = app.getPath('userData')
    const models = createModelStore(userData)
    const settings = createSettingsStore(userData, app.getLocale())

    let window: BrowserWindow | null = null
    const send = (channel: string, payload: unknown): void => {
      if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
    }

    transcribe = createTranscribeHandlers({
      newJobId: () => randomUUID(),
      readSettings: () => settings.read(),
      modelPathFor: (id) => models.pathFor(id),
      isInstalled: (id) => models.isInstalled(id),
      recordThroughput: (id, realtimeFactor) => settings.recordThroughput(id, realtimeFactor),
      emitState: (state) => send(CHANNELS.transcribeState, state),
      createJob: (input) =>
        new TranscriptionJob(
          {
            probe: (path, signal) => probe(path, { signal }),
            extract: (options) => extractWav(options),
            run: (options, onSegment) => runWhisper({ ...options, onSegment }),
            // The id is a main-generated UUID, so it is safe in a path here.
            tempWavPath: (jobId) => join(app.getPath('temp'), `whisper-drop-${jobId}.wav`),
            removeFile: (path) => rm(path, { force: true }),
            now: () => Date.now(),
          },
          input,
        ),
    })

    registerIpcHandlers({
      transcribe,
      models: createModelHandlers({
        readSettings: () => settings.read(),
        isInstalled: (id) => models.isInstalled(id),
        install: (id, options) => models.install(id, options),
        remove: (id) => models.remove(id),
        emitProgress: (progress) => send(CHANNELS.modelsProgress, progress),
      }),
      settings: createSettingsHandlers({
        read: () => settings.read(),
        write: (patch) => settings.write(patch),
      }),
      export: createExportHandlers({
        lookupJob: (jobId) => transcribe?.stateOf(jobId),
        writeTranscript: (options) => saveTranscript(options),
        reveal: (path) => shell.showItemInFolder(path),
      }),
      dialog: createDialogHandlers({
        showOpenDialog: async () => {
          const result = window
            ? await dialog.showOpenDialog(window, { properties: ['openFile'] })
            : await dialog.showOpenDialog({ properties: ['openFile'] })
          return { canceled: result.canceled, filePaths: result.filePaths }
        },
      }),
    })

    const openWindow = (): BrowserWindow =>
      createMainWindow({
        preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        rendererFile: join(import.meta.dirname, '../renderer/index.html'),
      })

    window = openWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) window = openWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // The one temp-WAV escape path part 1 could not close: quitting mid-job.
  app.on('before-quit', (event) => {
    if (quitting || transcribe === null) return
    quitting = true
    event.preventDefault()
    void transcribe.cancelActive().finally(() => app.quit())
  })
}

bootstrap()
```

- [ ] **Step 16: Extend the boundary guard**

Add one test to `test/main/electron-boundary.test.ts`, inside the existing `describe`:

```ts
  it('keeps every ipc handler module electron-free except its index', async () => {
    const handlers = FILES.filter(
      (file) => key(file).startsWith('main/ipc/') && key(file) !== 'main/ipc/index.ts',
    )

    expect(handlers.length).toBeGreaterThan(3)
    for (const file of handlers) {
      expect(ELECTRON_IMPORT.test(await readFile(file, 'utf8')), key(file)).toBe(false)
    }
  })
```

- [ ] **Step 17: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: everything passes; both programs clean; the build produces `out/main/index.js` with `electron`, `ffmpeg-static`, `ffprobe-static` and `node:*` as its only external imports.

Run: `npm run dev`, and in devtools: `await window.whisperDrop.models.list()`.
Expected: five rows with `installed: false` on a fresh profile.

Then: `await window.whisperDrop.transcribe.start('/nonexistent.mp4')`.
Expected: rejects with `{code: 'NO_MODEL_INSTALLED', message: 'Choose a model first.'}` — a plain object carrying `code`, which is the proof the error envelope survives the bridge.

Then: `await window.whisperDrop.shell.reveal('/etc/passwd')`.
Expected: rejects with `code: 'INVALID_REQUEST'` and nothing opens in Finder.

- [ ] **Step 18: Commit**

```bash
git add src test
git commit -m "feat: validated IPC handlers and the composition root"
```

---

### Task 4: The UI shell and the transcription flow

The five-state machine as a pure reducer, the formatting helpers, and the Idle and Working states. Everything in this task that carries logic is pure and tested as data; the components are tested against a fake preload bridge.

**Design.** Before writing any component or a line of CSS, **use the `frontend-design` skill** for typography, spacing and colour. The app is visually neutral and carries no Human Balance AI branding, and it must not read as templated. Hard constraints, from the spec: **no CSS framework, no component library, no icon font, no webfont download, no network request of any kind.** Everything ships in `src/renderer/styles.css` and any glyphs are inline SVG. Support both colour schemes via `prefers-color-scheme`; the window has no custom titlebar in v1.

**Files:**
- Create: `src/renderer/state/app-state.ts`, `src/renderer/format.ts`
- Create: `src/renderer/components/{Header,DropZone,Working}.tsx`
- Replace: `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `test/renderer/state/app-state.test.ts`, `test/renderer/format.test.ts`, `test/renderer/fake-api.ts`, `test/renderer/components/{DropZone,Working}.test.tsx`

**Interfaces:**
- Consumes: `ModelRow`, `IpcFailure`, `WhisperDropApi` (`src/shared/ipc.ts`); `JobState`, `Settings`, `JobPhase` (`src/shared/types.ts`).
- Produces:
  - `AppView`, `AppState`, `AppEvent`, `INITIAL_STATE`, `reduce`, `viewFor`, `isReady`, `activeRow`
  - `basenameOf`, `formatPercent`, `formatEta`, `formatDuration`, `formatRealtimeFactor`, `formatBytes`, `formatRate`, `phaseLabel`
  - `installFakeApi` (test-only)

- [ ] **Step 1: Write the failing tests for the formatting helpers**

Create `test/renderer/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  basenameOf,
  formatBytes,
  formatDuration,
  formatEta,
  formatPercent,
  formatRate,
  formatRealtimeFactor,
  phaseLabel,
} from '../../src/renderer/format.js'

describe('basenameOf', () => {
  it('takes the last segment of a posix path', () => {
    expect(basenameOf('/Users/ben/Movies/interview.mp4')).toBe('interview.mp4')
  })

  it('takes the last segment of a windows path', () => {
    expect(basenameOf('C:\\Users\\ben\\Movies\\interview.mp4')).toBe('interview.mp4')
  })

  it('returns a bare filename unchanged', () => {
    expect(basenameOf('interview.mp4')).toBe('interview.mp4')
  })
})

describe('formatPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatPercent(0.4269)).toBe(43)
  })

  it('clamps outside 0..1', () => {
    expect(formatPercent(-1)).toBe(0)
    expect(formatPercent(2)).toBe(100)
  })

  it('reads non-finite input as zero rather than NaN', () => {
    expect(formatPercent(Number.NaN)).toBe(0)
  })
})

describe('formatEta', () => {
  it('returns null when there is no estimate, so nothing is shown', () => {
    expect(formatEta(undefined)).toBeNull()
    expect(formatEta(Number.NaN)).toBeNull()
    expect(formatEta(-1)).toBeNull()
  })

  it('describes sub-second estimates without a bogus zero', () => {
    expect(formatEta(200)).toBe('less than a second')
  })

  it('formats seconds', () => {
    expect(formatEta(5_000)).toBe('5 sec')
    expect(formatEta(59_400)).toBe('59 sec')
  })

  it('formats minutes, dropping a zero seconds part', () => {
    expect(formatEta(80_000)).toBe('1 min 20 sec')
    expect(formatEta(120_000)).toBe('2 min')
  })

  it('formats hours', () => {
    expect(formatEta(3_600_000)).toBe('1 hr 0 min')
    expect(formatEta(5_460_000)).toBe('1 hr 31 min')
  })

  it('rounds to the nearest second', () => {
    expect(formatEta(59_600)).toBe('1 min')
  })
})

describe('formatDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatDuration(247_000)).toBe('4:07')
    expect(formatDuration(9_000)).toBe('0:09')
  })

  it('formats over an hour as h:mm:ss', () => {
    expect(formatDuration(3_723_000)).toBe('1:02:03')
  })

  it('formats zero and rejects nonsense to zero', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('formatRealtimeFactor', () => {
  it('returns null when the model has never been run here', () => {
    expect(formatRealtimeFactor(undefined)).toBeNull()
    expect(formatRealtimeFactor(0)).toBeNull()
    expect(formatRealtimeFactor(Number.NaN)).toBeNull()
  })

  it('shows one decimal below ten', () => {
    expect(formatRealtimeFactor(0.83)).toBe('0.8×')
    expect(formatRealtimeFactor(4)).toBe('4.0×')
  })

  it('rounds to whole multiples at ten and above', () => {
    expect(formatRealtimeFactor(12.4)).toBe('12×')
  })
})

describe('formatBytes', () => {
  it('uses decimal MB and GB, matching how the catalog quotes sizes', () => {
    expect(formatBytes(77_691_713)).toBe('78 MB')
    expect(formatBytes(147_951_465)).toBe('148 MB')
    expect(formatBytes(1_624_555_275)).toBe('1.6 GB')
    expect(formatBytes(3_095_033_483)).toBe('3.1 GB')
  })

  it('handles nonsense without printing NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 MB')
    expect(formatBytes(-1)).toBe('0 MB')
  })
})

describe('formatRate', () => {
  it('renders a per-second rate', () => {
    expect(formatRate(2_500_000)).toBe('3 MB/s')
  })

  it('renders nothing at all when the rate is unknown', () => {
    expect(formatRate(0)).toBe('')
    expect(formatRate(Number.NaN)).toBe('')
  })
})

describe('phaseLabel', () => {
  it('gives every phase a plain-language label', () => {
    expect(phaseLabel('probing')).toBe('Reading the file')
    expect(phaseLabel('preparing')).toBe('Preparing audio')
    expect(phaseLabel('transcribing')).toBe('Transcribing')
    expect(phaseLabel('done')).toBe('Done')
    expect(phaseLabel('cancelled')).toBe('Cancelled')
    expect(phaseLabel('failed')).toBe('Failed')
  })
})
```

Run: `npx vitest run test/renderer/format.test.ts` — expected FAIL.

- [ ] **Step 2: Implement `src/renderer/format.ts`**

```ts
import type { JobPhase } from '../shared/types.js'

/** Filename only. Reads a path main supplied; never builds one. */
export function basenameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? filePath
}

/** Whole percent, clamped. Non-finite input reads as 0 rather than NaN%. */
export function formatPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.round(Math.min(1, Math.max(0, progress)) * 100)
}

/** Null when there is nothing honest to show, so the caller renders nothing. */
export function formatEta(etaMs: number | undefined): string | null {
  if (etaMs === undefined || !Number.isFinite(etaMs) || etaMs < 0) return null

  const total = Math.round(etaMs / 1000)
  if (total < 1) return 'less than a second'
  if (total < 60) return `${total} sec`

  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} sec`

  const hours = Math.floor(minutes / 60)
  return `${hours} hr ${minutes % 60} min`
}

/** `4:07`, or `1:02:03` once past an hour. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0:00'

  const total = Math.floor(durationMs / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Measured, never a shipped benchmark. Null when this model has never run. */
export function formatRealtimeFactor(factor: number | undefined): string | null {
  if (factor === undefined || !Number.isFinite(factor) || factor <= 0) return null
  return factor >= 10 ? `${Math.round(factor)}×` : `${factor.toFixed(1)}×`
}

/** Decimal MB/GB, matching how the model sizes are quoted upstream. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB'
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

const PHASE_LABELS: Record<JobPhase, string> = {
  probing: 'Reading the file',
  preparing: 'Preparing audio',
  transcribing: 'Transcribing',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

export function phaseLabel(phase: JobPhase): string {
  return PHASE_LABELS[phase]
}
```

Run: `npx vitest run test/renderer/format.test.ts` — expected PASS, 20 tests.

- [ ] **Step 3: Write the failing tests for the state machine**

Create `test/renderer/state/app-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  INITIAL_STATE,
  activeRow,
  isReady,
  reduce,
  viewFor,
  type AppEvent,
  type AppState,
} from '../../../src/renderer/state/app-state.js'
import type { ModelRow } from '../../../src/shared/ipc.js'
import type { JobState, Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

const row = (base: ModelRow['base'], installed: boolean): ModelRow => ({
  base,
  resolved: {
    id: base,
    base,
    label: base,
    bytes: 1,
    sha256: 'x',
    url: 'x',
    blurb: 'x',
    englishOnly: false,
  },
  installed,
})

const job = (patch: Partial<JobState> = {}): JobState => ({
  id: 'job-1',
  filePath: '/videos/interview.mp4',
  phase: 'transcribing',
  progress: 0.5,
  segments: [],
  ...patch,
})

/** Fold a sequence of events, the way the app actually applies them. */
function run(events: AppEvent[], from: AppState = INITIAL_STATE): AppState {
  return events.reduce(reduce, from)
}

const READY = run([
  { type: 'loaded', settings: SETTINGS, models: [row('tiny', false), row('base', true)] },
])

describe('viewFor', () => {
  it('starts on first-run before anything has loaded', () => {
    expect(viewFor(INITIAL_STATE)).toBe('first-run')
  })

  it('shows first-run when no model is chosen', () => {
    expect(
      viewFor(run([{ type: 'loaded', settings: { ...SETTINGS, activeModel: null }, models: [] }])),
    ).toBe('first-run')
  })

  it('shows first-run when the chosen model is not installed', () => {
    expect(
      viewFor(run([{ type: 'loaded', settings: SETTINGS, models: [row('base', false)] }])),
    ).toBe('first-run')
  })

  it('shows idle once the chosen model is installed', () => {
    expect(viewFor(READY)).toBe('idle')
  })

  it('shows working from the moment a file is accepted, before the first state arrives', () => {
    expect(viewFor(run([{ type: 'start-requested' }], READY))).toBe('working')
  })

  it('shows working through every running phase', () => {
    for (const phase of ['probing', 'preparing', 'transcribing'] as const) {
      expect(viewFor(run([{ type: 'job-state', state: job({ phase }) }], READY)), phase).toBe(
        'working',
      )
    }
  })

  it('shows done when the job completes', () => {
    expect(viewFor(run([{ type: 'job-state', state: job({ phase: 'done' }) }], READY))).toBe('done')
  })

  it('returns to idle when the job is cancelled — cancelling is not an error', () => {
    expect(
      viewFor(run([{ type: 'job-state', state: job({ phase: 'cancelled' }) }], READY)),
    ).toBe('idle')
  })

  it('shows error when the job fails', () => {
    expect(
      viewFor(
        run(
          [
            {
              type: 'job-state',
              state: job({ phase: 'failed', error: { code: 'WHISPER_FAILED', message: 'boom' } }),
            },
          ],
          READY,
        ),
      ),
    ).toBe('error')
  })

  it('shows error when an IPC call fails outright', () => {
    expect(
      viewFor(run([{ type: 'failed', error: { code: 'NO_MODEL_INSTALLED', message: 'x' } }], READY)),
    ).toBe('error')
  })

  it('is not one of the five states for the picker — the picker overlays them', () => {
    const state = run([{ type: 'picker-opened' }], READY)

    expect(state.pickerOpen).toBe(true)
    expect(viewFor(state)).toBe('idle')
  })
})

describe('the English-only toggle', () => {
  it('un-readies the app when the toggle resolves to a model that is not installed', () => {
    const state = run(
      [
        { type: 'settings-changed', settings: { ...SETTINGS, englishOnly: true } },
        { type: 'models-changed', models: [row('base', false)] },
      ],
      READY,
    )

    expect(isReady(state)).toBe(false)
    expect(viewFor(state)).toBe('first-run')
  })

  it('finds the row for the active model', () => {
    expect(activeRow(READY)?.base).toBe('base')
  })

  it('finds no row when no model is active', () => {
    expect(
      activeRow(run([{ type: 'settings-changed', settings: { ...SETTINGS, activeModel: null } }], READY)),
    ).toBeUndefined()
  })
})

describe('progress freezing on cancel', () => {
  it('keeps the displayed progress and eta after cancel is requested', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ progress: 0.5, etaMs: 30_000 }) },
        { type: 'cancel-requested' },
        { type: 'job-state', state: job({ progress: 0.62, etaMs: 21_000 }) },
      ],
      READY,
    )

    expect(state.job?.progress).toBe(0.5)
    expect(state.job?.etaMs).toBe(30_000)
  })

  it('still takes the new segments and phase, so the state stays honest', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ progress: 0.5 }) },
        { type: 'cancel-requested' },
        {
          type: 'job-state',
          state: job({
            progress: 0.62,
            segments: [{ index: 0, startMs: 0, endMs: 1, text: 'late' }],
          }),
        },
      ],
      READY,
    )

    expect(state.job?.segments).toHaveLength(1)
  })

  it('unfreezes when the cancellation lands', () => {
    const state = run(
      [
        { type: 'job-state', state: job() },
        { type: 'cancel-requested' },
        { type: 'job-state', state: job({ phase: 'cancelled' }) },
      ],
      READY,
    )

    expect(state.frozen).toBe(false)
    expect(state.job).toBeNull()
  })
})

describe('stale job updates', () => {
  it('ignores an update for a job the UI has moved past', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ id: 'job-2', progress: 0.9 }) },
        { type: 'job-state', state: job({ id: 'job-1', progress: 0.1 }) },
      ],
      READY,
    )

    expect(state.job?.id).toBe('job-2')
    expect(state.job?.progress).toBe(0.9)
  })

  it('accepts the first update after a start, whatever its id', () => {
    const state = run([{ type: 'start-requested' }, { type: 'job-state', state: job() }], READY)

    expect(state.job?.id).toBe('job-1')
  })
})

describe('reset', () => {
  it('clears the job, error, toast and freeze so the drop zone comes back', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ phase: 'done' }) },
        { type: 'saved', path: '/videos/interview.srt' },
        { type: 'reset' },
      ],
      READY,
    )

    expect(state).toMatchObject({ job: null, error: null, savedPath: null, frozen: false })
    expect(viewFor(state)).toBe('idle')
  })

  it('leaves the models and settings alone', () => {
    const state = run([{ type: 'reset' }], READY)

    expect(state.settings).toEqual(SETTINGS)
    expect(state.models).toHaveLength(2)
  })

  it('clears a previous run when a new file is dropped', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ phase: 'done' }) },
        { type: 'saved', path: '/videos/interview.srt' },
        { type: 'start-requested' },
      ],
      READY,
    )

    expect(state).toMatchObject({ job: null, error: null, savedPath: null, starting: true })
  })
})

describe('the export toast', () => {
  it('records the saved path', () => {
    expect(run([{ type: 'saved', path: '/videos/a.srt' }], READY).savedPath).toBe('/videos/a.srt')
  })

  it('clears on dismissal', () => {
    expect(
      run([{ type: 'saved', path: '/videos/a.srt' }, { type: 'toast-dismissed' }], READY).savedPath,
    ).toBeNull()
  })
})

describe('a failed job', () => {
  it('carries the job’s own error into the error view', () => {
    const state = run(
      [
        {
          type: 'job-state',
          state: job({
            phase: 'failed',
            error: { code: 'FFMPEG_FAILED', message: 'Nope.', detail: 'exit 1' },
          }),
        },
      ],
      READY,
    )

    expect(state.error).toEqual({ code: 'FFMPEG_FAILED', message: 'Nope.', detail: 'exit 1' })
  })

  it('substitutes a failure when the job somehow failed without one', () => {
    const state = run([{ type: 'job-state', state: job({ phase: 'failed' }) }], READY)

    expect(state.error?.code).toBe('UNEXPECTED')
  })
})
```

Run: `npx vitest run test/renderer/state/app-state.test.ts` — expected FAIL.

- [ ] **Step 4: Implement `src/renderer/state/app-state.ts`**

```ts
import type { IpcFailure, ModelRow } from '../../shared/ipc.js'
import type { JobState, Settings } from '../../shared/types.js'

/** The five states the spec fixes. `first-run` doubles as the model picker. */
export type AppView = 'first-run' | 'idle' | 'working' | 'done' | 'error'

export type AppState = {
  settings: Settings | null
  models: ModelRow[]
  job: JobState | null
  /** Set on cancel so buffered segments cannot advance the bar afterwards. */
  frozen: boolean
  error: IpcFailure | null
  /** The path of the last export, for the toast's Reveal action. */
  savedPath: string | null
  /** The picker is reachable at any time, so it overlays a view rather than being one. */
  pickerOpen: boolean
  /** True between dropping a file and the first JobState arriving. */
  starting: boolean
}

export type AppEvent =
  | { type: 'loaded'; settings: Settings; models: ModelRow[] }
  | { type: 'models-changed'; models: ModelRow[] }
  | { type: 'settings-changed'; settings: Settings }
  | { type: 'start-requested' }
  | { type: 'job-state'; state: JobState }
  | { type: 'cancel-requested' }
  | { type: 'failed'; error: IpcFailure }
  | { type: 'saved'; path: string }
  | { type: 'toast-dismissed' }
  | { type: 'picker-opened' }
  | { type: 'picker-closed' }
  | { type: 'reset' }

export const INITIAL_STATE: AppState = {
  settings: null,
  models: [],
  job: null,
  frozen: false,
  error: null,
  savedPath: null,
  pickerOpen: false,
  starting: false,
}

/** The row the active model resolves to under the current toggle, if any. */
export function activeRow(state: AppState): ModelRow | undefined {
  if (!state.settings || state.settings.activeModel === null) return undefined
  return state.models.find((row) => row.base === state.settings?.activeModel)
}

/**
 * Ready means the *resolved* model is on disk. Flipping the English-only
 * toggle can therefore un-ready an app that was ready a moment ago, because
 * `base` and `base.en` are separate files — which is exactly when the picker
 * should come back.
 */
export function isReady(state: AppState): boolean {
  return activeRow(state)?.installed === true
}

export function viewFor(state: AppState): AppView {
  if (state.error) return 'error'

  if (state.job) {
    if (state.job.phase === 'failed') return 'error'
    if (state.job.phase === 'done') return 'done'
    if (state.job.phase !== 'cancelled') return 'working'
  }

  if (state.starting) return 'working'

  return isReady(state) ? 'idle' : 'first-run'
}

export function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'loaded':
      return { ...state, settings: event.settings, models: event.models }

    case 'models-changed':
      return { ...state, models: event.models }

    case 'settings-changed':
      return { ...state, settings: event.settings }

    case 'start-requested':
      return { ...state, starting: true, job: null, error: null, frozen: false, savedPath: null }

    case 'job-state': {
      // A late update from a job the UI has already moved on from. Dropping it
      // is what stops a cancelled run's buffered segments reopening Working.
      if (state.job && state.job.id !== event.state.id && !state.starting) return state

      if (event.state.phase === 'cancelled') {
        return { ...state, job: null, starting: false, frozen: false, error: null }
      }

      if (event.state.phase === 'failed') {
        return {
          ...state,
          job: event.state,
          starting: false,
          error: event.state.error ?? { code: 'UNEXPECTED', message: 'Transcription failed.' },
        }
      }

      // Frozen: take the new phase and segments, keep the progress and ETA the
      // user last saw, so the bar stops rather than creeping after Cancel.
      const next =
        state.frozen && state.job
          ? { ...event.state, progress: state.job.progress, etaMs: state.job.etaMs }
          : event.state

      return { ...state, job: next, starting: false }
    }

    case 'cancel-requested':
      return { ...state, frozen: true }

    case 'failed':
      return { ...state, error: event.error, starting: false }

    case 'saved':
      return { ...state, savedPath: event.path }

    case 'toast-dismissed':
      return { ...state, savedPath: null }

    case 'picker-opened':
      return { ...state, pickerOpen: true }

    case 'picker-closed':
      return { ...state, pickerOpen: false }

    case 'reset':
      return { ...state, job: null, error: null, frozen: false, savedPath: null, starting: false }
  }
}
```

Run: `npx vitest run test/renderer/state/app-state.test.ts` — expected PASS, 24 tests.

- [ ] **Step 5: Create the fake preload bridge for component tests**

Create `test/renderer/fake-api.ts`. Two things here are load-bearing and were confirmed by experiment: Testing Library's automatic cleanup only fires when Vitest globals are on, and they are off in this repo — without the explicit `afterEach(cleanup)` below, a second `render` in the same file leaves the first one's DOM in place and queries return two of everything. And `window.whisperDrop` is declared `readonly`, so it is installed with `defineProperty`, which is honest about it being a bridge-injected global.

```ts
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import type { ModelRow, WhisperDropApi } from '../../src/shared/ipc.js'
import type { DownloadProgress, JobState, Settings } from '../../src/shared/types.js'

afterEach(() => {
  cleanup()
})

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

export function modelRow(overrides: Partial<ModelRow> & Pick<ModelRow, 'base'>): ModelRow {
  return {
    resolved: {
      id: overrides.base,
      base: overrides.base,
      label: overrides.base,
      bytes: 147_951_465,
      sha256: 'x'.repeat(64),
      url: `https://example.invalid/${overrides.base}`,
      blurb: 'Good default. Quick, decent accuracy.',
      englishOnly: false,
    },
    installed: false,
    ...overrides,
  }
}

export type FakeApi = {
  api: WhisperDropApi
  /** Push a JobState to every `transcribe.onState` subscriber. */
  emitState: (state: JobState) => void
  /** Push a DownloadProgress to every `models.onProgress` subscriber. */
  emitProgress: (progress: DownloadProgress) => void
  /** How many subscribers are live — asserts effects clean up on unmount. */
  stateSubscribers: () => number
}

export function installFakeApi(overrides: Partial<WhisperDropApi> = {}): FakeApi {
  const stateListeners = new Set<(state: JobState) => void>()
  const progressListeners = new Set<(progress: DownloadProgress) => void>()

  const api: WhisperDropApi = {
    transcribe: {
      start: vi.fn(async () => 'job-1'),
      cancel: vi.fn(async () => {}),
      onState: (callback) => {
        stateListeners.add(callback)
        return () => stateListeners.delete(callback)
      },
      ...overrides.transcribe,
    },
    models: {
      list: vi.fn(async () => [] as ModelRow[]),
      download: vi.fn(async () => {}),
      cancelDownload: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      onProgress: (callback) => {
        progressListeners.add(callback)
        return () => progressListeners.delete(callback)
      },
      ...overrides.models,
    },
    settings: {
      get: vi.fn(async () => DEFAULT_SETTINGS),
      set: vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch })),
      ...overrides.settings,
    },
    exportTranscript: {
      save: vi.fn(async () => '/videos/interview.srt'),
      ...overrides.exportTranscript,
    },
    dialog: { openFile: vi.fn(async () => null), ...overrides.dialog },
    shell: { reveal: vi.fn(async () => {}), ...overrides.shell },
    droppedFile: { pathFor: vi.fn(() => '/videos/interview.mp4'), ...overrides.droppedFile },
  }

  Object.defineProperty(window, 'whisperDrop', { value: api, configurable: true, writable: true })

  return {
    api,
    emitState: (state) => {
      for (const listener of [...stateListeners]) listener(state)
    },
    emitProgress: (progress) => {
      for (const listener of [...progressListeners]) listener(progress)
    },
    stateSubscribers: () => stateListeners.size,
  }
}
```

- [ ] **Step 6: Write `src/renderer/App.tsx`**

The shell. The render tree is a design decision (see the `frontend-design` note above); the wiring below is not, and should be written as given.

```tsx
import { useCallback, useEffect, useReducer } from 'react'
import { asIpcFailure } from './errors.js'
import {
  INITIAL_STATE,
  reduce,
  viewFor,
  type AppState,
} from './state/app-state.js'

export function App() {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE)

  const refresh = useCallback(async () => {
    const [settings, models] = await Promise.all([
      window.whisperDrop.settings.get(),
      window.whisperDrop.models.list(),
    ])
    dispatch({ type: 'loaded', settings, models })
  }, [])

  useEffect(() => {
    void refresh().catch((cause) => dispatch({ type: 'failed', error: asIpcFailure(cause) }))
  }, [refresh])

  useEffect(() => {
    const off = window.whisperDrop.transcribe.onState((jobState) =>
      dispatch({ type: 'job-state', state: jobState }),
    )
    return off
  }, [])

  useEffect(() => {
    // Download progress only changes a row's numbers, so the rows are re-read
    // rather than patched in place — one source of truth for install state.
    const off = window.whisperDrop.models.onProgress(() => {
      void window.whisperDrop.models
        .list()
        .then((models) => dispatch({ type: 'models-changed', models }))
        .catch(() => {})
    })
    return off
  }, [])

  // A dropped file must never navigate the renderer, in any state, including
  // over parts of the window that are not the drop target.
  useEffect(() => {
    const swallow = (event: DragEvent): void => event.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  const startTranscription = useCallback(async (filePath: string) => {
    dispatch({ type: 'start-requested' })
    try {
      await window.whisperDrop.transcribe.start(filePath)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const cancel = useCallback(async (jobId: string) => {
    dispatch({ type: 'cancel-requested' })
    try {
      await window.whisperDrop.transcribe.cancel(jobId)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const browse = useCallback(async () => {
    const filePath = await window.whisperDrop.dialog.openFile()
    if (filePath !== null) await startTranscription(filePath)
  }, [startTranscription])

  // ... render per the view spec below, using viewFor(state)
}
```

`state` and `viewFor` drive the render; the tree is specified in Step 7. Keep `AppState` imported as a type only where needed.

- [ ] **Step 7: Specify and build the Header, DropZone and Working views**

Not code — a specification. The implementer makes the visual calls, guided by `frontend-design`, and satisfies exactly these requirements.

**`Header`** — visible in every state.
- Shows the active model's label and, when the toggle is off, the language. When `settings.englishOnly` is true the language control is hidden entirely and the header says "English only" instead — one control, not two, per the parent spec.
- A button opening the model picker, reachable in every state, labelled with the active model (or "Choose a model" when `activeModel` is null).
- The English-only toggle is rendered as a real `<input type="checkbox" role="switch">` with a visible `<label>`, not a styled div.
- Props: `{ settings, activeRow, onOpenPicker, onToggleEnglishOnly, onLanguageChange }`.

**`DropZone`** — the Idle state, and the disabled variant used inside First run.
- A full-window drop target. `onDragOver` and `onDragLeave` toggle a "hovering" visual; `onDrop` reads `event.dataTransfer.files`, takes `files[0]`, resolves its path with `window.whisperDrop.droppedFile.pathFor(file)`, and calls `onFile(path)`.
- **Multiple files:** takes the first, and renders the message "whisper-drop handles one file at a time for now — using the first." The message persists until the next drop or a reset.
- **Click-to-browse fallback:** a `<button data-testid="browse">` that calls `onBrowse`. It is a real button, keyboard-focusable, and the drop zone as a whole has `role="button"` with `tabIndex={0}` and an `aria-label` naming the action.
- `disabled` prop: renders greyed with an explanatory line ("Waiting for the model to finish downloading"), ignores drops and disables the browse button.
- Props: `{ disabled?, reason?, onFile, onBrowse }`.

**`Working`** — filename, duration, phase, progress, ETA, Cancel.
- Filename from `basenameOf(job.filePath)`, in a `data-testid="source-name"` element.
- Media duration from `formatDuration(job.media.durationMs)`, shown only once `job.media` exists.
- Phase label from `phaseLabel(job.phase)`.
- Progress as a real `<progress>` or a div with `role="progressbar"` carrying `aria-valuenow={formatPercent(job.progress)}`, `aria-valuemin={0}`, `aria-valuemax={100}`; the percentage is also visible as text.
- ETA from `formatEta(job.etaMs)`; when it returns `null`, **render nothing at all** — no "calculating…", no zero.
- A Cancel button. Once clicked it is disabled and its label becomes "Cancelling…", and the progress display is frozen by the reducer.
- Props: `{ job, frozen, onCancel }`.

**Tests — `test/renderer/components/DropZone.test.tsx`.** Docblock `// @vitest-environment jsdom`, import `../fake-api.js` for cleanup. Each of these is one test:
1. Renders the drop prompt and a browse button.
2. Dropping one file calls `onFile` with the path `droppedFile.pathFor` returned.
3. Dropping three files calls `onFile` exactly once, with the first file's path.
4. Dropping three files renders the one-at-a-time message.
5. Dropping zero files calls `onFile` never and shows no error.
6. `onDragOver` sets the hovering class and `preventDefault` was called on the event.
7. Clicking browse calls `onBrowse`.
8. `disabled` renders the reason text, disables the browse button, and a drop calls `onFile` never.
9. The drop zone is reachable by keyboard: it has an accessible name and `tabIndex` 0.

**Tests — `test/renderer/components/Working.test.tsx`.** Each is one test:
1. Shows the source filename, not the full path.
2. Shows the phase label for each of `probing`, `preparing`, `transcribing`.
3. Shows the media duration once `media` is present, and nothing before.
4. `role="progressbar"` carries `aria-valuenow` matching `formatPercent(progress)`.
5. Shows the ETA text when `etaMs` is set.
6. Renders no ETA element at all when `etaMs` is `undefined`.
7. Clicking Cancel calls `onCancel` once.
8. With `frozen`, Cancel is disabled and reads "Cancelling…".

- [ ] **Step 8: Verify**

Run: `npm test`
Expected: all tests pass, including the new jsdom component files. Total duration still under 10 seconds — the node tests must not have gained a DOM.

Run: `npm run typecheck`
Expected: both programs clean.

Run: `npm run dev`, and drop a media file onto the window with no model installed.
Expected: the First-run picker is showing and the drop zone is disabled, so nothing starts. Then check the window did not navigate away when the file was released — the page is still the app.

- [ ] **Step 9: Commit**

```bash
git add src test
git commit -m "feat: app state machine, formatting, drop zone and working view"
```

---

### Task 5: The model picker

Five rows in capability order, the English-only toggle with its partial swap, install/remove/cancel, and measured throughput — never a shipped benchmark.

**Design:** the same `frontend-design` constraints as Task 4 apply. No component library, no CSS framework, no icon font.

**Files:**
- Create: `src/renderer/components/ModelPicker.tsx`, `src/renderer/components/ModelRowView.tsx`
- Modify: `src/renderer/App.tsx` (picker wiring), `src/renderer/styles.css`
- Test: `test/renderer/components/ModelPicker.test.tsx`

**Interfaces:**
- Consumes: `ModelRow` (`src/shared/ipc.ts`); `formatBytes`, `formatRate`, `formatRealtimeFactor`, `formatPercent` (`src/renderer/format.ts`).
- Produces: `ModelPicker`, `ModelRowView`.

- [ ] **Step 1: Wire the picker into `App.tsx`**

Add these callbacks. Each re-reads the rows afterwards, so install state and the toggle's effect on it come from one source rather than being guessed at locally.

```tsx
  const setEnglishOnly = useCallback(async (englishOnly: boolean) => {
    try {
      const settings = await window.whisperDrop.settings.set({ englishOnly })
      dispatch({ type: 'settings-changed', settings })
      dispatch({ type: 'models-changed', models: await window.whisperDrop.models.list() })
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const chooseModel = useCallback(async (base: ModelBaseId) => {
    try {
      const settings = await window.whisperDrop.settings.set({ activeModel: base })
      dispatch({ type: 'settings-changed', settings })
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const downloadModel = useCallback(
    async (base: ModelBaseId) => {
      try {
        await window.whisperDrop.models.download(base)
      } catch (cause) {
        dispatch({ type: 'failed', error: asIpcFailure(cause) })
      } finally {
        // Runs on cancellation too: the row must stop showing a progress bar.
        await refresh()
      }
    },
    [refresh],
  )

  const removeModel = useCallback(
    async (base: ModelBaseId) => {
      try {
        await window.whisperDrop.models.remove(base)
      } catch (cause) {
        dispatch({ type: 'failed', error: asIpcFailure(cause) })
      } finally {
        await refresh()
      }
    },
    [refresh],
  )
```

- [ ] **Step 2: Specify and build `ModelPicker` and `ModelRowView`**

**`ModelPicker`** — props `{ rows, settings, downloadingBase, onChoose, onDownload, onCancelDownload, onRemove, onToggleEnglishOnly, onClose?, firstRun }`.
- Renders the five rows in the order `rows` arrives in — the handler already returns capability order, and the picker must not re-sort.
- Above the rows: the size/speed/accuracy tradeoff in one or two sentences, and the **English only / All languages** toggle as a real `role="switch"` checkbox with a visible label.
- When `firstRun` is true it renders inline as the whole view with no close button; otherwise it is a modal overlay with a close button, `role="dialog"`, `aria-modal="true"`, an accessible name, focus moved into it on open, focus returned on close, and Escape closing it.
- When the English-only toggle is on, the `large-v3-turbo` and `large-v3` rows carry a note: *"No English-only weights exist above small — these stay multilingual, and are still the most accurate option for English."*

**`ModelRowView`** — props `{ row, active, downloading, onChoose, onDownload, onCancelDownload, onRemove }`.
- Shows `row.resolved.label`, `formatBytes(row.resolved.bytes)`, and `row.resolved.blurb`.
- **Speed:** when `row.realtimeFactor` is present, `~{formatRealtimeFactor(row.realtimeFactor)} realtime on your machine`. When it is absent, render **no speed figure at all** — position in the list is the only ordering claim the app makes. Never a hardcoded benchmark.
- **Not installed:** a Download button.
- **Downloading:** a progressbar with `aria-valuenow` from `formatPercent(received / total)`, the byte counts, `formatRate(bytesPerSecond)` when non-empty, and a Cancel button. No Download button.
- **Installed:** a "Use this model" radio or button (disabled and marked current when `active`), and a Remove button.
- Each row is a `<li>` inside the picker's `<ul>`, and the active row carries `aria-current="true"`.

- [ ] **Step 3: Write `test/renderer/components/ModelPicker.test.tsx`**

Docblock `// @vitest-environment jsdom`; import `../fake-api.js`. One test each:

1. Renders exactly five rows, in the order given, without re-sorting.
2. Shows each row's label, size and blurb.
3. Shows `~12× realtime on your machine` for a row with `realtimeFactor: 12.4`.
4. Renders no speed text at all for a row with no `realtimeFactor`.
5. With `englishOnly` off, rows resolve to the multilingual ids and no partial-swap note appears.
6. With `englishOnly` on, the `tiny`/`base`/`small` rows show their `.en` labels and the two large rows carry the "no English-only weights above small" note.
7. Flipping the toggle calls `onToggleEnglishOnly(true)` exactly once.
8. A row whose `installed` flips from true to false after a toggle shows a Download button, not Remove — the honest cost of the swap.
9. An uninstalled row's Download button calls `onDownload(base)`.
10. A downloading row shows a progressbar whose `aria-valuenow` matches the received/total ratio, plus a Cancel button and no Download button.
11. Cancel on a downloading row calls `onCancelDownload(base)`.
12. An installed row shows Remove, and clicking it calls `onRemove(base)`.
13. Choosing an installed row calls `onChoose(base)`.
14. The active row is marked `aria-current="true"` and its choose control is disabled.
15. In `firstRun` mode there is no close button and no `role="dialog"`.
16. Outside first run it is a `role="dialog"` with `aria-modal`, and Escape calls `onClose`.

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck` — expected PASS, both clean.

Run: `npm run dev` on a fresh profile (`rm -rf` the app's userData directory first, or launch with `--user-data-dir=$(mktemp -d)`).
Expected: the first-run picker with five rows, no speed figures anywhere, and a disabled drop zone. Download `tiny`, watch real progress, and confirm the row becomes installed and the drop zone enables. Flip the English-only toggle and confirm the `tiny` row goes back to "Download" while `large-v3-turbo` carries the multilingual note.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: model picker with measured throughput and the english-only swap"
```

---

### Task 6: Done and Error states, and export

The transcript viewer, the three exports with their naming rule, the reveal toast, and the full error mapping.

**Design:** the same `frontend-design` constraints. The transcript is the one place typography actually matters — it is long-form reading, so give it a measure, a line height and a paragraph rhythm chosen for reading, not for a UI panel.

**Files:**
- Create: `src/renderer/errors.ts`
- Create: `src/renderer/components/{Done,ErrorView,Toast}.tsx`
- Modify: `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `test/renderer/errors.test.ts`, `test/renderer/components/{Done,ErrorView}.test.tsx`

**Interfaces:**
- Consumes: `IpcFailure`, `IpcErrorCode`, `IPC_BOUNDARY_CODES` (`src/shared/ipc.ts`); `ERROR_CODES` (`src/shared/types.ts`).
- Produces: `ErrorAction`, `ErrorPresentation`, `presentError`, `asIpcFailure`, `detailBlock`.

- [ ] **Step 1: Write the failing tests for the error mapping**

Create `test/renderer/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { IPC_BOUNDARY_CODES, type IpcErrorCode } from '../../src/shared/ipc.js'
import { ERROR_CODES } from '../../src/shared/types.js'
import { asIpcFailure, detailBlock, presentError } from '../../src/renderer/errors.js'

const ALL_CODES: IpcErrorCode[] = [...ERROR_CODES, ...IPC_BOUNDARY_CODES]

describe('presentError', () => {
  it('has an entry for every code that can reach the renderer', () => {
    for (const code of ALL_CODES) {
      const presented = presentError({ code, message: '' })
      expect(presented.title, code).not.toBe('')
      expect(presented.suggestion, code).not.toBe('')
    }
  })

  it('prefers the message main sent, which carries the numbers only main knows', () => {
    expect(
      presentError({
        code: 'INSUFFICIENT_DISK_SPACE',
        message: 'Not enough free space. Large v3 needs about 3.1 GB.',
      }).title,
    ).toBe('Not enough free space. Large v3 needs about 3.1 GB.')
  })

  it('falls back to the table when the message is empty', () => {
    expect(presentError({ code: 'NO_AUDIO_STREAM', message: '   ' }).title).toBe(
      "This file doesn't contain any audio.",
    )
  })

  it('sends the missing-model codes to the picker', () => {
    expect(presentError({ code: 'NO_MODEL_INSTALLED', message: '' }).action).toBe('open-picker')
    expect(presentError({ code: 'MODEL_FILE_MISSING', message: '' }).action).toBe('open-picker')
    expect(presentError({ code: 'INSUFFICIENT_DISK_SPACE', message: '' }).action).toBe(
      'open-picker',
    )
  })

  it('offers a download retry for the two download failures', () => {
    expect(presentError({ code: 'DOWNLOAD_NETWORK_ERROR', message: '' }).action).toBe(
      'retry-download',
    )
    expect(presentError({ code: 'DOWNLOAD_CHECKSUM_MISMATCH', message: '' }).action).toBe(
      'retry-download',
    )
  })

  it('offers a transcription retry for the two pipeline failures', () => {
    expect(presentError({ code: 'WHISPER_FAILED', message: '' }).action).toBe('retry-transcription')
    expect(presentError({ code: 'FFMPEG_FAILED', message: '' }).action).toBe('retry-transcription')
  })

  it('never suggests retrying a file that simply has no audio', () => {
    expect(presentError({ code: 'NO_AUDIO_STREAM', message: '' }).action).toBe('dismiss')
    expect(presentError({ code: 'UNREADABLE_MEDIA', message: '' }).action).toBe('dismiss')
  })
})

describe('asIpcFailure', () => {
  it('passes a well-formed failure through', () => {
    const failure = { code: 'WHISPER_FAILED', message: 'boom', detail: 'exit 1' }

    expect(asIpcFailure(failure)).toBe(failure)
  })

  it('normalises an Error to UNEXPECTED', () => {
    expect(asIpcFailure(new Error('kaboom'))).toEqual({
      code: 'UNEXPECTED',
      message: 'Something went wrong.',
      detail: 'kaboom',
    })
  })

  it('normalises an unrecognised code rather than trusting it', () => {
    expect(asIpcFailure({ code: 'MADE_UP', message: 'trust me' }).code).toBe('UNEXPECTED')
  })

  it('normalises anything else', () => {
    expect(asIpcFailure(undefined).code).toBe('UNEXPECTED')
    expect(asIpcFailure('boom').detail).toBe('boom')
    expect(asIpcFailure(null).code).toBe('UNEXPECTED')
  })
})

describe('detailBlock', () => {
  it('formats code, message and detail for pasting into an issue', () => {
    expect(detailBlock({ code: 'FFMPEG_FAILED', message: 'Nope.', detail: 'exit 1' })).toBe(
      'code: FFMPEG_FAILED\nmessage: Nope.\nexit 1',
    )
  })

  it('omits an absent detail', () => {
    expect(detailBlock({ code: 'FFMPEG_FAILED', message: 'Nope.' })).toBe(
      'code: FFMPEG_FAILED\nmessage: Nope.',
    )
  })
})
```

Run: `npx vitest run test/renderer/errors.test.ts` — expected FAIL.

- [ ] **Step 2: Implement `src/renderer/errors.ts`**

```ts
import type { IpcErrorCode, IpcFailure } from '../shared/ipc.js'

/** What the Error view offers. The component maps these to its own handlers. */
export type ErrorAction = 'open-picker' | 'retry-transcription' | 'retry-download' | 'dismiss'

export type ErrorPresentation = {
  /** Plain language. Never a stack, never a bare errno. */
  title: string
  suggestion: string
  action: ErrorAction
}

type Entry = { fallbackTitle: string; suggestion: string; action: ErrorAction }

const TABLE: Record<IpcErrorCode, Entry> = {
  NO_AUDIO_STREAM: {
    fallbackTitle: "This file doesn't contain any audio.",
    suggestion: 'Try a different file — a video with no audio track has nothing to transcribe.',
    action: 'dismiss',
  },
  UNREADABLE_MEDIA: {
    fallbackTitle: "This file couldn't be read as audio or video.",
    suggestion: 'Check the file opens in a media player, then try again.',
    action: 'dismiss',
  },
  NO_MODEL_INSTALLED: {
    fallbackTitle: 'Choose a model first.',
    suggestion: 'Pick a model and download it, then drop your file again.',
    action: 'open-picker',
  },
  MODEL_FILE_MISSING: {
    fallbackTitle: "That model isn't on disk anymore.",
    suggestion: 'Download it again from the model picker.',
    action: 'open-picker',
  },
  INSUFFICIENT_DISK_SPACE: {
    fallbackTitle: 'Not enough free space for that model.',
    suggestion: 'Free some space, or choose a smaller model.',
    action: 'open-picker',
  },
  DOWNLOAD_CHECKSUM_MISMATCH: {
    fallbackTitle: 'The download was corrupted.',
    suggestion: 'The file is discarded rather than used. Try downloading it again.',
    action: 'retry-download',
  },
  DOWNLOAD_NETWORK_ERROR: {
    fallbackTitle: "Couldn't reach the model server.",
    suggestion: 'Check your connection and try again. A partial download resumes where it stopped.',
    action: 'retry-download',
  },
  WHISPER_FAILED: {
    fallbackTitle: 'Transcription failed unexpectedly.',
    suggestion: 'Try again. If it keeps happening, the details below belong in a bug report.',
    action: 'retry-transcription',
  },
  FFMPEG_FAILED: {
    fallbackTitle: "Couldn't prepare the audio from this file.",
    suggestion: 'Try converting the file to a common format, or use a different recording.',
    action: 'retry-transcription',
  },
  INVALID_REQUEST: {
    fallbackTitle: 'That request was not understood.',
    suggestion: 'Start again from the beginning. The details below belong in a bug report.',
    action: 'dismiss',
  },
  JOB_ALREADY_RUNNING: {
    fallbackTitle: 'whisper-drop transcribes one file at a time.',
    suggestion: 'Wait for the current file to finish, or cancel it first.',
    action: 'dismiss',
  },
  UNEXPECTED: {
    fallbackTitle: 'Something went wrong.',
    suggestion: 'Try again. If it keeps happening, the details below belong in a bug report.',
    action: 'dismiss',
  },
}

/**
 * `message` already arrives as plain language from main — including the
 * numbers only main knows, like how much space a model needs — so it wins over
 * the table's title. The table supplies the suggested action either way.
 */
export function presentError(failure: IpcFailure): ErrorPresentation {
  const entry = TABLE[failure.code] ?? TABLE.UNEXPECTED
  return {
    title: failure.message.trim() === '' ? entry.fallbackTitle : failure.message,
    suggestion: entry.suggestion,
    action: entry.action,
  }
}

/** Anything a rejected IPC call throws, narrowed to something renderable. */
export function asIpcFailure(cause: unknown): IpcFailure {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    'message' in cause &&
    typeof (cause as { code: unknown }).code === 'string' &&
    typeof (cause as { message: unknown }).message === 'string' &&
    (cause as { code: string }).code in TABLE
  ) {
    return cause as IpcFailure
  }

  return {
    code: 'UNEXPECTED',
    message: 'Something went wrong.',
    detail: cause instanceof Error ? cause.message : String(cause),
  }
}

/** The disclosure body, formatted for pasting into a GitHub issue. */
export function detailBlock(failure: IpcFailure): string {
  return [`code: ${failure.code}`, `message: ${failure.message}`, failure.detail ?? '']
    .filter((line) => line !== '')
    .join('\n')
}
```

Run: `npx vitest run test/renderer/errors.test.ts` — expected PASS, 14 tests.

`TABLE` is a `Record<IpcErrorCode, Entry>`, so adding a code without a message is a compile error, and the first test proves the same thing at runtime by iterating both unions.

- [ ] **Step 3: Wire export into `App.tsx`**

```tsx
  const save = useCallback(async (jobId: string, format: ExportFormat) => {
    try {
      dispatch({ type: 'saved', path: await window.whisperDrop.exportTranscript.save(jobId, format) })
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const reveal = useCallback(async (path: string) => {
    // The path came from `save` above, so it is already on main's allowlist.
    try {
      await window.whisperDrop.shell.reveal(path)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])
```

- [ ] **Step 4: Specify and build `Done`, `Toast` and `ErrorView`**

**`Done`** — props `{ job, onSave, onCopy, onReset }`.
- Filename in a `data-testid="source-name"` element, alongside the duration.
- The transcript in a `data-testid="transcript"` element, rendered as **readable paragraphs, not one line per segment**: join consecutive segment texts with a space and start a new paragraph when the gap between one segment's `endMs` and the next's `startMs` exceeds a threshold. Use **1500 ms**, and put that number in one named constant with a one-line comment. Segments whose text is blank after trimming are dropped, exactly as the formatters do.
- An empty transcript renders "No speech was found in this file." rather than an empty box.
- Buttons: `Copy`, `Save .txt`, `Save .srt`, `Save .vtt`, `Transcribe another`. Copy uses `navigator.clipboard.writeText`; on rejection it shows an inline "Couldn't copy" note and does **not** enter the Error state — a clipboard failure is not a transcription failure.
- The transcript container scrolls independently; the buttons stay reachable.

**`Toast`** — props `{ path, onReveal, onDismiss }`.
- `role="status"` with `aria-live="polite"`, so it is announced without stealing focus.
- Shows `Saved {basenameOf(path)}` and a Reveal button calling `onReveal(path)`, plus a dismiss control.
- Auto-dismisses after 6 seconds; the timer is cleared on unmount.

**`ErrorView`** — props `{ failure, onRetry, onOpenPicker, onDismiss }`.
- `presentError(failure).title` as the heading, `.suggestion` as body text.
- The action button is chosen from `.action`: `open-picker` → "Choose a model"; `retry-transcription` → "Try again"; `retry-download` → "Try the download again"; `dismiss` → "Start over".
- A native `<details><summary>Details</summary>` disclosure containing `detailBlock(failure)` in a `<pre>`, plus a "Copy details" button. **The `<pre>` is the only place any technical text appears.**
- Cancellation never reaches this view: the reducer turns `phase: 'cancelled'` into Idle with no error.

**Tests — `test/renderer/components/Done.test.tsx`.** One test each:
1. Shows the source filename, not the full path.
2. Renders segment text inside `data-testid="transcript"`.
3. Joins segments less than 1500 ms apart into one paragraph.
4. Starts a new paragraph when the gap is 1500 ms or more.
5. Drops whitespace-only segments.
6. Renders the no-speech message for an empty `segments` array.
7. Each of the three Save buttons calls `onSave` with its own format.
8. Copy writes the transcript text to the clipboard.
9. A rejected clipboard write shows the inline note and calls no error handler.
10. "Transcribe another" calls `onReset`.

**Tests — `test/renderer/components/ErrorView.test.tsx`.** One test each:
1. Renders the failure's own message as the heading.
2. Renders the code's suggestion.
3. `NO_MODEL_INSTALLED` renders a "Choose a model" button calling `onOpenPicker`.
4. `WHISPER_FAILED` renders "Try again" calling `onRetry`.
5. `DOWNLOAD_NETWORK_ERROR` renders the download retry.
6. The technical detail is behind a closed `<details>` and is not visible before it is opened.
7. The detail block contains the code, the message and the detail.
8. A failure with no `detail` still renders the disclosure with code and message.
9. No raw stack text appears outside the `<pre>`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck` — expected PASS, both clean.

Run: `npm run dev` with `tiny` installed. Drop `test/fixtures/hello.mp4`.
Expected: Working → Done with the transcript. Click `Save .srt`; a toast appears; click Reveal and Finder/Explorer opens on the file. Save `.srt` a second time and confirm the new file is `hello (2).srt` and the first is untouched.

Then drop a file with no audio (e.g. `ffmpeg -f lavfi -i color=c=black:s=64x64:d=1 /tmp/silent.mp4`).
Expected: the Error state with "This file doesn't contain any audio.", a closed Details disclosure, and no stack anywhere on screen.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: transcript viewer, export with collision handling, and the error surface"
```

---

### Task 7: The Playwright-on-Electron smoke test

Small, and the only test that proves preload, IPC and renderer are wired to each other rather than each being individually correct.

**Files:**
- Create: `test/e2e/smoke.test.ts`

**Interfaces:**
- Consumes: the built app in `out/`, `test/fixtures/hello.mp4`, `.cache/models/ggml-tiny.bin`.
- Produces: no production code.

**Prerequisites:** `npm run setup` has built `whisper-cli`, and `scripts/fetch-test-model.mjs` has downloaded the tiny model. The `test:e2e` script runs the model fetch itself; the whisper build is a one-off.

- [ ] **Step 1: Write the test**

Create `test/e2e/smoke.test.ts`:

```ts
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE = join(ROOT, 'test/fixtures/hello.mp4')
const TINY_MODEL = join(ROOT, '.cache/models/ggml-tiny.bin')

let userData: string
let app: ElectronApplication
let page: Page

beforeAll(async () => {
  expect(existsSync(join(ROOT, 'out/main/index.js')), 'run `npm run build` first').toBe(true)
  expect(existsSync(TINY_MODEL), 'run `node scripts/fetch-test-model.mjs` first').toBe(true)

  // A throwaway user-data directory, pre-seeded so the app starts past first
  // run. `--user-data-dir` is a Chromium switch Electron honours, which is why
  // no test-only seam is needed in the app itself.
  userData = await mkdtemp(join(tmpdir(), 'whisper-drop-e2e-'))
  await mkdir(join(userData, 'models'), { recursive: true })
  await copyFile(TINY_MODEL, join(userData, 'models', 'tiny.bin'))
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      englishOnly: false,
      activeModel: 'tiny',
      language: 'en',
      throughput: {},
    }),
    'utf8',
  )

  app = await electron.launch({ args: [ROOT, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

afterAll(async () => {
  await app?.close()
  await rm(userData, { recursive: true, force: true })
})

describe('the packaged renderer', () => {
  it('has no Node in the renderer', async () => {
    expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
      'undefined',
    )
    expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe(
      'undefined',
    )
  })

  it('exposes exactly the bridged API and nothing else', async () => {
    expect(
      await page.evaluate(() =>
        Object.keys((globalThis as unknown as { whisperDrop: object }).whisperDrop).sort(),
      ),
    ).toEqual([
      'dialog',
      'droppedFile',
      'exportTranscript',
      'models',
      'settings',
      'shell',
      'transcribe',
    ])
  })
})

describe('transcribing the committed fixture end to end', () => {
  it('renders a transcript containing the spoken words', async () => {
    // The open dialog is native, so it is replaced in main rather than driven.
    // This is the browse path the drop zone falls back to, and it exercises
    // the same start -> IPC -> job -> state-forwarding wiring a drop does.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    }, FIXTURE)

    await page.getByTestId('browse').click()

    await expect
      .poll(async () => (await page.getByTestId('transcript').textContent()) ?? '', {
        timeout: 240_000,
        interval: 500,
      })
      .toMatch(/testing/i)
  })

  it('shows the source filename while it works and after it finishes', async () => {
    await expect.poll(() => page.getByTestId('source-name').textContent()).toBe('hello.mp4')
  })
})
```

Why the browse path and not a synthetic drop: `webUtils.getPathForFile` returns an empty string for a `File` constructed in the page, so a forged `DataTransfer` cannot carry a real path. Replacing `dialog.showOpenDialog` in main is the standard playwright-electron approach and exercises the identical `transcribe.start` → job → `onState` → render chain. The drop-specific logic — `preventDefault`, first-of-many, `pathFor` — is covered by the `DropZone` unit tests in Task 4.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e`
Expected: builds, fetches the model if needed, launches Electron, and passes four tests. First run takes a couple of minutes because of the model download; afterwards it is dominated by the whisper run on a 3-second clip.

If the transcript never appears, check `out/main/index.js` resolved `whisper-cli`: the built main lives at `out/main/`, and `binaries.ts` walks `../../resources/<platform>-<arch>` from there, which lands on the repo's `resources/` directory. That is the path `npm run setup` writes to. A missing binary surfaces here and nowhere else in the suite.

- [ ] **Step 3: Confirm the unit suite is unaffected**

Run: `npm test`
Expected: the e2e file is excluded by `vitest.config.ts` and does not launch Electron. Duration unchanged.

- [ ] **Step 4: Commit**

```bash
git add test/e2e
git commit -m "test: playwright-on-electron smoke test over the real pipeline"
```

---

## Done when

- `npm run dev` opens the app; dropping a media file produces a transcript.
- `npm test` is green and still runs in a few seconds. The 211 tests from parts 1 and 2 are all still there and all still pass.
- `npm run typecheck` is clean for both the node and the web program.
- `npm run build` produces `out/main/index.js`, `out/preload/index.cjs` and `out/renderer/` with the strict CSP in the HTML.
- `npm run test:e2e` transcribes the committed fixture through the real IPC path.
- `test/main/electron-boundary.test.ts` passes: only the four allowlisted files import `electron`, no renderer file imports a node builtin or anything from `src/main/`.
- A renderer-supplied job id, model id, format or reveal path that main did not issue is rejected with `INVALID_REQUEST`.
- Quitting mid-transcription leaves no temp WAV in the OS temp directory and no orphaned `whisper-cli` process.

## What plan 4 picks up

`electron-builder` packaging for macOS, Windows and Linux; `extraResources` carrying only the matching `resources/<platform>-<arch>` directory; GitHub Actions building `whisper-cli` per platform and caching it per tag; the README with the unsigned-app walkthrough; and the Licenses screen crediting whisper.cpp, ffmpeg and Human Balance AI.
