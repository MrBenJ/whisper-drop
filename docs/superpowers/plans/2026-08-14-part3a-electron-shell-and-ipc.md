# whisper-drop Part 3a — Electron Shell and IPC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Electron shell underneath parts 1 and 2 — a hardened window, a narrow typed IPC
surface that validates everything crossing it, and the composition root that wires the real
collaborators together. No UI in this plan: it ends with `window.whisperDrop` callable from
devtools against a placeholder page. The React UI is 3b.

**Architecture:** Four electron-importing files and nothing else. `src/main/index.ts` is the composition root: it is the only place that reads `app.getPath('userData')` and the only place that knows the real `probe`/`extract`/`runWhisper` collaborators exist. Every IPC handler module takes its dependencies by injection and knows nothing about Electron, so the whole boundary — id validation, the one-job-at-a-time rule, the reveal allowlist, error translation — is unit-tested without an app harness. The renderer is React with no router, no state library and no CSS framework; its state is one pure reducer, tested as pure data.

**Tech Stack:** TypeScript 5 (ESM), Vitest 4, Node 22, Electron 43, electron-vite 5, Vite 7, React 19, `@vitejs/plugin-react` 5, Testing Library 16 + jsdom for components, `playwright`'s `_electron` for one smoke test.

**Spec:** `docs/superpowers/specs/2026-08-14-part3-electron-app-design.md`
(This spec doc lands in the same branch as this plan, `part-3-electron-app`; it does not exist on
`main` until part 3 merges.)
**Parent spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md` — binding authority.

## Scope

This is plan 3a of 4 (3a and 3b together are "plan 3" — one plan, split into two documents because
the combined draft exceeded the review tool's size limit). Parts 1 and 2 are merged on `main`: 211
tests, all green, `tsc --noEmit` clean.

**In scope:** the electron-vite scaffold, the main-process entry and window lifecycle with the
spec's security posture, the preload bridge, the shared IPC contract types, six IPC handler
modules, the path trust boundary, the composition root, and `before-quit` cleanup.

**Out of scope, picked up by 3b:** the React UI (drop zone, working, done, error, model picker),
export-to-file with the collision rule, and the Playwright-on-Electron smoke test.

**Out of scope, deferred to plan 4:** `electron-builder` packaging, code signing, releases, GitHub Actions, the README and the Licenses screen. Also out, per the parent spec's Later list: batch queue, translation, custom vocabulary, word-level timestamps.

**Deliverable:** `npm run dev` opens an Electron window with the full security posture, loading a
placeholder page. `npm test` passes the unit suite in seconds, including every IPC handler and the
electron-import boundary guard. `window.whisperDrop` is callable from devtools and every call
round-trips through main's validation. There is no UI and no e2e test in this plan — see 3b.

## Deviations from the spec

Four, recorded here so none of them is silent.

1. **Four files may import `electron`, not one directory.** The part 3 spec says "`src/main/ipc/` is the only directory permitted to import `electron`" and, two paragraphs later, that `src/main/index.ts` calls `app.getPath('userData')`. Those cannot both hold: `src/main/index.ts` is the Electron entry point and must call `app.whenReady()`. The rule this plan enforces — and enforces with a test, not a convention — is an explicit four-file allowlist: `src/main/index.ts`, `src/main/window.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`. Every handler module, and everything under `src/main/` that carries logic, stays plain Node. The parent spec's actual wording ("Modules under `src/main/` other than `ipc/` must not import `electron`") is about logic modules, and that intent is preserved exactly.

2. **The shared types the renderer needs move to `src/shared/types.ts`.** The parent spec's "Shared types" section declares `ModelBaseId`, `ModelId`, `ModelEntry`, `DownloadProgress` and `Settings` as shared. Part 2 declared them inside `models/catalog.ts`, `models/download.ts` and `settings.ts` instead, which was correct while nothing else needed them. It is not correct now: the renderer must name them, and the renderer must not import from `src/main/`. Task 2 moves the declarations to `src/shared/types.ts` and re-exports them from their current homes, so every existing import keeps working. **Verified:** this move alone leaves all 211 existing tests green and `tsc --noEmit` clean.

3. **The IPC surface gains `droppedFile.pathFor(file)`.** Neither spec lists it, and without it the drop zone cannot work at all: Electron 32 removed the `File.path` property, and a dropped file's real path is now obtainable only from a preload calling `webUtils.getPathForFile(file)`. This is the one addition to the contract, and it is a getter over an OS-supplied `File`, not a new capability.

4. **A path trust boundary the specs describe as a property, not a mechanism.** The parent spec's "the renderer never constructs a filesystem path" is an intent, but as written `transcribe.start(filePath: string)` would accept any string. This plan makes it a real check: `src/main/ipc/trusted-paths.ts` is a small issue/consume registry held in main. `dialog.openFile` and the preload's `droppedFile.pathFor` are the only two ways a path reaches the renderer, and both issue into it — `pathFor` does so over a new renderer-to-main-only channel, `droppedFileRegister`, fired from inside the preload and never exposed on `WhisperDropApi` itself. `transcribe.start` consumes an entry before acting on a path and rejects anything else with `INVALID_REQUEST`. This is the same allowlist-by-issuance pattern the spec already uses for `shell.reveal`, applied to the one place it was missing.

## Global Constraints

Every task's requirements implicitly include these.

- **Only four files may import `electron`:** `src/main/index.ts`, `src/main/window.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`. Everything else — every handler module, every logic module, the whole renderer — is plain Node or plain browser. This is what keeps the suite running without an app harness. Task 1 adds `test/main/electron-boundary.test.ts`, which fails the build if the allowlist is broken.
- **Only `src/main/ipc/index.ts` touches `ipcMain`.** Handler modules take dependencies by injection and return plain functions.
- **`jobId` is generated in main with `randomUUID()`, is a `Map` key, and is never a path component.** Part 1's `tempWavPath(id)` interpolates the id straight into a filesystem path; a renderer-supplied id would be a traversal. Handlers look jobs up in the map and reject an unknown id.
- **A filesystem path only ever reaches `transcribe.start` if main issued it first.** `dialog.openFile` and `droppedFile.pathFor` are the only two ways a path enters the renderer; both record it in a main-held `TrustedPaths` registry (`src/main/ipc/trusted-paths.ts`) before the renderer sees it, and `transcribe.start` consumes — checks and removes — an entry before acting on a path, rejecting anything else with `INVALID_REQUEST`. The renderer otherwise never constructs a path: it reads `JobState.filePath` to show a filename and passes back opaque ids and format literals. `exportTranscript.save` derives the output path from main's own record of the job. `shell.reveal` accepts only a path main itself previously returned, via the same issue-then-check pattern.
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
| `src/main/ipc/trusted-paths.ts` | The issue/consume registry behind the path trust boundary |
| `src/main/ipc/transcribe.ts` | Job map, one-job-at-a-time, throughput recording, path trust check |
| `src/main/ipc/models.ts` | Picker rows, download, cancel, remove |
| `src/main/ipc/settings.ts` | Read, and a whitelisted patch |
| `src/main/ipc/export.ts` | Save, and the reveal allowlist |
| `src/main/ipc/dialog.ts` | The browse fallback; issues the chosen path as trusted |
| `src/main/ipc/dropped-file.ts` | Registers a dropped file's `pathFor` result as trusted |
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
- Create: `src/preload/index.ts` (a placeholder; Task 2 replaces its contents with the real bridge)
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
    // Not because this program's own code needs Node — the boundary test
    // below proves it doesn't — but because `src/preload` is in this program
    // and Electron's own type declarations reference Node ambient types
    // (`Buffer`, the `NodeJS` namespace) even in the corners of its API
    // surface this preload never touches. Dropping this makes `tsc -p
    // tsconfig.web.json` fail on `import ... from 'electron'` itself.
    "types": ["node"]
  },
  "include": ["src/renderer", "src/preload", "src/shared", "test/renderer"]
}
```

`src/shared` is in both programs deliberately: it must compile under DOM-free Node rules *and*
Node-free browser rules, which is the cheapest possible proof that nothing platform-specific leaks
into it. There are no project references and no `composite`, so nothing objects to the overlap.
`"types": ["node"]` above is why that proof is a typecheck plus a test rather than a typecheck
alone — see the boundary guard in Step 15, which greps `src/shared` and `src/renderer` for actual
Node builtin imports and Node globals, the thing the ambient ability to resolve `Buffer` cannot by
itself rule out.

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

- [ ] **Step 9: Create a minimal no-op preload**

Step 8's `electron.vite.config.ts` already points the preload build at `src/preload/index.ts`,
and Step 13 below writes a `src/main/index.ts` that expects the built `../preload/index.cjs` to
exist. Without this file the scaffold cannot build. Task 2 replaces the contents below with the
real `contextBridge` surface; this version exists only so the window-and-security work in the rest
of this task is verifiable — `npm run dev` and `npm run build` both need a preload that compiles.

`src/preload/index.ts`:

```ts
// Placeholder. Task 2 replaces this with the real contextBridge bridge.
export {}
```

- [ ] **Step 10: Create the placeholder renderer**

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

- [ ] **Step 11: Write the failing test for the navigation predicate**

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

- [ ] **Step 12: Implement `src/main/navigation.ts`**

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

- [ ] **Step 13: Create `src/main/window.ts`**

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

- [ ] **Step 14: Create a minimal `src/main/index.ts`**

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

Step 9's placeholder preload means `../preload/index.cjs` already exists at this point, so the
window opens with no preload-not-found warning even though `window.whisperDrop` is not yet defined
— that arrives in Task 2.

- [ ] **Step 15: Write the boundary guard**

Create `test/main/electron-boundary.test.ts`. Task 3 adds one more assertion to this file.

`src/shared` compiles under both tsconfigs — the Node program and the web program — specifically so
it cannot depend on either platform. Checking imports alone would miss `process.platform` or
`Buffer.from` reached through an ambient global rather than an import, so this checks both, and
checks `src/shared` as well as `src/renderer` for exactly that reason.

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
// `global` is deliberately excluded: it is common in ordinary prose/comments
// and TypeScript's own `globalThis` typings, and every real Node escape hatch
// this is meant to catch already goes through one of the other four names.
const NODE_GLOBAL = /\b(?:process|require|__dirname|__filename|Buffer)\b/

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

/** Shared between the renderer and shared-code checks below — same rule, two directories. */
function checksNodeFreedom(dirPrefix: string) {
  return async (): Promise<void> => {
    const offenders: string[] = []

    for (const file of FILES.filter((f) => key(f).startsWith(dirPrefix))) {
      const contents = await readFile(file, 'utf8')
      if (NODE_BUILTIN_IMPORT.test(contents) || NODE_GLOBAL.test(contents)) {
        offenders.push(key(file))
      }
    }

    expect(offenders).toEqual([])
  }
}

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

  it('keeps node builtins and node globals out of the renderer', checksNodeFreedom('renderer/'))

  // The renderer typechecks under tsconfig.web.json alongside src/shared, so
  // shared code that quietly depended on Node would still pass tsc — only
  // this test catches it.
  it('keeps node builtins and node globals out of shared code', checksNodeFreedom('shared/'))

  it('keeps main out of the renderer, so the renderer cannot reach the filesystem', async () => {
    const offenders: string[] = []

    for (const file of FILES.filter((f) => key(f).startsWith('renderer/'))) {
      if (/from\s+['"][^'"]*\/main\//.test(await readFile(file, 'utf8'))) offenders.push(key(file))
    }

    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 16: Prove the existing suite is untouched and still fast**

Run: `npm test`
Expected: PASS. The 211 pre-existing tests plus the new csp, navigation and boundary tests. Duration under 10 seconds — if it is not, something has pulled jsdom or a browser environment into the node suite.

Run: `npm run typecheck`
Expected: both programs clean, no output.

- [ ] **Step 17: Prove the build works**

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

- [ ] **Step 18: Open the window**

Run: `npm run dev`
Expected: an Electron window titled `whisper-drop` showing the placeholder heading. Close it to end the run.

- [ ] **Step 19: Commit**

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
- Modify: `src/preload/index.ts` (Task 1's placeholder, replaced here with the real bridge)
- Create: `src/shared/ipc.ts`

**Interfaces:**
- Consumes: `ErrorCode`, `JobState`, `Unsubscribe` from `src/shared/types.ts`.
- Produces:
  - `ERROR_CODES`, `EXPORT_FORMATS`, and the moved `ModelBaseId` / `ModelId` / `ModelEntry` / `DownloadProgress` / `Settings` / `ExportFormat`
  - `CHANNELS` (including `droppedFileRegister`, used only inside the preload — see Deviation 4 below), `Channel`, `IpcBoundaryCode`, `IpcErrorCode`, `IPC_BOUNDARY_CODES`, `IpcFailure`, `IpcResult<T>`, `ModelRow`, `WhisperDropApi`
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
  /**
   * Renderer -> main only, fired from inside the preload's `pathFor`. Not on
   * `WhisperDropApi` — it isn't a capability the renderer calls deliberately,
   * it's how main learns a path it must trust for `transcribe.start`. See
   * `src/main/ipc/trusted-paths.ts`.
   */
  droppedFileRegister: 'droppedFile:register',
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
     * obtainable from the preload, via `webUtils.getPathForFile`. The preload
     * also reports the path to main over `droppedFileRegister` so
     * `transcribe.start` can trust it — see `src/main/ipc/trusted-paths.ts`.
     */
    pathFor(file: File): string
  }
}
```

