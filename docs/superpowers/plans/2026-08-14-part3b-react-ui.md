# whisper-drop Part 3b — React UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The React UI in front of 3a's Electron shell — five states (drop a file, watch honest
progress, read the transcript, save it next to the source, or see a plain-language error) plus the
model picker, and one Playwright-on-Electron smoke test proving the whole chain wired together.

**Architecture:** Four electron-importing files and nothing else. `src/main/index.ts` is the composition root: it is the only place that reads `app.getPath('userData')` and the only place that knows the real `probe`/`extract`/`runWhisper` collaborators exist. Every IPC handler module takes its dependencies by injection and knows nothing about Electron, so the whole boundary — id validation, the one-job-at-a-time rule, the reveal allowlist, error translation — is unit-tested without an app harness. The renderer is React with no router, no state library and no CSS framework; its state is one pure reducer, tested as pure data.

**Tech Stack:** TypeScript 5 (ESM), Vitest 4, Node 22, Electron 43, electron-vite 5, Vite 7, React 19, `@vitejs/plugin-react` 5, Testing Library 16 + jsdom for components, `playwright`'s `_electron` for one smoke test.

**Spec:** `docs/superpowers/specs/2026-08-14-part3-electron-app-design.md`
(This spec doc lands in the same branch as this plan, `part-3-electron-app`; it does not exist on
`main` until part 3 merges.)
**Parent spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md` — binding authority.

## Scope

This is plan 3b of 4 (3a and 3b together are "plan 3" — one plan, split into two documents because
the combined draft exceeded the review tool's size limit). It builds directly on 3a and assumes the
IPC surface — `window.whisperDrop`, every handler, and the boundary validation, including the path
trust boundary — already exists and is tested. Parts 1 and 2 are merged on `main`: 211 tests, all
green, `tsc --noEmit` clean.

**In scope:** the React UI (drop zone, working, done, error, model picker), export-to-file with the collision rule, and one Playwright-on-Electron smoke test.

**Out of scope, built by 3a:** the electron-vite scaffold, the main-process entry and window
lifecycle with the spec's security posture, the preload bridge, the shared IPC contract types, the
IPC handler modules, the composition root, and `before-quit` cleanup.

**Out of scope, deferred to plan 4:** `electron-builder` packaging, code signing, releases, GitHub Actions, the README and the Licenses screen. Also out, per the parent spec's Later list: batch queue, translation, custom vocabulary, word-level timestamps.

**Deliverable:** `npm run dev` opens a working app — drop a file, watch progress, read the
transcript, save it. `npm test` passes the unit suite in seconds. `npm run test:e2e` launches the
built app, transcribes `test/fixtures/hello.mp4`, and asserts the transcript renders.

## Deviations from the spec

Four, recorded here so none of them is silent.

1. **Four files may import `electron`, not one directory.** The part 3 spec says "`src/main/ipc/` is the only directory permitted to import `electron`" and, two paragraphs later, that `src/main/index.ts` calls `app.getPath('userData')`. Those cannot both hold: `src/main/index.ts` is the Electron entry point and must call `app.whenReady()`. The rule this plan enforces — and enforces with a test, not a convention — is an explicit four-file allowlist: `src/main/index.ts`, `src/main/window.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`. Every handler module, and everything under `src/main/` that carries logic, stays plain Node. The parent spec's actual wording ("Modules under `src/main/` other than `ipc/` must not import `electron`") is about logic modules, and that intent is preserved exactly.

2. **The shared types the renderer needs move to `src/shared/types.ts`.** The parent spec's "Shared types" section declares `ModelBaseId`, `ModelId`, `ModelEntry`, `DownloadProgress` and `Settings` as shared. Part 2 declared them inside `models/catalog.ts`, `models/download.ts` and `settings.ts` instead, which was correct while nothing else needed them. It is not correct now: the renderer must name them, and the renderer must not import from `src/main/`. Task 2 moves the declarations to `src/shared/types.ts` and re-exports them from their current homes, so every existing import keeps working. **Verified:** this move alone leaves all 211 existing tests green and `tsc --noEmit` clean.

3. **The IPC surface gains `droppedFile.pathFor(file)`.** Neither spec lists it, and without it the drop zone cannot work at all: Electron 32 removed the `File.path` property, and a dropped file's real path is now obtainable only from a preload calling `webUtils.getPathForFile(file)`. This is the one addition to the contract, and it is a getter over an OS-supplied `File`, not a new capability.

4. **A path trust boundary the specs describe as a property, not a mechanism.** 3a's `src/main/ipc/trusted-paths.ts` is a small issue/consume registry held in main. `dialog.openFile` and the preload's `droppedFile.pathFor` are the only two ways a path reaches the renderer, and both issue into it — `pathFor` does so over a new renderer-to-main-only channel, `droppedFileRegister`, never exposed on `WhisperDropApi`. `transcribe.start` consumes an entry before acting on a path and rejects anything else with `INVALID_REQUEST`. This is built entirely in 3a; it is recorded here too because it changes what the drop zone in Task 4/5 can assume: the path it gets back from `pathFor` is already trusted by the time `transcribe.start` is called, so this UI never needs to think about the boundary itself.

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
  // Asserted separately from the source-file check above: if the copy silently
  // failed or landed at the wrong path, the failure should say so, rather than
  // surfacing 240 seconds later as a mysterious NO_MODEL_INSTALLED/timeout.
  expect(existsSync(join(userData, 'models', 'tiny.bin')), 'seeded model did not land in userData').toBe(
    true,
  )
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
