# whisper-drop — Design

**Date:** 2026-08-13
**Status:** Approved, pending implementation plan

## Summary

A cross-platform desktop app that turns audio and video files into text. Drag a
file onto the window, get a transcript. Transcription runs entirely on the local
machine using OpenAI's Whisper models via `whisper.cpp`. The user chooses which
model size to download.

Open source under MIT, distributed through GitHub Releases, and given to Human
Balance AI clients as a free tool.

## Goals

- Drag a media file onto the window and get a transcript, with no configuration
  beyond picking a model once.
- Run on macOS, Windows, and Linux.
- Let the user choose and download any Whisper model size.
- Keep audio on the user's machine. No uploads, no telemetry.
- Handle a 90-minute video without freezing, with honest progress and a working
  cancel button.
- Be a repo a stranger can clone, build, and contribute to.

## Non-goals for v1

Listed here so they are not smuggled in during implementation. Each is tracked
in [Later](#later).

- Batch queues or folder drops.
- Speaker diarization.
- Word-level timestamps.
- Translation to English.
- Custom vocabulary / initial-prompt injection.
- Auto-update.
- Code signing on any platform.

## Users and use cases

Two audiences: Ben, and Human Balance AI clients who are not technical.

| Use case | Typical length |
|---|---|
| Course content video | 10–45 minutes |
| 1:1 consultation session recording | ~90 minutes |
| Voice memo note | under 15 seconds |

Files arrive one at a time and may be video or audio in any container.

Consultation recordings are confidential client material. This is the reason
local-only processing is a hard constraint rather than a preference.

## Constraints and principles

1. **Local only.** The sole network requests the app ever makes are model
   downloads from HuggingFace. No telemetry, no crash reporting, no update
   check. Once models are downloaded, the app works offline.
2. **The UI never blocks.** All heavy work happens in spawned child processes.
3. **Cancel always works, and always cleans up.** No orphaned processes, no
   abandoned temp files.
4. **Logic does not import Electron.** Core modules are plain Node so they are
   testable without an app harness.
5. **Errors say what happened in plain language**, with technical detail behind
   a disclosure for bug reports.

## Technology choices

### Whisper runtime: whisper.cpp

`whisper.cpp` is a C++ port of Whisper that runs the same OpenAI model weights
converted to GGML format. Same model lineup, same transcripts. It ships as a
self-contained binary with Metal acceleration on macOS and CPU fallback
everywhere, and it is MIT licensed.

**Rejected:** the reference `openai/whisper` Python package. PyInstaller-bundling
Python and PyTorch pushes the installer past 2 GB before a single model is
downloaded, requires diverging CUDA/MPS builds, and inflicts Python environment
failures on non-technical users.

### App shell: Electron + TypeScript + React

Built with `electron-vite`.

Chosen because it keeps the entire repo in one language, matches the existing
`pdf-renderer` Electron app in this workspace (so packaging and CI are solved
patterns), and has the largest contributor pool for an open-source project. The
~120 MB Chromium cost is irrelevant next to model downloads of 142 MB to 3.1 GB.

**Rejected:** Tauri. Produces a much smaller binary, but requires a Rust
toolchain, has a smaller contributor pool, and cross-compiling native GPU
backends for three platforms is fiddly. Binary size is not the binding
constraint here.

### Media decoding: ffmpeg

`whisper.cpp` reads 16 kHz mono WAV only. ffmpeg handles every container and
codec a user might drop, and `ffprobe` doubles as the file-validity check.

## Architecture

### Processes

| Process | Responsibility |
|---|---|
| Electron main (Node) | Filesystem, child processes, model store, settings, IPC |
| Renderer (React) | UI only. `contextIsolation: true`, `nodeIntegration: false`, sandboxed |
| Sidecars | `ffprobe`, `ffmpeg`, `whisper-cli`, spawned per job and per phase |

The renderer reaches the main process only through a typed preload API. It never
touches `fs`, `child_process`, or a file path it did not receive from main.

### Module map

Modules under `src/main/` other than `ipc/` must not import `electron`.

| Module | Responsibility | Nature |
|---|---|---|
| `binaries` | resolve `whisper-cli`, `ffmpeg`, `ffprobe` paths | pure lookup |
| `media/probe` | `ffprobe` a path → `MediaInfo` | wrapper |
| `media/extract` | any media file → 16 kHz mono WAV in temp, with progress | wrapper |
| `whisper/parse` | whisper-cli stdout lines → `Segment[]` | **pure** |
| `whisper/runner` | spawn `whisper-cli`, stream segments, cancel | wrapper |
| `models/catalog` | the model list | **pure data** |
| `models/download` | resumable, checksum-verified HTTP download | wrapper |
| `models/store` | installed-model state on disk; install, list, remove | stateful |
| `export/formatters` | `Segment[]` → txt / srt / vtt strings | **pure** |
| `settings` | active model, language, measured throughput | stateful |
| `jobs/transcription-job` | orchestrates a single job; the only holder of job state | stateful |
| `ipc/*` | wires the above to the renderer; contains no logic | glue |

`transcription-job` takes its probe, extract, and run collaborators by injection,
so the state machine, cancellation, and cleanup are testable without spawning
anything.

### Directory layout

```
whisper-drop/
├─ src/
│  ├─ main/
│  │  ├─ index.ts
│  │  ├─ ipc/
│  │  ├─ jobs/transcription-job.ts
│  │  ├─ media/{probe.ts, extract.ts}
│  │  ├─ whisper/{runner.ts, parse.ts}
│  │  ├─ models/{catalog.ts, download.ts, store.ts}
│  │  ├─ export/formatters.ts
│  │  ├─ binaries.ts
│  │  └─ settings.ts
│  ├─ preload/index.ts
│  ├─ renderer/
│  └─ shared/types.ts
├─ resources/                 # gitignored; populated by build-whisper
├─ scripts/build-whisper.mjs
├─ whisper.manifest.json
├─ test/fixtures/
├─ docs/superpowers/specs/
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ LICENSE                    # MIT
└─ README.md
```

### Shared types

```ts
type Segment = {
  index: number      // 0-based; SRT numbering adds 1 at format time
  startMs: number
  endMs: number
  text: string
}

type MediaInfo = {
  path: string
  durationMs: number
  hasAudio: boolean
  container: string
}

// What the user picks: a row in the model list.
type ModelBaseId =
  | 'tiny' | 'base' | 'small' | 'large-v3-turbo' | 'large-v3'

// What actually gets downloaded and run.
type ModelId = ModelBaseId | 'tiny.en' | 'base.en' | 'small.en'

// Pure. The only place the base -> concrete mapping lives.
// Returns the .en variant when English-only is on and one exists,
// otherwise the multilingual weights.
declare function resolveModelId(
  base: ModelBaseId,
  englishOnly: boolean,
): ModelId

type ModelEntry = {
  id: ModelId
  base: ModelBaseId
  label: string
  bytes: number
  sha256: string
  url: string
  blurb: string
  englishOnly: boolean    // true for the .en weights
}

type JobPhase =
  | 'probing' | 'preparing' | 'transcribing'
  | 'done' | 'cancelled' | 'failed'

// Serialisable: this crosses the IPC boundary, so it holds plain data only.
type JobState = {
  id: string
  filePath: string
  media?: MediaInfo
  phase: JobPhase
  progress: number        // 0..1, spans all phases
  etaMs?: number
  segments: Segment[]
  // durationMs / transcribeElapsedMs. Present only once phase is 'done'.
  // This is what feeds Settings.throughput.
  realtimeFactor?: number
  error?: { code: ErrorCode; message: string; detail?: string }
}

type ErrorCode =
  | 'NO_AUDIO_STREAM' | 'UNREADABLE_MEDIA'
  | 'NO_MODEL_INSTALLED' | 'MODEL_FILE_MISSING'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'DOWNLOAD_CHECKSUM_MISMATCH' | 'DOWNLOAD_NETWORK_ERROR'
  | 'WHISPER_FAILED' | 'FFMPEG_FAILED'

// Implemented as a throwable class extending Error, with a toJSON() producing
// the plain shape above for JobState.error.
type AppError = {
  code: ErrorCode
  message: string         // plain language, shown directly
  detail?: string         // stderr tail, behind a disclosure
}

type DownloadProgress = {
  id: ModelId
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
}

type Settings = {
  englishOnly: boolean      // defaults from OS locale on first launch
  activeModel: ModelBaseId | null
  language: string          // ISO 639-1 code, or 'auto'. Ignored while englishOnly.
  throughput: Partial<Record<ModelId, {
    realtimeFactor: number  // durationMs / transcribeElapsedMs
    samples: number
  }>>
}

type Unsubscribe = () => void
```

### IPC surface

The complete preload API. Anything not here is not reachable from the renderer.

```ts
transcribe.start(filePath): Promise<string>   // jobId
transcribe.cancel(jobId): Promise<void>
transcribe.onState(cb: (s: JobState) => void): Unsubscribe

// One entry per picker row, already resolved against the English-only toggle.
models.list(): Promise<{
  base: ModelBaseId
  resolved: ModelEntry
  installed: boolean
  realtimeFactor?: number   // measured on this machine; absent if never run
}[]>
models.download(id): Promise<void>
models.cancelDownload(id): Promise<void>
models.remove(id): Promise<void>
models.onProgress(cb: (p: DownloadProgress) => void): Unsubscribe

settings.get(): Promise<Settings>
settings.set(patch: Partial<Settings>): Promise<Settings>

exportTranscript.save(jobId, format: 'txt'|'srt'|'vtt'): Promise<string>  // path
dialog.openFile(): Promise<string | null>
shell.reveal(path): Promise<void>
```

## Transcription pipeline

A job runs four phases. Progress is a single 0..1 value spanning all of them.

| Phase | Work | Progress band |
|---|---|---|
| `probing` | `ffprobe` → duration, audio-stream presence, container | 0.00 – 0.02 |
| `preparing` | `ffmpeg` → 16 kHz mono `pcm_s16le` WAV in temp dir | 0.02 – 0.08 |
| `transcribing` | `whisper-cli` streaming stdout | 0.08 – 1.00 |
| `done` | temp WAV deleted, segments held in memory | 1.00 |

**File validity is determined by ffprobe, not by an extension allowlist.** If
ffmpeg can read it, the app accepts it. This is why `.m4v`, `.opus`, and
containers nobody anticipated all work.

**Transcription progress is real, not simulated.** Total duration is known from
the probe, and `whisper-cli` emits segments with end timestamps as it decodes,
so progress is `lastSegmentEndMs / durationMs`.

**ETA** is withheld until transcription is 10% complete, then computed as
`elapsedTranscribeMs * (1 - p) / p` where `p` is transcription-phase progress.
Before that threshold the throughput sample is too noisy to show.

**Throughput is recorded** on completion as a realtime factor
(`durationMs / transcribeElapsedMs`) per model id, kept as a running average in
settings. The model picker uses it (see [Model management](#model-management)).

**Cancellation** is available in every phase. It kills the active child process,
deletes the temp WAV, and returns the UI to Idle. Temp WAV deletion also runs on
failure and on app quit.

**Multiple dropped files:** the first is accepted and the UI states that the app
handles one file at a time for now.

## Model management

### Catalog

`models/catalog.ts` is pure data, one entry per model, versioned in the repo.
Adding a model upstream ships is a PR touching one file.

Models are fetched from the official `ggerganov/whisper.cpp` HuggingFace
repository. Approximate sizes:

| Model | Size | Blurb |
|---|---|---|
| `tiny` | ~75 MB | Fastest. Rough. Fine for voice memos. |
| `base` | ~142 MB | Good default. Quick, decent accuracy. |
| `small` | ~466 MB | Better with accents and crosstalk. |
| `large-v3-turbo` | ~1.6 GB | Near-best accuracy, several times faster than `large-v3`. Recommended for long recordings. |
| `large-v3` | ~3.1 GB | Best accuracy. Slow. |

Exact byte counts and sha256 hashes are read from upstream and pinned into the
catalog during implementation. They are never approximated in code.

### The English-only toggle

The picker carries one toggle: **English only** / **All languages**. It does not
lengthen the list — it swaps which weights the same five rows resolve to.

OpenAI never shipped English-only weights above `medium`, so the swap is partial:

| Row | All languages | English only |
|---|---|---|
| `tiny` | `tiny` | `tiny.en` |
| `base` | `base` | `base.en` |
| `small` | `small` | `small.en` |
| `large-v3-turbo` | `large-v3-turbo` | *unchanged* — multilingual weights, still the most accurate option for English |
| `large-v3` | `large-v3` | *unchanged* — same |

The two large rows stay visible in English-only mode with that note attached.
Hiding them would be baffling given `large-v3-turbo` is the recommendation.

`resolveModelId(base, englishOnly)` is the single pure function performing this
mapping. Nothing else in the codebase constructs a concrete `ModelId`.

**The toggle absorbs the language setting.** English-only implies `language =
'en'`, so the language control is hidden while the toggle is on. One control
instead of two, and the mode is stated in one place rather than inferred from
the combination.

**It defaults from the OS locale** on first launch: an English system language
starts in English-only. Correct for the primary audience without being wrong for
everyone else.

**The honest cost:** `base` and `base.en` are separate files on disk, so flipping
the toggle can turn an installed row into an uninstalled one. The picker shows
install state per resolved model and says so directly rather than hiding it.
Flipping the toggle never deletes anything.

### Downloading

- HTTP with `Range` support for resume.
- Written to `<id>.bin.part`, sha256-verified on completion, then atomically
  renamed to `<id>.bin`. An unverified file is never renamed into place.
- Free disk space is checked against `bytes` before the download starts.
- Progress reports bytes, total, and rate. Cancellable; the `.part` file is kept
  so a later attempt resumes.

Checksum verification is load-bearing: a silently truncated multi-gigabyte
download otherwise surfaces as an opaque failure from inside `whisper.cpp` long
afterwards.

Models live in `app.getPath('userData')/models/`.

### Picker

Reachable from the header at any time, not only on first run. Each row shows the
model, its size, its blurb, install state, and download / select / delete
actions.

**Speed is shown from measurement, never from a shipped benchmark.** A model the
user has run displays its recorded realtime factor on this machine
("~12× realtime on your machine"). A model never run shows relative ordering
only. A single hardcoded number would be wrong on most machines.

## UI

One window, five states, no routing or tabs.

| State | Contents |
|---|---|
| **First run** | Model picker with the size / speed / accuracy tradeoff explained. Shown whenever no model is installed. While the first download runs, the drop target is visible but disabled, showing download progress and the reason it is waiting. |
| **Idle** | Full-window drop target, click-to-browse fallback, active model and language in the header. |
| **Working** | Filename, duration, phase label, progress bar, ETA, Cancel. |
| **Done** | Transcript as readable paragraphs; `Copy`, `Save .txt`, `Save .srt`, `Save .vtt`, `Transcribe another`. |
| **Error** | Plain-language message, suggested action, technical detail behind a disclosure, retry path. |

The document intercepts `dragover` and `drop` at the window level and calls
`preventDefault()`, so a dropped file never navigates the renderer away.

### Saving

Exports write next to the source file with the same basename —
`interview.mp4` → `interview.srt` — matching the `pdf-renderer` convention. A
toast confirms with a Reveal action. If a file of that name exists, the app
appends ` (2)` rather than overwriting.

No auto-save and no output-folder preference. A 15-second voice memo usually
only needs the clipboard, and one click is cheaper than a setting nobody finds.

### Options

In the header: **model**, and the **English only / All languages** toggle. The
language selector (auto-detect, or forced from a list) appears only when the
toggle is set to All languages. Everything else is in [Later](#later).

## Error handling

Every failure maps to a code, a plain-language message, and a suggested action.
Technical detail — the tail of stderr, the exit code — sits behind a "Details"
disclosure, formatted for pasting into a GitHub issue.

| Code | Shown to user |
|---|---|
| `NO_AUDIO_STREAM` | "This file doesn't contain any audio." |
| `UNREADABLE_MEDIA` | "This file couldn't be read as audio or video." |
| `NO_MODEL_INSTALLED` | "Choose a model first." → opens picker |
| `MODEL_FILE_MISSING` | "That model isn't on disk anymore." → offers re-download |
| `INSUFFICIENT_DISK_SPACE` | "Not enough free space. This model needs X GB." |
| `DOWNLOAD_CHECKSUM_MISMATCH` | "The download was corrupted." → offers retry |
| `DOWNLOAD_NETWORK_ERROR` | "Couldn't reach the model server." → offers retry |
| `WHISPER_FAILED` | "Transcription failed unexpectedly." + details |
| `FFMPEG_FAILED` | "Couldn't prepare the audio from this file." + details |

Cancellation is not an error and produces no error UI.

## Binary provisioning and build

Binaries are not committed to the repository.

**ffmpeg and ffprobe** come from the `ffmpeg-static` and `ffprobe-static` npm
packages, which already handle per-platform binary fetching. `src/main/binaries.ts`
is the only module that knows where they live.

**whisper.cpp** is built from source at a tag pinned in `whisper.manifest.json`.
`scripts/build-whisper.mjs` clones the tag, builds it **statically**
(`-DBUILD_SHARED_LIBS=OFF`, plus `-DGGML_METAL_EMBED_LIBRARY=ON` on macOS) so
the result is one self-contained executable, and copies it to
`resources/<platform>-<arch>/`. It is idempotent, keyed on the tag.
`electron-builder`'s `extraResources` packs only the matching directory.

`WHISPER_DROP_WHISPER_BIN` overrides the resolved `whisper-cli` path, for
developing against a local whisper.cpp build.

GitHub Actions runs that same build for macOS arm64, macOS x64, Windows x64, and
Linux x64, caching the result per tag and attaching it to releases. Upstream's
own prebuilt coverage is inconsistent across platforms, so owning the build is
both more reliable and more transparent about what ships.

The pinned tag must be one where the CLI is named `whisper-cli`; it was renamed
from `main` in earlier versions. The initial pin is `v1.9.2`.

## Testing

Test-first throughout.

**Unit — pure modules.** No mocking required.

- `export/formatters`: SRT 1-indexed cue numbering, `HH:MM:SS,mmm` versus
  WebVTT's `HH:MM:SS.mmm`, segments crossing the one-hour boundary, empty
  segments, text needing whitespace normalization.
- `whisper/parse`: fixture files of real `whisper-cli` stdout, including
  interleaved progress and log lines that must be ignored.
- `models/catalog`: structural assertion that every entry has a well-formed URL
  and a 64-character hex hash, and that every `ModelBaseId` has a multilingual
  entry.
- `resolveModelId`: returns the `.en` variant for `tiny`/`base`/`small` when
  English-only is on, returns the multilingual id for `large-v3-turbo` and
  `large-v3` in both modes, and round-trips unchanged when the toggle is off.

**Unit — `transcription-job`** with fake probe/extract/runner injected: phase
transitions, progress banding, ETA suppression before 10%, cancel deletes the
temp WAV, mid-job failure propagates the right `AppError`.

**Unit — `models/download`** against a local HTTP server serving a known blob:
resume from partial, checksum mismatch rejection, insufficient-space refusal,
cancellation leaving a resumable `.part`. No network access in tests.

**Integration** against real binaries and the `tiny` model, using committed
fixtures — a 3-second WAV and a 3-second MP4, both a few hundred KB. The spoken
content is a clearly enunciated known phrase, and the assertion is that the
transcript contains its distinctive words, not that it matches exactly.
CI caches the `tiny` model.

**End-to-end**, one Playwright-on-Electron smoke test: launch the app, drop the
fixture, assert a transcript renders. This guards the IPC wiring that unit tests
cannot see.

## Distribution and licensing

Our code is MIT. `whisper.cpp` is MIT.

ffmpeg static builds are generally GPL. The app invokes ffmpeg as a separate
executable over the command line rather than linking against it, which is the
standard arrangement for bundling it. Our source stays MIT, the bundled binary
retains its own license, and the app carries a Licenses screen crediting both
projects and linking to ffmpeg's source.

Release artifacts per tag: macOS DMG (arm64 and x64), Windows NSIS installer,
Linux AppImage and `.deb`.

**Nothing is code-signed in v1.** macOS users will see "Apple could not verify
this app is free of malware" and must right-click → Open the first time. The
README carries a screenshotted walkthrough of exactly that, written for a
non-technical reader. Windows users will see a SmartScreen warning and must
click "More info" → "Run anyway"; this is also documented.

The README leads with the privacy property — audio never leaves the machine, no
telemetry, works offline — because that is the reason to trust it with a client
session recording.

## Later

Deliberately out of v1, in rough priority order:

1. **Batch queue** — drop several files or a folder, process serially with
   per-file status. The most-wanted addition; the single-job architecture is
   built so the queue wraps `transcription-job` rather than replacing it.
2. **macOS notarization** — Apple Developer Program membership, Developer ID
   cert and app-specific password in CI secrets. A config change, not a
   restructure.
3. **Custom vocabulary** — pass an initial prompt so names and domain jargon
   transcribe correctly.
4. **Translate to English** — a single `whisper-cli` flag.
5. **Word-level timestamps** — enables karaoke-style export and precise editing.
6. **Speaker diarization** — requires a second model and real design work.
7. **Auto-update** — weigh against the no-network-calls promise.
8. **Windows code signing** — certificate cost plus reputation accrual; revisit
   only if clients hit friction.