- [ ] **Step 5: Replace `src/preload/index.ts` with the real bridge**

This replaces Task 1 Step 9's placeholder outright.

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
    pathFor: (file) => {
      const path = webUtils.getPathForFile(file)
      // Fire-and-forget, and safe to not await: ipcRenderer.invoke preserves
      // send order over its one channel, and the main-side register handler
      // does no awaiting of its own, so it is fully handled before the next
      // message — the transcribe:start this path is about to be used for —
      // is even dispatched. An empty path (the synthetic-File case the e2e
      // test's comment describes) is not registered; transcribe.start would
      // reject an empty path before it ever checks trust anyway.
      if (path) void ipcRenderer.invoke(CHANNELS.droppedFileRegister, path).catch(() => {})
      return path
    },
  },
}

contextBridge.exposeInMainWorld('whisperDrop', api)
```

Four things here are not optional. The preload imports no Node builtin, because a sandboxed preload has no `require` for them. `webUtils` is available in a sandboxed preload and is the only place `getPathForFile` can be called. The unsubscribe function returned by `subscribe` crosses the bridge as a proxied function, which contextBridge supports in both directions. And `pathFor` stays synchronous — the drop zone needs the path immediately, not a Promise — while still getting the path registered as trusted before `transcribe.start` for it can possibly be sent, because Electron's IPC transport is FIFO per renderer and the register handler never awaits.

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
- Create: `src/main/ipc/errors.ts`, `src/main/ipc/validate.ts`, `src/main/ipc/trusted-paths.ts`, `src/main/ipc/transcribe.ts`, `src/main/ipc/models.ts`, `src/main/ipc/settings.ts`, `src/main/ipc/export.ts`, `src/main/ipc/dialog.ts`, `src/main/ipc/dropped-file.ts`, `src/main/ipc/index.ts`
- Create: `src/main/export/save.ts`
- Replace: `src/main/index.ts`
- Modify: `test/main/electron-boundary.test.ts`
- Test: `test/main/ipc/errors.test.ts`, `test/main/ipc/trusted-paths.test.ts`, `test/main/ipc/transcribe.test.ts`, `test/main/ipc/models.test.ts`, `test/main/ipc/settings.test.ts`, `test/main/ipc/export.test.ts`, `test/main/ipc/dialog.test.ts`, `test/main/ipc/dropped-file.test.ts`, `test/main/export/save.test.ts`
- Test: `test/main/ipc/path-trust.test.ts` (the trust boundary wired end to end, across real dialog/dropped-file/transcribe handlers)
- Test: `test/main/ipc/wiring.test.ts` (proves every channel `registerIpcHandlers` registers is exactly the set the preload bridge invokes)

**Interfaces:**
- Consumes: `TranscriptionJob` + `JobInput` (`main/jobs/transcription-job.ts`); `probe`, `extractWav`, `runWhisper`; `createModelStore`, `createSettingsStore`; `resolveModelId`, `entryFor`, `MODEL_BASE_ORDER`; `format`; `AppError`; everything from Task 2.
- Produces: `IpcError`, `toFailure`, `toResult`; `requireNonEmptyString`, `requireModelBaseId`, `requireExportFormat`; `createTrustedPaths`; `createTranscribeHandlers`, `createModelHandlers`, `createSettingsHandlers`, `createExportHandlers`, `createDialogHandlers`, `createDroppedFileHandlers`; `registerIpcHandlers`; `candidatePath`, `saveTranscript`.

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

- [ ] **Step 4: Write the failing tests for the trusted-paths registry**

Create `test/main/ipc/trusted-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTrustedPaths } from '../../../src/main/ipc/trusted-paths.js'

