# whisper-drop Part 3 — Electron App, IPC and UI — Design

**Date:** 2026-08-14
**Status:** Approved (self-approved under the unsupervised directive — see Approval note)
**Parent spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md` — binding authority.
Where this document disagrees with it, the parent wins and this document is the defect.

## Approval note

Written unsupervised under a directive to make the recommended call rather than wait. Every
judgement is recorded under [Decisions made unsupervised](#decisions-made-unsupervised).

## Summary

The part that makes whisper-drop an application: an Electron shell, a narrow typed IPC surface,
and a React UI with five states. Parts 1 and 2 provide everything underneath — transcription and
model management — and this part composes them and puts a window in front.

## Scope

**In:** the Electron main process and window lifecycle, the composition root that injects the
user-data directory, the preload bridge, IPC handlers, the React UI (drop zone, progress, model
picker, transcript viewer, error surface), export-to-file, and app-quit cleanup.

**Out:** packaging, code signing, releases, and cross-platform build matrices — all part 4. Also
out: the batch queue, translation, custom vocabulary, and word-level timestamps, which the parent
spec lists as later features.

## What parts 1 and 2 already give us

| From | Interface |
|---|---|
| `main/jobs/transcription-job` | `TranscriptionJob(deps, input)` with `start`, `cancel`, `subscribe`, `state` |
| `main/media/probe` · `media/extract` · `whisper/runner` | the concrete collaborators the job's ports adapt to |
| `main/export/formatters` | `format(segments, 'txt' \| 'srt' \| 'vtt')` |
| `main/binaries` | `whisperCliPath`, `ffmpegPath`, `ffprobePath`, `resourcesDir` |
| `main/models/catalog` | `CATALOG`, `MODEL_BASE_ORDER`, `resolveModelId`, `entryFor`, `baseIds` |
| `main/models/store` | `createModelStore(dir)` → `pathFor`, `isInstalled`, `verify`, `listInstalled`, `remove`, `install` |
| `main/settings` | `createSettingsStore(dir, locale)` → `read`, `write`, `recordThroughput` |
| `shared/types` · `shared/errors` | `JobState`, `Segment`, `ErrorCode`, `AppError` |

## Architecture

### Processes and the one place Electron is allowed

`src/main/ipc/` is the **only** directory permitted to import `electron`, and this part is the
first to create it. Everything else stays plain Node, which is what has kept 211 tests running in
under a second without an app harness.

- **`src/main/index.ts`** — the composition root. The single place that calls
  `app.getPath('userData')` and hands it to `createModelStore` and `createSettingsStore`. This is
  why those take a directory by injection.
- **`src/main/ipc/*`** — handler modules, one per domain (transcribe, models, settings, export).
  Thin: validate, delegate, translate errors. No business logic.
- **`src/preload/index.ts`** — `contextBridge.exposeInMainWorld` of the typed API. Nothing else.
- **`src/renderer/`** — React. No Node, no Electron, no filesystem.

### Renderer security posture

Non-negotiable, because this app accepts arbitrary files by drag and drop:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- `webSecurity` left on. No `allowRunningInsecureContent`.
- A Content-Security-Policy meta tag with `default-src 'self'`; no remote origins, since the
  renderer never loads anything from the network.
- `setWindowOpenHandler` denies all window opens, and `will-navigate` is blocked — a transcript is
  arbitrary text and must never be able to navigate the shell.
- The renderer receives **no absolute paths it did not already have**, except the source file path
  it needs to display a filename. It never constructs a path.

## The IPC contract

The parent spec fixes this surface. Reproduced here with the validation each handler performs.

```ts
transcribe.start(filePath: string): Promise<string>   // returns jobId
transcribe.cancel(jobId: string): Promise<void>
transcribe.onState(cb: (s: JobState) => void): Unsubscribe

models.list(): Promise<ModelRow[]>
models.download(base: ModelBaseId): Promise<void>
models.cancelDownload(base: ModelBaseId): Promise<void>
models.remove(base: ModelBaseId): Promise<void>
models.onProgress(cb: (p: DownloadProgress) => void): Unsubscribe

settings.get(): Promise<Settings>
settings.set(patch: Partial<Settings>): Promise<Settings>

exportTranscript.save(jobId: string, format: 'txt'|'srt'|'vtt'): Promise<string>
dialog.openFile(): Promise<string | null>
shell.reveal(path: string): Promise<void>
```

### Validation at the boundary — the lesson from parts 1 and 2

Part 2's whole-branch review found two path/URL trust bypasses. Both were unreachable at the time
precisely because no IPC layer existed yet. This part creates that reachability, so the boundary
validates rather than trusting:

- **`jobId` is generated in main with `randomUUID()` and never accepted as a path component.**
  Part 1's `tempWavPath(id)` puts the id straight into a filesystem path; a renderer-supplied id
  would be a traversal. Handlers look jobs up in a `Map<string, TranscriptionJob>` and reject an
  unknown id — the id is a key, never a path.
- **`ModelBaseId` is checked against `MODEL_BASE_ORDER`** before reaching the store, even though
  the store now validates too. Defence at the boundary and at the owner.
- **`format` is checked against the three literals.**
- **`shell.reveal` only accepts a path this main process previously returned** from
  `exportTranscript.save`, tracked in a set. The renderer cannot ask the shell to reveal anything
  it likes.
- **`filePath` from a drop or the open dialog is OS-supplied** and passed through unchanged; it is
  the one path that legitimately originates outside. `probe` is the validity gate, per the parent
  spec's no-extension-allowlist rule.

### One job at a time

The parent spec scopes v1 to a single file. Main holds at most one active job. `transcribe.start`
while a job is running rejects with a clear error rather than queueing — the batch queue is an
explicit later feature and pretending otherwise would leave a half-queue in the code.

## Job lifecycle

`transcribe.start` composes the real collaborators into `JobDeps`, exactly as part 1's integration
test does:

- `probe: (path, signal) => probe(path, { signal })`
- `extract: (opts) => extractWav(opts)`
- `run: (opts, onSegment) => runWhisper({ ...opts, onSegment })`
- `tempWavPath: (id) => join(app.getPath('temp'), `whisper-drop-${id}.wav`)`
- `removeFile: (p) => rm(p, { force: true })`
- `now: () => Date.now()`

The model path comes from `store.pathFor(resolveModelId(settings.activeModel, settings.englishOnly))`,
and the job is refused with `NO_MODEL_INSTALLED` if `activeModel` is null or the resolved model is
not installed.

`JobState` is forwarded to the renderer on every update. It is already plain serialisable data —
part 1 made `error` a `{code, message, detail?}` literal rather than an `AppError` instance
specifically so it could cross this boundary.

**On completion**, main calls `settings.recordThroughput(resolvedModelId, state.realtimeFactor)`.
That is the loop the parent spec describes: measured speed feeds the model picker.

**Progress after cancel.** Part 1's review noted that buffered segment lines can still arrive
between `cancel()` and the child dying, so the bar can advance briefly after the user clicks
Cancel. The UI freezes the progress display on cancel rather than showing it creep — the state is
honest, the presentation just stops chasing it.

**App quit.** `before-quit` cancels the active job and awaits its cleanup. The parent spec assigns
this to part 3 explicitly: it is the one temp-WAV escape path part 1 could not close.

## Model downloads

Downloads are owned by main and keyed by `ModelBaseId`. `models.download` resolves the base id
against the current `englishOnly` setting, then calls `store.install`. Part 2's in-flight map
already deduplicates, so a double-clicked button is harmless.

`models.cancelDownload` aborts via a `Map<ModelBaseId, AbortController>` held in main. Part 2
keeps the `.part` file on abort, so the UI's Retry resumes rather than restarting.

`models.list` composes one row per picker row:

```ts
type ModelRow = {
  base: ModelBaseId
  resolved: ModelEntry        // after the English-only toggle
  installed: boolean
  realtimeFactor?: number     // measured on this machine; absent if never run
  downloading?: DownloadProgress
}
```

## UI

One window, five states, no router. Matches the parent spec.

| State | Contents |
|---|---|
| **First run** | Model picker with the size/speed/accuracy tradeoff explained. Shown whenever no model is installed. During the first download the drop target is visible but disabled, showing progress and why it is waiting. |
| **Idle** | Full-window drop target, click-to-browse fallback, active model and language in the header. |
| **Working** | Filename, duration, phase label, progress bar, ETA, Cancel. |
| **Done** | Transcript as readable paragraphs; Copy, Save .txt, Save .srt, Save .vtt, Transcribe another. |
| **Error** | Plain-language message, suggested action, technical detail behind a disclosure, retry path. |

`dragover`/`drop` are intercepted at the window level with `preventDefault()`, so a dropped file
never navigates the renderer. Dropping several files takes the first and says the app handles one
at a time for now.

### The model picker

Five rows in capability order, one **English only / All languages** toggle. The toggle swaps which
weights the same rows resolve to; the two large rows are unchanged by it and say so, because
OpenAI shipped no `.en` weights above `small`. Each row shows size, blurb, install state, and — for
models actually run on this machine — the measured realtime factor. A model never run shows
relative ordering only, never a fabricated benchmark.

Flipping the toggle can turn an installed row into an uninstalled one, since `base` and `base.en`
are separate files. The picker shows that plainly. Flipping never deletes anything.

### Export

Writes next to the source file with the same basename — `interview.mp4` → `interview.srt` — then a
toast with a Reveal action. An existing file gets ` (2)` appended rather than being overwritten,
per the parent spec's ruling.

### Visual direction

The app is visually neutral and carries no Human Balance AI branding; HBAI is credited in the
README and the Licenses screen. The UI should look deliberate rather than templated — this is a
tool someone hands to a client — so the implementation uses the `frontend-design` skill for
typography, spacing and colour rather than defaulting to unstyled elements or a component library.
Constraint: no CSS framework dependency, no icon-font downloads, and the renderer loads nothing
from the network.

## Errors

Every `ErrorCode` from the parent spec maps to a plain-language message and a suggested action,
with technical detail behind a disclosure formatted for pasting into a GitHub issue. The UI never
shows a raw stack or a bare `ENOENT`. Part 2's watchdog work matters here: a stalled download
surfaces as a network error with a Retry, not as a silent hang and not as a cancellation.

## Testing

- **IPC handlers** unit-tested with fake stores/jobs: id validation, unknown-id rejection, the
  one-job-at-a-time rule, the reveal allowlist, and error translation. No Electron needed if the
  handler modules take their dependencies by injection and only `ipc/index.ts` touches
  `ipcMain.handle`.
- **React components** tested with Vitest + Testing Library against a fake preload API: each of the
  five states renders, drop handling, the toggle's partial swap, progress and ETA formatting,
  export actions.
- **One Playwright-on-Electron smoke test**: launch, drop the part 1 fixture, assert a transcript
  appears. This is the only test that proves preload, IPC, and renderer are wired to each other.
- The existing 211 tests must stay green and stay fast.

## New dependencies

Unavoidable for this part, and the first added since part 1: `electron`, `electron-vite`, `vite`,
`react`, `react-dom`, `@vitejs/plugin-react`, and for tests `@testing-library/react`,
`@testing-library/user-event`, `jsdom`, `playwright`. No UI component library, no CSS framework,
no state-management library — the app has five states and one active job.

## Decisions made unsupervised

1. **Reject a second concurrent transcription rather than queueing.** Alternatives: an implicit
   queue (ships half of a Later feature with no UI for it) or replacing the running job (silently
   discards work). Rejecting is honest and one line to change when the queue lands. *Cost if
   wrong:* a user who drops a second file gets a message instead of a queue.
2. **`shell.reveal` uses an allowlist of paths main itself returned.** Alternative: accept any path
   from the renderer. Given two path-trust bypasses were found in part 2, letting the renderer name
   an arbitrary path to surface in Finder is not worth the convenience. *Cost if wrong:* a future
   feature wanting to reveal something else must register it.
3. **Handler modules take dependencies by injection; only `ipc/index.ts` imports `electron`.**
   Alternative: handlers import Electron directly, which is simpler but makes them untestable
   without an app harness and erodes the constraint that has kept the suite fast. *Cost if wrong:*
   one extra wiring file.
4. **Freeze the progress display on cancel** rather than letting it advance from buffered segments.
   Alternative: show the true state, which looks like the Cancel button did nothing. *Cost if
   wrong:* the displayed percentage can be marginally stale at the moment of cancellation.
5. **No UI component library or CSS framework.** Alternative: shadcn/Tailwind, which is faster to
   assemble but adds dependency weight and a generic look to an app whose whole pitch is being a
   focused single-purpose tool. *Cost if wrong:* more hand-written CSS.

## Corrections found during planning

Compile-verifying the plan against a real build surfaced eight defects in this spec. All are
corrected in `docs/superpowers/plans/2026-08-14-part3-electron-app.md`; recorded here so the two
documents agree and so the errors are not repeated.

1. **The electron-import rule contradicted itself.** This spec says only `src/main/ipc/` may import
   `electron`, and also that `src/main/index.ts` calls `app.getPath('userData')`. Both cannot hold.
   Resolution: a four-file allowlist enforced by a test that fails the build on any other import —
   a check rather than a convention.
2. **Drag-and-drop is impossible as specified.** Electron 32 removed `File.path`, so the renderer
   cannot learn a dropped file's path. Resolution: a `droppedFile.pathFor` preload method backed by
   `webUtils.getPathForFile`. Without this the app's central interaction does not work.
3. **Errors cannot cross `contextBridge` intact.** The bridge copies only `message` and `stack` off
   a thrown `Error`, silently dropping `code` and `detail` — the two fields the entire error UI is
   built on. Resolution: carry failures as data (`IpcResult`) rather than throwing across the
   bridge.
4. **Three boundary conditions have no matching `ErrorCode`** (unknown job id, non-allowlisted
   reveal path, second concurrent job). The parent spec fixes the enum at nine values, so widening
   it is not available. Resolution: a separate `IpcBoundaryCode` union.
5. **The CSP as specified breaks `npm run dev`** — the React Fast Refresh preamble is an inline
   module script that `script-src 'self'` blocks. Resolution: inject the tag from the Vite config
   with a dev/prod branch, production strict, and unit-test the branching.
6. **"Shown whenever no model is installed" is ambiguous once the toggle exists.** Resolution:
   first-run means the *active row's resolved* model is not on disk, which makes the toggle's
   honest cost visible rather than hiding it.
7. **"Freeze the progress display" was underspecified.** Resolution: accept the new phase and
   segments but retain the last-seen `progress` and `etaMs`, so state stays truthful and only the
   presentation stops chasing.
8. **The transcript paragraph rule had no threshold.** Resolution: a named 1500 ms gap constant.

**Carried to part 4:** `binaries.ts` resolves `../../resources/<platform>-<arch>` from `out/main/`
and lands on the repo's `resources/` by a coincidence of directory depth. It works and was
verified, but nothing asserts it, and only the e2e smoke test would catch a break — by failing to
transcribe. Packaging must pin this properly.