describe('createTrustedPaths', () => {
  it('consumes a path it issued', () => {
    const paths = createTrustedPaths()
    paths.issue('/videos/a.mp4')

    expect(paths.consume('/videos/a.mp4')).toBe(true)
  })

  it('refuses a path it never issued', () => {
    const paths = createTrustedPaths()

    expect(paths.consume('/etc/passwd')).toBe(false)
  })

  it('cannot be consumed twice', () => {
    const paths = createTrustedPaths()
    paths.issue('/videos/a.mp4')
    paths.consume('/videos/a.mp4')

    expect(paths.consume('/videos/a.mp4')).toBe(false)
  })

  it('tracks each issued path independently', () => {
    const paths = createTrustedPaths()
    paths.issue('/a.mp4')
    paths.issue('/b.mp4')

    expect(paths.consume('/a.mp4')).toBe(true)
    expect(paths.consume('/b.mp4')).toBe(true)
  })

  it('does not grow without bound when paths are issued and never consumed', () => {
    const paths = createTrustedPaths()
    for (let i = 0; i < 1_000; i++) paths.issue(`/videos/${i}.mp4`)

    // The oldest entries were evicted; the most recent one is still trusted.
    expect(paths.consume('/videos/999.mp4')).toBe(true)
    expect(paths.consume('/videos/0.mp4')).toBe(false)
  })
})
```

Run: `npx vitest run test/main/ipc/trusted-paths.test.ts` — expected FAIL.

- [ ] **Step 5: Implement `src/main/ipc/trusted-paths.ts`**

```ts
/**
 * A filesystem path reaches the renderer in exactly two ways: the open
 * dialog (`dialog.openFile`) and a dropped file resolved via
 * `webUtils.getPathForFile` in the preload (`droppedFile.pathFor`). Both are
 * issued here before the renderer ever sees them. `transcribe.start` consumes
 * an entry before it will act on a path, so a compromised renderer cannot ask
 * main to transcribe a file the user never actually chose.
 */
export type TrustedPaths = {
  issue(path: string): void
  /** True and removes the entry; false leaves nothing behind to retry. */
  consume(path: string): boolean
}

/** Bounds memory if paths are issued and the job that would consume them never starts. */
const MAX_ISSUED = 500

export function createTrustedPaths(): TrustedPaths {
  const issued = new Set<string>()

  return {
    issue(path) {
      if (issued.size >= MAX_ISSUED) {
        const oldest = issued.values().next().value
        if (oldest !== undefined) issued.delete(oldest)
      }
      issued.add(path)
    },
    consume(path) {
      return issued.delete(path)
    },
  }
}
```

Run: `npx vitest run test/main/ipc/trusted-paths.test.ts` — expected PASS, 5 tests.

- [ ] **Step 6: Write the failing tests for the transcribe handlers**

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
    // Every existing test drops a file "already selected through whisper-drop";
    // the trust-boundary tests below override this explicitly.
    consumeTrustedPath: () => true,
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

  it('rejects a path main never issued', async () => {
    const { handlers, created } = harness({ consumeTrustedPath: () => false })

    await expect(handlers.start('/etc/passwd')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(created).toHaveLength(0)
  })

  it('accepts a path main issued, and consumes it exactly once', async () => {
    const consumeTrustedPath = vi.fn((path: string) => path === '/videos/interview.mp4')
    const { handlers, created } = harness({ consumeTrustedPath })
    await handlers.start('/videos/interview.mp4')

    expect(created).toHaveLength(1)
    expect(consumeTrustedPath).toHaveBeenCalledWith('/videos/interview.mp4')
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

- [ ] **Step 7: Implement `src/main/ipc/transcribe.ts`**

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
  /**
   * True and consumes the entry if `filePath` is one main itself issued, via
   * `dialog.openFile` or a dropped file's `pathFor`. The renderer cannot name
   * a path main did not first hand it — this is what enforces that.
   */
  consumeTrustedPath: (filePath: string) => boolean
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

    // Boundary check first, before the busy check: a forged path is rejected
    // the same way whether or not a job happens to be running.
    if (!deps.consumeTrustedPath(path)) {
      throw new IpcError(
        'INVALID_REQUEST',
        'That file was not selected through whisper-drop.',
        `filePath=${JSON.stringify(path.slice(0, 200))}`,
      )
    }

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

Run: `npx vitest run test/main/ipc/transcribe.test.ts` — expected PASS, 29 tests.

- [ ] **Step 8: Write the failing tests for the model handlers**

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

- [ ] **Step 9: Implement `src/main/ipc/models.ts`**

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

- [ ] **Step 10: Write the failing tests for the settings handlers**

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

- [ ] **Step 11: Implement `src/main/ipc/settings.ts`**

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

- [ ] **Step 12: Write the failing tests for `save.ts`**

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

- [ ] **Step 13: Implement `src/main/export/save.ts`**

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

- [ ] **Step 14: Write the failing tests for the export, dialog, and dropped-file handlers**

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
import { describe, expect, it, vi } from 'vitest'
import { createDialogHandlers } from '../../../src/main/ipc/dialog.js'

function harness(showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>) {
  const issuePath = vi.fn()
  const handlers = createDialogHandlers({ showOpenDialog, issuePath })
  return { handlers, issuePath }
}

describe('dialog.openFile', () => {
  it('returns the chosen path', async () => {
    const { handlers } = harness(async () => ({ canceled: false, filePaths: ['/videos/a.mp4'] }))

    expect(await handlers.openFile()).toBe('/videos/a.mp4')
  })

  it('issues the chosen path as trusted, so transcribe.start will accept it', async () => {
    const { handlers, issuePath } = harness(async () => ({
      canceled: false,
      filePaths: ['/videos/a.mp4'],
    }))
    await handlers.openFile()

    expect(issuePath).toHaveBeenCalledWith('/videos/a.mp4')
  })

  it('returns null when the user cancels, and issues nothing', async () => {
    const { handlers, issuePath } = harness(async () => ({ canceled: true, filePaths: [] }))

    expect(await handlers.openFile()).toBeNull()
    expect(issuePath).not.toHaveBeenCalled()
  })

  it('returns null when the dialog reports success with no path', async () => {
    const { handlers, issuePath } = harness(async () => ({ canceled: false, filePaths: [] }))

    expect(await handlers.openFile()).toBeNull()
    expect(issuePath).not.toHaveBeenCalled()
  })

  it('takes the first path when several come back', async () => {
    const { handlers } = harness(async () => ({ canceled: false, filePaths: ['/a.mp4', '/b.mp4'] }))

    expect(await handlers.openFile()).toBe('/a.mp4')
  })
})
```

Create `test/main/ipc/dropped-file.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createDroppedFileHandlers } from '../../../src/main/ipc/dropped-file.js'

describe('droppedFile.register', () => {
  it('issues the reported path as trusted', async () => {
    const issuePath = vi.fn()
    const handlers = createDroppedFileHandlers({ issuePath })
    await handlers.register('/videos/interview.mp4')

    expect(issuePath).toHaveBeenCalledWith('/videos/interview.mp4')
  })

  it('rejects a non-string or empty path rather than issuing it', async () => {
    const issuePath = vi.fn()
    const handlers = createDroppedFileHandlers({ issuePath })

    await expect(handlers.register(42)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.register('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.register(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(issuePath).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 15: Implement `src/main/ipc/export.ts`, `src/main/ipc/dialog.ts`, and `src/main/ipc/dropped-file.ts`**

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
  /** Records the chosen path as trusted, so `transcribe.start` will accept it. */
  issuePath: (path: string) => void
}

export type DialogHandlers = {
  openFile(): Promise<string | null>
}

/**
 * No extension filter: file validity is ffprobe's answer, not a list of
 * extensions. The dialog is the click-to-browse fallback for the drop zone,
 * and one of the two ways a path enters the renderer — see `trusted-paths.ts`.
 */
export function createDialogHandlers(deps: DialogDeps): DialogHandlers {
  return {
    async openFile(): Promise<string | null> {
      const result = await deps.showOpenDialog()
      if (result.canceled) return null

      const path = result.filePaths[0] ?? null
      if (path !== null) deps.issuePath(path)
      return path
    },
  }
}
```

`src/main/ipc/dropped-file.ts`:

```ts
import { requireNonEmptyString } from './validate.js'

export type DroppedFileDeps = {
  /** Records the path as trusted, so `transcribe.start` will accept it. */
  issuePath: (path: string) => void
}

export type DroppedFileHandlers = {
  register(path: unknown): Promise<void>
}

/**
 * The preload resolves a dropped `File`'s real path via
 * `webUtils.getPathForFile` and reports it here, so `transcribe.start` can
 * trust it later. This is the second of the two ways a path enters the
 * renderer — `dialog.openFile` is the first. Neither spec lists this channel:
 * it exists purely to close the trust boundary, not as a capability the
 * renderer calls deliberately.
 */
export function createDroppedFileHandlers(deps: DroppedFileDeps): DroppedFileHandlers {
  return {
    async register(path: unknown): Promise<void> {
      deps.issuePath(requireNonEmptyString(path, 'path'))
    },
  }
}
```

Run: `npx vitest run test/main/ipc` — expected PASS, 96 tests across eight files.

- [ ] **Step 16: Implement `src/main/ipc/index.ts`**

```ts
import { ipcMain } from 'electron'
import { CHANNELS, type Channel } from '../../shared/ipc.js'
import type { DialogHandlers } from './dialog.js'
import type { DroppedFileHandlers } from './dropped-file.js'
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
  droppedFile: DroppedFileHandlers
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

  handle(CHANNELS.droppedFileRegister, (path) => handlers.droppedFile.register(path))
}
```

- [ ] **Step 17: Replace `src/main/index.ts` with the composition root**

The collaborator wiring is the same shape part 1's integration test already uses; reuse it rather than inventing a second one.

```ts
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { CHANNELS } from '../shared/ipc.js'
import { saveTranscript } from './export/save.js'
import { createDialogHandlers } from './ipc/dialog.js'
import { createDroppedFileHandlers } from './ipc/dropped-file.js'
import { createExportHandlers } from './ipc/export.js'
import { registerIpcHandlers } from './ipc/index.js'
import { createModelHandlers } from './ipc/models.js'
import { createSettingsHandlers } from './ipc/settings.js'
import { createTranscribeHandlers, type TranscribeHandlers } from './ipc/transcribe.js'
import { createTrustedPaths } from './ipc/trusted-paths.js'
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
    // The only two ways a path enters the renderer — the open dialog and a
    // dropped file's `pathFor` — issue into this registry. `transcribe.start`
    // consumes from it, so a path the renderer never received from main is
    // never trusted, regardless of how it is shaped.
    const trustedPaths = createTrustedPaths()

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
      consumeTrustedPath: (path) => trustedPaths.consume(path),
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
        issuePath: (path) => trustedPaths.issue(path),
      }),
      droppedFile: createDroppedFileHandlers({
        issuePath: (path) => trustedPaths.issue(path),
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

- [ ] **Step 18: Extend the boundary guard**

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

- [ ] **Step 19: Prove main and the preload agree on every channel, end to end**

Two tests, neither of which the handler unit tests above can catch: a channel-name typo on either
side of the bridge, and the path trust boundary wired for real rather than through an injected
fake.

Create `test/main/ipc/path-trust.test.ts` — the real `createTrustedPaths()` shared between the
real dialog, dropped-file and transcribe handlers, the way `src/main/index.ts` wires them:

```ts
import { describe, expect, it } from 'vitest'
import { createDialogHandlers } from '../../../src/main/ipc/dialog.js'
import { createDroppedFileHandlers } from '../../../src/main/ipc/dropped-file.js'
import { createTranscribeHandlers, type JobLike } from '../../../src/main/ipc/transcribe.js'
import { createTrustedPaths } from '../../../src/main/ipc/trusted-paths.js'
import type { Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

function harness() {
  const trustedPaths = createTrustedPaths()
  const dialog = createDialogHandlers({
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/videos/dialog-pick.mp4'] }),
    issuePath: trustedPaths.issue,
  })
  const droppedFile = createDroppedFileHandlers({ issuePath: trustedPaths.issue })
  const transcribe = createTranscribeHandlers({
    newJobId: () => 'job-1',
    readSettings: async () => SETTINGS,
    modelPathFor: () => '/models/base.bin',
    isInstalled: async () => true,
    createJob: (input) =>
      ({
        id: input.id,
        state: { id: input.id, filePath: input.filePath, phase: 'probing', progress: 0, segments: [] },
        start: () => new Promise<void>(() => {}),
        cancel: () => {},
        subscribe: () => () => {},
      }) satisfies JobLike,
    recordThroughput: async () => undefined,
    emitState: () => {},
    consumeTrustedPath: trustedPaths.consume,
  })

  return { dialog, droppedFile, transcribe }
}

describe('the path trust boundary end to end', () => {
  it('start rejects a path main never issued', async () => {
    const { transcribe } = harness()

    await expect(transcribe.start('/etc/passwd')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('start accepts a path returned by dialog.openFile', async () => {
    const { dialog, transcribe } = harness()
    const path = await dialog.openFile()

    await expect(transcribe.start(path)).resolves.toEqual(expect.any(String))
  })

  it('start accepts a path returned by droppedFile.pathFor (reported via register)', async () => {
    const { droppedFile, transcribe } = harness()
    await droppedFile.register('/videos/dropped.mp4')

    await expect(transcribe.start('/videos/dropped.mp4')).resolves.toEqual(expect.any(String))
  })
})
```

Create `test/main/ipc/wiring.test.ts` — a fake `ipcMain`/`ipcRenderer` pair where `invoke` really
dispatches to the matching `handle` listener, so the test can drive the actual preload module and
observe exactly which channels it touches:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS } from '../../../src/shared/ipc.js'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const registered = new Map<string, Listener>()
const invoked = new Set<string>()
const subscribed = new Set<string>()
let exposedApi: Record<string, unknown> | undefined

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      registered.set(channel, listener)
    },
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      invoked.add(channel)
      const listener = registered.get(channel)
      if (!listener) throw new Error(`no main handler registered for ${channel}`)
      return listener({}, ...args)
    },
    on: (channel: string) => {
      subscribed.add(channel)
    },
    off: () => {},
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposedApi = api
    },
  },
  webUtils: {
    getPathForFile: () => '/videos/dropped.mp4',
  },
}))

const REQUEST_CHANNELS = Object.values(CHANNELS).filter(
  (channel) => channel !== CHANNELS.transcribeState && channel !== CHANNELS.modelsProgress,
)

async function registerAllHandlers(): Promise<void> {
  const { registerIpcHandlers } = await import('../../../src/main/ipc/index.js')
  registerIpcHandlers({
    transcribe: {
      start: async () => 'job-1',
      cancel: async () => {},
      stateOf: () => undefined,
      cancelActive: async () => {},
    },
    models: {
      list: async () => [],
      download: async () => {},
      cancelDownload: async () => {},
      remove: async () => {},
    },
    settings: {
      get: async () => ({
        version: 1,
        englishOnly: false,
        activeModel: null,
        language: 'auto',
        throughput: {},
      }),
      set: async () => ({
        version: 1,
        englishOnly: false,
        activeModel: null,
        language: 'auto',
        throughput: {},
      }),
    },
    export: {
      save: async () => '/videos/interview.txt',
      reveal: async () => {},
    },
    dialog: {
      openFile: async () => null,
    },
    droppedFile: {
      register: async () => {},
    },
  })
}

async function exerciseThePreload(): Promise<void> {
  await import('../../../src/preload/index.js')
  const api = exposedApi as {
    transcribe: {
      start: (p: string) => Promise<unknown>
      cancel: (id: string) => Promise<unknown>
      onState: (cb: () => void) => void
    }
    models: {
      list: () => Promise<unknown>
      download: (id: string) => Promise<unknown>
      cancelDownload: (id: string) => Promise<unknown>
      remove: (id: string) => Promise<unknown>
      onProgress: (cb: () => void) => void
    }
    settings: { get: () => Promise<unknown>; set: (p: object) => Promise<unknown> }
    exportTranscript: { save: (id: string, as: string) => Promise<unknown> }
    dialog: { openFile: () => Promise<unknown> }
    shell: { reveal: (p: string) => Promise<unknown> }
    droppedFile: { pathFor: (f: unknown) => string }
  }

  await api.transcribe.start('/videos/interview.mp4')
  await api.transcribe.cancel('job-1')
  api.transcribe.onState(() => {})

  await api.models.list()
  await api.models.download('tiny')
  await api.models.cancelDownload('tiny')
  await api.models.remove('tiny')
  api.models.onProgress(() => {})

  await api.settings.get()
  await api.settings.set({})

  await api.exportTranscript.save('job-1', 'txt')
  await api.dialog.openFile()
  await api.shell.reveal('/videos/interview.txt')

  api.droppedFile.pathFor({} as never)
  // pathFor's registration invoke is fire-and-forget; let it land.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('main and preload agree on every channel name', () => {
  beforeEach(() => {
    registered.clear()
    invoked.clear()
    subscribed.clear()
    exposedApi = undefined
    vi.resetModules()
  })

  it('registers exactly the channels the channel list declares as requests', async () => {
    await registerAllHandlers()

    expect([...registered.keys()].sort()).toEqual([...REQUEST_CHANNELS].sort())
  })

  it('invokes exactly the channels main registers — a typo on either side fails this', async () => {
    await registerAllHandlers()
    await exerciseThePreload()

    expect([...invoked].sort()).toEqual([...registered.keys()].sort())
  })

  it('subscribes to exactly the two push channels', async () => {
    await registerAllHandlers()
    await exerciseThePreload()

    expect([...subscribed].sort()).toEqual(
      [CHANNELS.transcribeState, CHANNELS.modelsProgress].sort(),
    )
  })
})
```

This is the wiring gap this project has been bitten by before: every handler above is unit-tested
in isolation, and nothing until this step proves the channel *names* actually line up end to end.
Both the registered set and the invoked set are computed, never hand-written, so a typo in the test
itself cannot quietly agree with a typo in the code.

Run: `npx vitest run test/main/ipc/path-trust.test.ts test/main/ipc/wiring.test.ts`
Expected: PASS, 6 tests (3 + 3).

- [ ] **Step 20: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: everything passes; both programs clean; the build produces `out/main/index.js` with `electron`, `ffmpeg-static`, `ffprobe-static` and `node:*` as its only external imports.

Run: `npm run dev`, and in devtools: `await window.whisperDrop.models.list()`.
Expected: five rows with `installed: false` on a fresh profile.

Then: `await window.whisperDrop.transcribe.start('/nonexistent.mp4')`.
Expected: rejects with `{code: 'NO_MODEL_INSTALLED', message: 'Choose a model first.'}` — a plain object carrying `code`, which is the proof the error envelope survives the bridge.

Then: `await window.whisperDrop.shell.reveal('/etc/passwd')`.
Expected: rejects with `code: 'INVALID_REQUEST'` and nothing opens in Finder.

Then, on a file dropped onto the window (or via `window.whisperDrop.dialog.openFile()`, since
there is no drop zone yet): the returned path transcribes normally, and a path typed directly into
`window.whisperDrop.transcribe.start('/etc/passwd')` — one main never issued — rejects with
`code: 'INVALID_REQUEST'`.

- [ ] **Step 21: Commit**

```bash
git add src test
git commit -m "feat: validated IPC handlers and the composition root"
```

---


## Done when

- `npm run dev` opens a window with the full security posture (contextIsolation, sandbox,
  nodeIntegration off, CSP, denied window-opens and navigation).
- The electron-import boundary test passes, failing the build on any import outside the allowlist,
  and on any Node builtin or Node global reached from `src/renderer` or `src/shared`.
- Every IPC handler unit-tests without an Electron harness.
- Boundary validation holds: jobId is an opaque Map key never a path, model ids are checked against
  the catalog, format is checked against three literals, reveal is allowlisted to paths main
  returned, `transcribe.start` accepts only a path main itself issued via `dialog.openFile` or a
  dropped file's `pathFor`, and a second concurrent transcription is refused.
- A test proves the exact set of channels `registerIpcHandlers` registers matches the exact set the
  preload bridge invokes, so a channel-name typo on either side fails the suite rather than failing
  silently at runtime.
- The existing 211 tests stay green and stay fast.

## What part 3b picks up

The React UI: the five-state machine, drop zone, model picker, transcript viewer, export, error
surface, and the Playwright-on-Electron smoke test.
