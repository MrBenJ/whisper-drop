# whisper-drop Foundation & Transcription Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless, fully tested TypeScript core that takes a media file path and a Whisper model path and produces a transcript as plain text, SRT, or WebVTT — with real progress reporting and working cancellation.

**Architecture:** Plain Node/TypeScript modules with no Electron dependency. Pure functions (timestamp conversion, stdout parsing, output formatting) carry the correctness-critical logic and are tested without mocks. Thin wrappers spawn `ffprobe`, `ffmpeg`, and `whisper-cli` as child processes. A single coordinator, `TranscriptionJob`, sequences them and is the only holder of job state; it takes its collaborators by injection so the state machine, progress banding, and cleanup are testable without spawning anything.

**Tech Stack:** TypeScript 5 (ESM, `NodeNext`), Vitest 4, Node 22, `ffmpeg-static` + `ffprobe-static`, whisper.cpp v1.9.2 built from source.

**Spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md`

## Scope

This is plan 1 of 4. It builds the spec's transcription pipeline and nothing else.

**In scope:** repo scaffold, shared types and errors, timestamp conversion, output formatters, whisper stdout parsing, binary resolution, `ffprobe` probe, `ffmpeg` extraction, `whisper-cli` runner, the job coordinator, and an end-to-end integration test against real binaries.

**Out of scope, deferred to later plans:** model catalog / download / store / settings (plan 2), Electron main process, preload, IPC and React UI (plan 3), electron-builder packaging, GitHub Actions, README and licenses screen (plan 4).

**Deliverable:** `npm test` passes a unit suite, and `npm run test:integration` transcribes a committed 3-second fixture with the `tiny` model and asserts the transcript.

## Deviations from the spec

Both are refinements, recorded here so they are not silent:

1. **ffmpeg and ffprobe come from the `ffmpeg-static` and `ffprobe-static` npm packages**, not the hand-rolled `binaries.manifest.json` the spec describes. Those packages already solve per-platform binary fetching and checksum-verified download. The spec's manifest survives, reduced to whisper.cpp only, as `whisper.manifest.json`.
2. **whisper.cpp is built from source locally** at a pinned tag via `scripts/build-whisper.mjs`. The spec has CI building it and publishing release assets; that is still the destination, and plan 4 turns this script into a cached CI job that publishes artifacts. Building locally first is what makes plan 1 testable on day one.

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **No module under `src/main/` other than `src/main/ipc/` may import `electron`.** This plan creates no `ipc/` directory, so nothing in this plan imports `electron`.
- **The only network requests the app makes are model downloads.** No telemetry, no crash reporting, no update checks. Nothing in this plan makes a network request at runtime; the build and test scripts do, and that is the boundary.
- **Cancellation is available in every phase and always cleans up** — the child process is killed and the temp WAV is deleted.
- **Every failure carries a code, a plain-language message, and optional technical detail.** The nine `ErrorCode` values are fixed by the spec and reproduced in Task 1.
- **File validity is determined by ffprobe, never by an extension allowlist.**
- **Transcription progress is real, computed from segment timestamps against known duration.** Never simulated.
- **License: MIT.** Already present at the repo root.
- **Node 22+.** ESM throughout (`"type": "module"`), TypeScript `module: NodeNext`.
- **Progress bands are fixed:** probing `0.00–0.02`, preparing `0.02–0.08`, transcribing `0.08–1.00`.
- **ETA is withheld until transcription-phase progress reaches 0.10.**

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Scripts, dependencies, Node engine floor |
| `tsconfig.json` | Strict TypeScript, ESM, NodeNext resolution |
| `vitest.config.ts` | Unit suite — fast, no binaries |
| `vitest.integration.config.ts` | Integration suite — real binaries, long timeout |
| `.gitignore` | `node_modules`, `resources/`, `.cache/`, `dist/` |
| `whisper.manifest.json` | The pinned whisper.cpp tag |
| `scripts/build-whisper.mjs` | Clone + static-build whisper.cpp into `resources/` |
| `scripts/fetch-test-model.mjs` | Download `ggml-tiny.bin` into `.cache/models/` for integration tests |
| `src/shared/types.ts` | `Segment`, `MediaInfo`, `JobPhase`, `JobState`, `ErrorCode` |
| `src/shared/errors.ts` | `AppError` class |
| `src/shared/time.ts` | `msToTimestamp`, `timestampToMs` |
| `src/main/binaries.ts` | Resolve `whisper-cli`, `ffmpeg`, `ffprobe` paths |
| `src/main/export/formatters.ts` | `Segment[]` → txt / srt / vtt |
| `src/main/whisper/parse.ts` | whisper-cli stdout → `Segment[]` |
| `src/main/media/probe.ts` | `ffprobe` → `MediaInfo` |
| `src/main/media/extract.ts` | `ffmpeg` → 16 kHz mono WAV, with progress |
| `src/main/whisper/runner.ts` | Spawn `whisper-cli`, stream segments, cancel |
| `src/main/jobs/transcription-job.ts` | Sequence the phases; the only job-state holder |
| `test/helpers/fake-child.ts` | EventEmitter stand-in for a spawned process |
| `test/fixtures/` | Committed media fixtures and captured whisper stdout |

---

### Task 1: Repo scaffold, shared types, errors, and time conversion

Sets up the toolchain and delivers the two pure functions every later task depends on. `msToTimestamp` is consumed by the SRT and VTT formatters; `timestampToMs` is consumed by the stdout parser. They are inverses, which makes them a natural pair.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/shared/types.ts`
- Create: `src/shared/errors.ts`
- Create: `src/shared/time.ts`
- Test: `test/shared/time.test.ts`
- Test: `test/shared/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `msToTimestamp(ms: number, msSeparator?: ',' | '.'): string`
  - `timestampToMs(ts: string): number`
  - `class AppError extends Error { code: ErrorCode; detail?: string }`
  - Types `Segment`, `MediaInfo`, `JobPhase`, `JobState`, `ErrorCode`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "whisper-drop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "node scripts/fetch-test-model.mjs && vitest run --config vitest.integration.config.ts",
    "setup": "node scripts/build-whisper.mjs"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

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
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
node_modules/
resources/
.cache/
dist/
out/
.DS_Store
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Write the failing tests for `time.ts`**

Create `test/shared/time.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { msToTimestamp, timestampToMs } from '../../src/shared/time.js'

describe('msToTimestamp', () => {
  it('formats zero', () => {
    expect(msToTimestamp(0)).toBe('00:00:00,000')
  })

  it('formats hours, minutes, seconds and milliseconds', () => {
    expect(msToTimestamp(3_661_500)).toBe('01:01:01,500')
  })

  it('crosses the one-hour boundary correctly', () => {
    expect(msToTimestamp(3_600_000)).toBe('01:00:00,000')
    expect(msToTimestamp(3_599_999)).toBe('00:59:59,999')
  })

  it('uses a period separator when asked, for WebVTT', () => {
    expect(msToTimestamp(3_661_500, '.')).toBe('01:01:01.500')
  })

  it('pads milliseconds to three digits', () => {
    expect(msToTimestamp(1_007)).toBe('00:00:01,007')
  })

  it('rounds fractional milliseconds', () => {
    expect(msToTimestamp(1_500.6)).toBe('00:00:01,501')
  })

  it('handles durations beyond 99 hours without truncating', () => {
    expect(msToTimestamp(360_000_000)).toBe('100:00:00,000')
  })

  it('rejects negative and non-finite input', () => {
    expect(() => msToTimestamp(-1)).toThrow(RangeError)
    expect(() => msToTimestamp(Number.NaN)).toThrow(RangeError)
    expect(() => msToTimestamp(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('timestampToMs', () => {
  it('parses a comma-separated timestamp', () => {
    expect(timestampToMs('01:01:01,500')).toBe(3_661_500)
  })

  it('parses a period-separated timestamp', () => {
    expect(timestampToMs('01:01:01.500')).toBe(3_661_500)
  })

  it('parses zero', () => {
    expect(timestampToMs('00:00:00.000')).toBe(0)
  })

  it('parses hour values above two digits', () => {
    expect(timestampToMs('100:00:00.000')).toBe(360_000_000)
  })

  it('round-trips with msToTimestamp', () => {
    for (const ms of [0, 1, 999, 1_000, 59_999, 3_600_000, 3_661_500]) {
      expect(timestampToMs(msToTimestamp(ms))).toBe(ms)
    }
  })

  it('rejects malformed input', () => {
    expect(() => timestampToMs('nope')).toThrow(RangeError)
    expect(() => timestampToMs('00:00.000')).toThrow(RangeError)
    expect(() => timestampToMs('00:00:00')).toThrow(RangeError)
  })
})
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run test/shared/time.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/time.js`.

- [ ] **Step 8: Implement `src/shared/time.ts`**

```ts
const TIMESTAMP = /^(\d+):([0-5]\d):([0-5]\d)[.,](\d{3})$/

/**
 * Format milliseconds as `HH:MM:SS,mmm`.
 *
 * SRT uses a comma before the milliseconds; WebVTT uses a period. Hours are
 * zero-padded to two digits but never truncated, so a 100-hour input still
 * round-trips.
 */
export function msToTimestamp(ms: number, msSeparator: ',' | '.' = ','): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`msToTimestamp: expected a non-negative finite number, received ${ms}`)
  }

  const total = Math.round(ms)
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const millis = total % 1_000

  const pad = (value: number, width = 2) => String(value).padStart(width, '0')

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`
}

/** Parse `HH:MM:SS,mmm` or `HH:MM:SS.mmm` into milliseconds. */
export function timestampToMs(ts: string): number {
  const match = TIMESTAMP.exec(ts.trim())
  if (!match) {
    throw new RangeError(`timestampToMs: malformed timestamp ${JSON.stringify(ts)}`)
  }

  const [, hours, minutes, seconds, millis] = match as unknown as [string, string, string, string, string]

  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000 +
    Number(millis)
  )
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/shared/time.test.ts`
Expected: PASS.

- [ ] **Step 10: Create `src/shared/types.ts`**

```ts
/** One transcribed span of audio. `index` is 0-based; SRT adds 1 at format time. */
export type Segment = {
  index: number
  startMs: number
  endMs: number
  text: string
}

/** What `ffprobe` tells us about a dropped file. */
export type MediaInfo = {
  path: string
  durationMs: number
  hasAudio: boolean
  container: string
}

export type JobPhase =
  | 'probing'
  | 'preparing'
  | 'transcribing'
  | 'done'
  | 'cancelled'
  | 'failed'

export type ErrorCode =
  | 'NO_AUDIO_STREAM'
  | 'UNREADABLE_MEDIA'
  | 'NO_MODEL_INSTALLED'
  | 'MODEL_FILE_MISSING'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'DOWNLOAD_CHECKSUM_MISMATCH'
  | 'DOWNLOAD_NETWORK_ERROR'
  | 'WHISPER_FAILED'
  | 'FFMPEG_FAILED'

/** Serialisable snapshot of a job, safe to send across IPC in plan 3. */
export type JobState = {
  id: string
  filePath: string
  media?: MediaInfo
  phase: JobPhase
  /** 0..1 spanning every phase. */
  progress: number
  etaMs?: number
  segments: Segment[]
  /** durationMs / transcribeElapsedMs. Present only once the phase is `done`. */
  realtimeFactor?: number
  error?: { code: ErrorCode; message: string; detail?: string }
}

export type Unsubscribe = () => void
```

- [ ] **Step 11: Write the failing test for `errors.ts`**

Create `test/shared/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/shared/errors.js'

describe('AppError', () => {
  it('is an Error', () => {
    expect(new AppError('WHISPER_FAILED', 'boom')).toBeInstanceOf(Error)
  })

  it('carries a code, a message and optional detail', () => {
    const error = new AppError('FFMPEG_FAILED', "Couldn't prepare the audio.", 'exit 1')
    expect(error.code).toBe('FFMPEG_FAILED')
    expect(error.message).toBe("Couldn't prepare the audio.")
    expect(error.detail).toBe('exit 1')
  })

  it('omits detail when not supplied', () => {
    expect(new AppError('NO_AUDIO_STREAM', 'no audio').detail).toBeUndefined()
  })

  it('serialises to the JobState error shape', () => {
    const error = new AppError('UNREADABLE_MEDIA', 'unreadable', 'stderr tail')
    expect(error.toJSON()).toEqual({
      code: 'UNREADABLE_MEDIA',
      message: 'unreadable',
      detail: 'stderr tail',
    })
  })

  it('sets name to AppError so stack traces are legible', () => {
    expect(new AppError('WHISPER_FAILED', 'boom').name).toBe('AppError')
  })
})
```

- [ ] **Step 12: Run the test to verify it fails**

Run: `npx vitest run test/shared/errors.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/errors.js`.

- [ ] **Step 13: Implement `src/shared/errors.ts`**

```ts
import type { ErrorCode } from './types.js'

/**
 * Every failure the user can see. `message` is plain language shown directly in
 * the UI; `detail` is technical output shown behind a disclosure and formatted
 * for pasting into a GitHub issue.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail?: string

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }

  toJSON(): { code: ErrorCode; message: string; detail?: string } {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}
```

- [ ] **Step 14: Run the full suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 15: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src test
git commit -m "feat: scaffold repo with shared types, errors and timestamp conversion"
```

---

### Task 2: Output formatters

The pure module that turns segments into the three file formats the spec promises. This is where the fiddly correctness lives — SRT's 1-indexed cue numbering, the comma-versus-period separator, and dropping blank segments without leaving gaps in the numbering.

**Files:**
- Create: `src/main/export/formatters.ts`
- Test: `test/main/export/formatters.test.ts`

**Interfaces:**
- Consumes: `Segment` from `src/shared/types.ts`; `msToTimestamp` from `src/shared/time.ts`.
- Produces:
  - `toTxt(segments: Segment[]): string`
  - `toSrt(segments: Segment[]): string`
  - `toVtt(segments: Segment[]): string`
  - `type ExportFormat = 'txt' | 'srt' | 'vtt'`
  - `format(segments: Segment[], as: ExportFormat): string`

- [ ] **Step 1: Write the failing tests**

Create `test/main/export/formatters.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { format, toSrt, toTxt, toVtt } from '../../../src/main/export/formatters.js'
import type { Segment } from '../../../src/shared/types.js'

const seg = (index: number, startMs: number, endMs: number, text: string): Segment => ({
  index,
  startMs,
  endMs,
  text,
})

const SAMPLE: Segment[] = [
  seg(0, 0, 2_000, 'Hello there.'),
  seg(1, 2_000, 4_500, 'This is a test.'),
]

describe('toTxt', () => {
  it('writes one trimmed segment per line with a trailing newline', () => {
    expect(toTxt(SAMPLE)).toBe('Hello there.\nThis is a test.\n')
  })

  it('returns an empty string for no segments', () => {
    expect(toTxt([])).toBe('')
  })

  it('drops blank and whitespace-only segments', () => {
    const segments = [seg(0, 0, 1_000, 'Kept.'), seg(1, 1_000, 2_000, '   '), seg(2, 2_000, 3_000, 'Also kept.')]
    expect(toTxt(segments)).toBe('Kept.\nAlso kept.\n')
  })

  it('collapses internal whitespace and newlines into single spaces', () => {
    expect(toTxt([seg(0, 0, 1_000, '  Hello\n  there  ')])).toBe('Hello there\n')
  })
})

describe('toSrt', () => {
  it('numbers cues from 1 and separates them with a blank line', () => {
    expect(toSrt(SAMPLE)).toBe(
      '1\n' +
        '00:00:00,000 --> 00:00:02,000\n' +
        'Hello there.\n' +
        '\n' +
        '2\n' +
        '00:00:02,000 --> 00:00:04,500\n' +
        'This is a test.\n',
    )
  })

  it('returns an empty string for no segments', () => {
    expect(toSrt([])).toBe('')
  })

  it('keeps cue numbering contiguous when blank segments are dropped', () => {
    const segments = [seg(0, 0, 1_000, 'One.'), seg(1, 1_000, 2_000, ''), seg(2, 2_000, 3_000, 'Two.')]
    const output = toSrt(segments)
    expect(output).toContain('1\n00:00:00,000 --> 00:00:01,000\nOne.')
    expect(output).toContain('2\n00:00:02,000 --> 00:00:03,000\nTwo.')
    expect(output).not.toContain('3')
  })

  it('uses commas before milliseconds', () => {
    expect(toSrt(SAMPLE)).toContain('00:00:00,000 --> 00:00:02,000')
    expect(toSrt(SAMPLE)).not.toContain('00:00:00.000')
  })

  it('formats segments that cross the one-hour boundary', () => {
    expect(toSrt([seg(0, 3_599_500, 3_600_500, 'Late.')])).toContain(
      '00:59:59,500 --> 01:00:00,500',
    )
  })

  it('ignores the incoming index and renumbers from the emitted order', () => {
    expect(toSrt([seg(41, 0, 1_000, 'Only.')]).startsWith('1\n')).toBe(true)
  })
})

describe('toVtt', () => {
  it('starts with the WEBVTT header followed by a blank line', () => {
    expect(toVtt(SAMPLE).startsWith('WEBVTT\n\n')).toBe(true)
  })

  it('uses periods before milliseconds', () => {
    expect(toVtt(SAMPLE)).toContain('00:00:00.000 --> 00:00:02.000')
    expect(toVtt(SAMPLE)).not.toContain('00:00:00,000')
  })

  it('emits the header even with no segments, so the file stays valid', () => {
    expect(toVtt([])).toBe('WEBVTT\n\n')
  })

  it('does not number cues', () => {
    expect(toVtt(SAMPLE)).not.toMatch(/^\d+$/m)
  })
})

describe('format', () => {
  it('dispatches to each formatter', () => {
    expect(format(SAMPLE, 'txt')).toBe(toTxt(SAMPLE))
    expect(format(SAMPLE, 'srt')).toBe(toSrt(SAMPLE))
    expect(format(SAMPLE, 'vtt')).toBe(toVtt(SAMPLE))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/export/formatters.test.ts`
Expected: FAIL — cannot resolve `formatters.js`.

- [ ] **Step 3: Implement `src/main/export/formatters.ts`**

```ts
import { msToTimestamp } from '../../shared/time.js'
import type { Segment } from '../../shared/types.js'

export type ExportFormat = 'txt' | 'srt' | 'vtt'

/** Trim and collapse internal whitespace so wrapped output reads as one line. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Drop segments with no words. Whisper emits these around silence, and they
 * would otherwise become empty cues and gaps in the SRT numbering.
 */
function meaningful(segments: Segment[]): { startMs: number; endMs: number; text: string }[] {
  return segments
    .map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: normalise(segment.text) }))
    .filter((segment) => segment.text.length > 0)
}

export function toTxt(segments: Segment[]): string {
  const lines = meaningful(segments).map((segment) => segment.text)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

export function toSrt(segments: Segment[]): string {
  const cues = meaningful(segments)
  if (cues.length === 0) return ''

  return cues
    .map((cue, i) => {
      const start = msToTimestamp(cue.startMs, ',')
      const end = msToTimestamp(cue.endMs, ',')
      return `${i + 1}\n${start} --> ${end}\n${cue.text}\n`
    })
    .join('\n')
}

export function toVtt(segments: Segment[]): string {
  const cues = meaningful(segments)
  const body = cues
    .map((cue) => {
      const start = msToTimestamp(cue.startMs, '.')
      const end = msToTimestamp(cue.endMs, '.')
      return `${start} --> ${end}\n${cue.text}\n`
    })
    .join('\n')

  return `WEBVTT\n\n${body}`
}

export function format(segments: Segment[], as: ExportFormat): string {
  switch (as) {
    case 'txt':
      return toTxt(segments)
    case 'srt':
      return toSrt(segments)
    case 'vtt':
      return toVtt(segments)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/export/formatters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/export/formatters.ts test/main/export/formatters.test.ts
git commit -m "feat: add txt, srt and vtt formatters"
```

---

### Task 3: whisper-cli stdout parser

whisper-cli interleaves segment lines with model-loading and system-info logging on stdout and stderr. This module extracts only the segments. `parseSegmentLine` works on a single line so the runner in Task 7 can call it as output streams in; `parseSegments` is the whole-buffer convenience used in tests.

**Files:**
- Create: `src/main/whisper/parse.ts`
- Create: `test/fixtures/whisper-stdout.txt`
- Test: `test/main/whisper/parse.test.ts`

**Interfaces:**
- Consumes: `timestampToMs` from `src/shared/time.ts`; `Segment` from `src/shared/types.ts`.
- Produces:
  - `parseSegmentLine(line: string): { startMs: number; endMs: number; text: string } | null`
  - `parseSegments(stdout: string): Segment[]`

- [ ] **Step 1: Create the stdout fixture**

Create `test/fixtures/whisper-stdout.txt` with exactly this content — it reproduces the shape of real whisper-cli output, including the log lines that must be ignored:

```
whisper_init_from_file_with_params_no_state: loading model from 'models/ggml-tiny.bin'
whisper_model_load: loading model
whisper_model_load: n_vocab       = 51865
whisper_model_load: model ctx     =   73.62 MB
whisper_init_state: kv self size  =    5.25 MB

system_info: n_threads = 4 / 10 | AVX = 0 | METAL = 1 |

main: processing 'audio.wav' (48000 samples, 3.0 sec), 4 threads, 1 processors, lang = en, task = transcribe, timestamps = 1

[00:00:00.000 --> 00:00:02.000]   Testing one two
[00:00:02.000 --> 00:00:03.000]   three four.
[00:00:03.000 --> 00:00:04.000]  

whisper_print_timings:     load time =   120.00 ms
whisper_print_timings:    total time =   980.00 ms
```

- [ ] **Step 2: Write the failing tests**

Create `test/main/whisper/parse.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSegmentLine, parseSegments } from '../../../src/main/whisper/parse.js'

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/whisper-stdout.txt', import.meta.url)),
  'utf8',
)

describe('parseSegmentLine', () => {
  it('parses a segment line into milliseconds and text', () => {
    expect(parseSegmentLine('[00:00:00.000 --> 00:00:02.000]   Testing one two')).toEqual({
      startMs: 0,
      endMs: 2_000,
      text: 'Testing one two',
    })
  })

  it('accepts comma-separated milliseconds', () => {
    expect(parseSegmentLine('[00:00:01,500 --> 00:00:02,500]  Hi.')).toEqual({
      startMs: 1_500,
      endMs: 2_500,
      text: 'Hi.',
    })
  })

  it('parses timestamps past one hour', () => {
    const parsed = parseSegmentLine('[01:02:03.004 --> 01:02:04.005]  Late.')
    expect(parsed?.startMs).toBe(3_723_004)
    expect(parsed?.endMs).toBe(3_724_005)
  })

  it('returns an empty string for a segment with no words', () => {
    expect(parseSegmentLine('[00:00:03.000 --> 00:00:04.000]  ')?.text).toBe('')
  })

  it('tolerates leading and trailing whitespace on the line', () => {
    expect(parseSegmentLine('  [00:00:00.000 --> 00:00:01.000]  Hi.  ')?.text).toBe('Hi.')
  })

  it('returns null for log lines', () => {
    expect(parseSegmentLine('whisper_model_load: loading model')).toBeNull()
    expect(parseSegmentLine('system_info: n_threads = 4 / 10 | METAL = 1 |')).toBeNull()
    expect(parseSegmentLine('')).toBeNull()
  })

  it('returns null for a line that looks close but is malformed', () => {
    expect(parseSegmentLine('[00:00 --> 00:01] nope')).toBeNull()
    expect(parseSegmentLine('[00:00:00.000 00:00:01.000] nope')).toBeNull()
  })
})

describe('parseSegments', () => {
  it('extracts only the segment lines from real output', () => {
    const segments = parseSegments(FIXTURE)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ index: 0, startMs: 0, endMs: 2_000, text: 'Testing one two' })
    expect(segments[1]).toEqual({ index: 1, startMs: 2_000, endMs: 3_000, text: 'three four.' })
  })

  it('assigns sequential zero-based indices', () => {
    expect(parseSegments(FIXTURE).map((s) => s.index)).toEqual([0, 1, 2])
  })

  it('keeps empty-text segments so timing stays intact for the caller', () => {
    expect(parseSegments(FIXTURE)[2]).toEqual({
      index: 2,
      startMs: 3_000,
      endMs: 4_000,
      text: '',
    })
  })

  it('handles CRLF line endings', () => {
    const crlf = '[00:00:00.000 --> 00:00:01.000]  Hi.\r\nwhisper: done\r\n'
    expect(parseSegments(crlf)).toEqual([{ index: 0, startMs: 0, endMs: 1_000, text: 'Hi.' }])
  })

  it('returns an empty array when there are no segments', () => {
    expect(parseSegments('whisper_model_load: loading model\n')).toEqual([])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/main/whisper/parse.test.ts`
Expected: FAIL — cannot resolve `parse.js`.

- [ ] **Step 4: Implement `src/main/whisper/parse.ts`**

```ts
import { timestampToMs } from '../../shared/time.js'
import type { Segment } from '../../shared/types.js'

/**
 * A whisper-cli segment line, e.g.
 *   [00:00:00.000 --> 00:00:02.000]   Testing one two
 * Everything else on stdout is model-loading and timing logging.
 */
const SEGMENT_LINE = /^\[(\d+:[0-5]\d:[0-5]\d[.,]\d{3})\s*-->\s*(\d+:[0-5]\d:[0-5]\d[.,]\d{3})\]\s?(.*)$/

export type ParsedSegment = { startMs: number; endMs: number; text: string }

/** Parse one line of whisper-cli stdout. Returns null for anything else. */
export function parseSegmentLine(line: string): ParsedSegment | null {
  const match = SEGMENT_LINE.exec(line.trim())
  if (!match) return null

  const [, start, end, text] = match as unknown as [string, string, string, string]

  return {
    startMs: timestampToMs(start),
    endMs: timestampToMs(end),
    text: text.trim(),
  }
}

/**
 * Parse a whole stdout buffer. Empty-text segments are kept: the runner uses
 * their end timestamps for progress, and the formatters drop them at the end.
 */
export function parseSegments(stdout: string): Segment[] {
  const segments: Segment[] = []

  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parseSegmentLine(line)
    if (parsed) segments.push({ index: segments.length, ...parsed })
  }

  return segments
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/main/whisper/parse.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/whisper/parse.ts test/main/whisper/parse.test.ts test/fixtures/whisper-stdout.txt
git commit -m "feat: parse whisper-cli stdout into segments"
```

---

### Task 4: Binary provisioning and path resolution

Builds whisper.cpp from source at a pinned tag and gives every later task one place to ask where the three executables are.

The build is **static** (`-DBUILD_SHARED_LIBS=OFF`) so the result is a single self-contained `whisper-cli` — a dynamically linked build would need its `libwhisper` and `libggml` shared objects copied alongside it, and would break the moment the cache directory was cleaned.

**Prerequisites:** `git` and `cmake` on PATH, plus a C++ toolchain (Xcode Command Line Tools on macOS). Verify with `cmake --version` before starting.

**Files:**
- Create: `whisper.manifest.json`
- Create: `scripts/build-whisper.mjs`
- Create: `src/main/binaries.ts`
- Test: `test/main/binaries.test.ts`
- Modify: `package.json` — add `ffmpeg-static` and `ffprobe-static` dependencies

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `whisperCliPath(): string`
  - `ffmpegPath(): string`
  - `ffprobePath(): string`
  - `resourcesDir(): string`

- [ ] **Step 1: Create `whisper.manifest.json`**

```json
{
  "whisperCppRepo": "https://github.com/ggml-org/whisper.cpp.git",
  "whisperCppTag": "v1.9.2"
}
```

`v1.9.2` was the latest tag when this plan was written. To move it, run
`git ls-remote --tags --refs https://github.com/ggml-org/whisper.cpp.git | tail`
and edit this file; the build script keys its cache on the tag, so changing it
triggers a rebuild automatically.

- [ ] **Step 2: Create `scripts/build-whisper.mjs`**

```js
#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { whisperCppRepo, whisperCppTag } = JSON.parse(
  readFileSync(join(ROOT, 'whisper.manifest.json'), 'utf8'),
)

const target = `${process.platform}-${process.arch}`
const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
const outDir = join(ROOT, 'resources', target)
const outBin = join(outDir, exe)
const stamp = join(outDir, '.tag')

if (existsSync(outBin) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === whisperCppTag) {
  console.log(`whisper-cli ${whisperCppTag} already built for ${target}`)
  process.exit(0)
}

const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

const src = join(ROOT, '.cache', 'whisper.cpp')
if (existsSync(join(src, '.git'))) {
  run('git', ['fetch', '--depth', '1', 'origin', 'tag', whisperCppTag, '--no-tags'], src)
  run('git', ['checkout', '--force', whisperCppTag], src)
} else {
  mkdirSync(dirname(src), { recursive: true })
  run('git', ['clone', '--depth', '1', '--branch', whisperCppTag, whisperCppRepo, src])
}

const cmakeArgs = [
  '-B', 'build',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=OFF',
]
if (process.platform === 'darwin') cmakeArgs.push('-DGGML_METAL_EMBED_LIBRARY=ON')

run('cmake', cmakeArgs, src)
run('cmake', ['--build', 'build', '--config', 'Release', '-j'], src)

const candidates = [
  join(src, 'build', 'bin', exe),
  join(src, 'build', 'bin', 'Release', exe),
]
const built = candidates.find((p) => existsSync(p))
if (!built) {
  console.error(`Could not find a built whisper-cli. Looked in:\n  ${candidates.join('\n  ')}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
copyFileSync(built, outBin)
writeFileSync(stamp, `${whisperCppTag}\n`)
console.log(`Built whisper-cli ${whisperCppTag} -> ${outBin}`)
```

- [ ] **Step 3: Add the media binary dependencies**

Run: `npm install ffmpeg-static ffprobe-static`
Expected: both added to `dependencies` in `package.json`.

- [ ] **Step 4: Build whisper.cpp**

Run: `npm run setup`
Expected: a `resources/<platform>-<arch>/whisper-cli` binary. First run clones and compiles and takes several minutes; a second run prints "already built" and exits immediately.

- [ ] **Step 5: Verify the binary is self-contained and runs**

Run: `./resources/$(node -p "process.platform+'-'+process.arch")/whisper-cli --help | head -5`
Expected: whisper-cli usage text, no dynamic-library errors.

- [ ] **Step 6: Write the failing test**

Create `test/main/binaries.test.ts`:

```ts
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ffmpegPath, ffprobePath, whisperCliPath } from '../../src/main/binaries.js'

const ORIGINAL = process.env.WHISPER_DROP_WHISPER_BIN

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WHISPER_DROP_WHISPER_BIN
  else process.env.WHISPER_DROP_WHISPER_BIN = ORIGINAL
})

describe('whisperCliPath', () => {
  it('honours the WHISPER_DROP_WHISPER_BIN override', () => {
    process.env.WHISPER_DROP_WHISPER_BIN = '/custom/whisper-cli'
    expect(whisperCliPath()).toBe('/custom/whisper-cli')
  })

  it('resolves to a file that exists once npm run setup has been run', () => {
    delete process.env.WHISPER_DROP_WHISPER_BIN
    expect(existsSync(whisperCliPath())).toBe(true)
  })

  it('includes the platform and architecture in the resolved path', () => {
    delete process.env.WHISPER_DROP_WHISPER_BIN
    expect(whisperCliPath()).toContain(`${process.platform}-${process.arch}`)
  })
})

describe('media binaries', () => {
  it('resolves ffmpeg to a file that exists', () => {
    expect(existsSync(ffmpegPath())).toBe(true)
  })

  it('resolves ffprobe to a file that exists', () => {
    expect(existsSync(ffprobePath())).toBe(true)
  })
})
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run test/main/binaries.test.ts`
Expected: FAIL — cannot resolve `binaries.js`.

- [ ] **Step 8: Implement `src/main/binaries.ts`**

```ts
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where the platform-matched whisper-cli lives.
 *
 * In a packaged Electron app (plan 4) `process.resourcesPath` is set and the
 * binary is unpacked beside the app. In development it sits under the repo's
 * `resources/` directory, built by `npm run setup`.
 */
export function resourcesDir(): string {
  const target = `${process.platform}-${process.arch}`

  // `resourcesPath` is added by Electron at runtime and is absent from
  // @types/node, so it is read defensively rather than declared.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resourcesPath ? join(resourcesPath, 'resources', target) : undefined

  if (packaged && existsSync(packaged)) return packaged

  return join(HERE, '..', '..', 'resources', target)
}

export function whisperCliPath(): string {
  const override = process.env.WHISPER_DROP_WHISPER_BIN
  if (override) return override

  return join(resourcesDir(), process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
}

export function ffmpegPath(): string {
  if (!ffmpegStatic) throw new Error('ffmpeg-static did not resolve a binary for this platform')
  return ffmpegStatic
}

export function ffprobePath(): string {
  return ffprobeStatic.path
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run test/main/binaries.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add whisper.manifest.json scripts/build-whisper.mjs src/main/binaries.ts test/main/binaries.test.ts package.json package-lock.json
git commit -m "feat: build whisper.cpp from a pinned tag and resolve binary paths"
```

---

### Task 5: ffprobe media probe

Answers two questions about a dropped file: how long is it, and does it contain audio. This is also the file-validity check — if ffprobe cannot read it, the app rejects it, which is why there is no extension allowlist anywhere in the codebase.

**Files:**
- Create: `src/main/media/probe.ts`
- Test: `test/main/media/probe.test.ts`

**Interfaces:**
- Consumes: `ffprobePath` from `src/main/binaries.ts`; `MediaInfo` from `src/shared/types.ts`; `AppError` from `src/shared/errors.ts`.
- Produces:
  - `type ProbeDeps = { ffprobePath?: string; execFile?: ExecFileFn }`
  - `type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>`
  - `probe(filePath: string, deps?: ProbeDeps): Promise<MediaInfo>`

- [ ] **Step 1: Write the failing tests**

Create `test/main/media/probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { probe } from '../../../src/main/media/probe.js'
import { AppError } from '../../../src/shared/errors.js'

const withAudio = JSON.stringify({
  format: { duration: '92.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
})

const videoOnly = JSON.stringify({
  format: { duration: '10.0', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [{ codec_type: 'video' }],
})

const fakeExec = (stdout: string) => async () => ({ stdout, stderr: '' })

describe('probe', () => {
  it('returns duration in milliseconds', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(withAudio) })
    expect(info.durationMs).toBe(92_500)
  })

  it('reports the presence of an audio stream', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(withAudio) })
    expect(info.hasAudio).toBe(true)
  })

  it('reports the absence of an audio stream without throwing', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(videoOnly) })
    expect(info.hasAudio).toBe(false)
  })

  it('returns the container name and the original path', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(withAudio) })
    expect(info.container).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    expect(info.path).toBe('/tmp/a.mp4')
  })

  it('rounds fractional milliseconds', async () => {
    const stdout = JSON.stringify({
      format: { duration: '3.0007', format_name: 'wav' },
      streams: [{ codec_type: 'audio' }],
    })
    expect((await probe('/tmp/a.wav', { execFile: fakeExec(stdout) })).durationMs).toBe(3_001)
  })

  it('throws UNREADABLE_MEDIA when ffprobe exits non-zero', async () => {
    const execFile = async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Invalid data found' })
    }
    await expect(probe('/tmp/nope.txt', { execFile })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
      detail: expect.stringContaining('Invalid data found'),
    })
  })

  it('throws UNREADABLE_MEDIA when ffprobe emits unparseable output', async () => {
    await expect(probe('/tmp/a.mp4', { execFile: fakeExec('not json') })).rejects.toBeInstanceOf(AppError)
  })

  it('throws UNREADABLE_MEDIA when the duration is missing', async () => {
    const stdout = JSON.stringify({ format: { format_name: 'wav' }, streams: [{ codec_type: 'audio' }] })
    await expect(probe('/tmp/a.wav', { execFile: fakeExec(stdout) })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
    })
  })

  it('passes the expected arguments to ffprobe', async () => {
    let captured: string[] = []
    const execFile = async (_file: string, args: string[]) => {
      captured = args
      return { stdout: withAudio, stderr: '' }
    }
    await probe('/tmp/a.mp4', { execFile })
    expect(captured).toEqual([
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/tmp/a.mp4',
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/media/probe.test.ts`
Expected: FAIL — cannot resolve `probe.js`.

- [ ] **Step 3: Implement `src/main/media/probe.ts`**

```ts
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { ffprobePath as defaultFfprobePath } from '../binaries.js'
import { AppError } from '../../shared/errors.js'
import type { MediaInfo } from '../../shared/types.js'

const execFileAsync = promisify(execFileCb)

export type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

export type ProbeDeps = {
  ffprobePath?: string
  execFile?: ExecFileFn
}

function unreadable(path: string, detail: string): AppError {
  return new AppError(
    'UNREADABLE_MEDIA',
    "This file couldn't be read as audio or video.",
    `${path}\n${detail}`,
  )
}

/**
 * Ask ffprobe what this file is. Also serves as the file-validity check: if
 * ffprobe cannot read it, we reject it. There is deliberately no extension
 * allowlist anywhere in the codebase.
 */
export async function probe(filePath: string, deps: ProbeDeps = {}): Promise<MediaInfo> {
  const exec = deps.execFile ?? ((file, args) => execFileAsync(file, args))
  const binary = deps.ffprobePath ?? defaultFfprobePath()

  let stdout: string
  try {
    ;({ stdout } = await exec(binary, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]))
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? String(cause)
    throw unreadable(filePath, stderr)
  }

  let parsed: {
    format?: { duration?: string; format_name?: string }
    streams?: { codec_type?: string }[]
  }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw unreadable(filePath, `ffprobe returned unparseable output:\n${stdout.slice(0, 500)}`)
  }

  const durationSeconds = Number(parsed.format?.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw unreadable(filePath, `ffprobe reported no usable duration: ${parsed.format?.duration}`)
  }

  return {
    path: filePath,
    durationMs: Math.round(durationSeconds * 1_000),
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio'),
    container: parsed.format?.format_name ?? 'unknown',
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/media/probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/media/probe.ts test/main/media/probe.test.ts
git commit -m "feat: probe media files with ffprobe"
```

---

### Task 6: ffmpeg audio extraction

Converts anything ffmpeg can read into the 16 kHz mono signed-16-bit WAV that whisper.cpp requires, reporting progress and honouring cancellation.

This task also creates the fake child-process helper that Task 7 reuses.

**Files:**
- Create: `test/helpers/fake-child.ts`
- Create: `src/main/media/extract.ts`
- Test: `test/main/media/extract.test.ts`

**Interfaces:**
- Consumes: `ffmpegPath` from `src/main/binaries.ts`; `AppError` from `src/shared/errors.ts`.
- Produces:
  - `type SpawnFn = (file: string, args: string[]) => FakeableChild`
  - `type ExtractDeps = { ffmpegPath?: string; spawn?: SpawnFn }`
  - `extractWav(options: ExtractOptions, deps?: ExtractDeps): Promise<void>` where
    `ExtractOptions = { inputPath: string; outputPath: string; durationMs: number; onProgress?: (fraction: number) => void; signal?: AbortSignal }`
  - Test helper: `createFakeChild()` returning `{ child, emitStdout, emitStderr, exit, killed }`

- [ ] **Step 1: Create the fake child helper**

Create `test/helpers/fake-child.ts`:

```ts
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export type FakeChild = {
  /** Pass this where a ChildProcess is expected. */
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean }
  emitStdout: (chunk: string) => void
  emitStderr: (chunk: string) => void
  /** Close the streams and emit `close` with the given exit code. */
  exit: (code: number) => void
  /** Signals passed to kill(), in call order. */
  killSignals: string[]
}

export function createFakeChild(): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const killSignals: string[] = []

  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: (signal = 'SIGTERM') => {
      killSignals.push(signal)
      return true
    },
  })

  return {
    child,
    emitStdout: (chunk) => stdout.write(chunk),
    emitStderr: (chunk) => stderr.write(chunk),
    exit: (code) => {
      stdout.end()
      stderr.end()
      // Let stream consumers drain before the close handler runs.
      setImmediate(() => child.emit('close', code))
    },
    killSignals,
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/main/media/extract.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { extractWav } from '../../../src/main/media/extract.js'
import { createFakeChild } from '../../helpers/fake-child.js'

const OPTIONS = { inputPath: '/tmp/in.mp4', outputPath: '/tmp/out.wav', durationMs: 10_000 }

describe('extractWav', () => {
  it('resolves when ffmpeg exits zero', async () => {
    const fake = createFakeChild()
    const promise = extractWav(OPTIONS, { spawn: () => fake.child })
    fake.exit(0)
    await expect(promise).resolves.toBeUndefined()
  })

  it('reports progress from ffmpeg out_time_us lines', async () => {
    const fake = createFakeChild()
    const onProgress = vi.fn()
    const promise = extractWav({ ...OPTIONS, onProgress }, { spawn: () => fake.child })

    fake.emitStdout('frame=1\nout_time_us=2500000\nprogress=continue\n')
    fake.emitStdout('out_time_us=5000000\nprogress=continue\n')
    fake.exit(0)
    await promise

    expect(onProgress).toHaveBeenCalledWith(0.25)
    expect(onProgress).toHaveBeenCalledWith(0.5)
  })

  it('clamps progress to 1 when ffmpeg overshoots the probed duration', async () => {
    const fake = createFakeChild()
    const onProgress = vi.fn()
    const promise = extractWav({ ...OPTIONS, onProgress }, { spawn: () => fake.child })

    fake.emitStdout('out_time_us=99000000\n')
    fake.exit(0)
    await promise

    expect(onProgress).toHaveBeenLastCalledWith(1)
  })

  it('does not divide by zero when the duration is zero', async () => {
    const fake = createFakeChild()
    const onProgress = vi.fn()
    const promise = extractWav({ ...OPTIONS, durationMs: 0, onProgress }, { spawn: () => fake.child })

    fake.emitStdout('out_time_us=1000000\n')
    fake.exit(0)
    await promise

    expect(onProgress).toHaveBeenLastCalledWith(1)
  })

  it('throws FFMPEG_FAILED with the stderr tail on a non-zero exit', async () => {
    const fake = createFakeChild()
    const promise = extractWav(OPTIONS, { spawn: () => fake.child })

    fake.emitStderr('Invalid data found when processing input\n')
    fake.exit(1)

    await expect(promise).rejects.toMatchObject({
      code: 'FFMPEG_FAILED',
      detail: expect.stringContaining('Invalid data found'),
    })
  })

  it('kills the process when the signal aborts', async () => {
    const controller = new AbortController()
    const fake = createFakeChild()
    const promise = extractWav({ ...OPTIONS, signal: controller.signal }, { spawn: () => fake.child })

    controller.abort()
    fake.exit(143)

    await expect(promise).rejects.toThrow(/abort/i)
    expect(fake.killSignals).toContain('SIGKILL')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()

    await expect(
      extractWav({ ...OPTIONS, signal: controller.signal }, { spawn }),
    ).rejects.toThrow(/abort/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('asks ffmpeg for 16 kHz mono pcm_s16le with machine-readable progress', async () => {
    let captured: string[] = []
    const fake = createFakeChild()
    const promise = extractWav(OPTIONS, {
      spawn: (_file, args) => {
        captured = args
        return fake.child
      },
    })
    fake.exit(0)
    await promise

    expect(captured).toEqual([
      '-nostdin',
      '-loglevel', 'error',
      '-i', '/tmp/in.mp4',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      '-progress', 'pipe:1',
      '-y',
      '/tmp/out.wav',
    ])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/main/media/extract.test.ts`
Expected: FAIL — cannot resolve `extract.js`.

- [ ] **Step 4: Implement `src/main/media/extract.ts`**

```ts
import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { ffmpegPath as defaultFfmpegPath } from '../binaries.js'
import { AppError } from '../../shared/errors.js'

/** The subset of ChildProcess this module uses, so tests can supply a stand-in. */
export type SpawnedProcess = EventEmitter & {
  stdout: Readable
  stderr: Readable
  kill: (signal?: string) => boolean
}

export type SpawnFn = (file: string, args: string[]) => SpawnedProcess

export type ExtractDeps = {
  ffmpegPath?: string
  spawn?: SpawnFn
}

export type ExtractOptions = {
  inputPath: string
  outputPath: string
  /** From the probe. Used to turn ffmpeg's out_time_us into a fraction. */
  durationMs: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** How much stderr to keep for the error detail. */
const STDERR_TAIL_BYTES = 4_000

/** Convert any media file into the 16 kHz mono WAV whisper.cpp requires. */
export async function extractWav(options: ExtractOptions, deps: ExtractDeps = {}): Promise<void> {
  const { inputPath, outputPath, durationMs, onProgress, signal } = options

  if (signal?.aborted) throw new Error('extractWav: aborted before starting')

  const spawn = deps.spawn ?? ((file, args) => nodeSpawn(file, args) as unknown as SpawnedProcess)
  const binary = deps.ffmpegPath ?? defaultFfmpegPath()

  const child = spawn(binary, [
    '-nostdin',
    '-loglevel', 'error',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    '-progress', 'pipe:1',
    '-y',
    outputPath,
  ])

  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES)
  })

  if (onProgress) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const match = /^out_time_us=(\d+)$/.exec(line.trim())
      if (!match) return

      const elapsedMs = Number(match[1]) / 1_000
      // A zero duration means we cannot compute a fraction; report completion
      // rather than dividing by zero.
      onProgress(durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : 1)
    })
  } else {
    child.stdout.resume()
  }

  const onAbort = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on('close', resolve)
      child.on('error', reject)
    })

    if (signal?.aborted) throw new Error('extractWav: aborted')

    if (code !== 0) {
      throw new AppError(
        'FFMPEG_FAILED',
        "Couldn't prepare the audio from this file.",
        `ffmpeg exited with code ${code}\n${stderrTail}`,
      )
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/main/media/extract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/media/extract.ts test/main/media/extract.test.ts test/helpers/fake-child.ts
git commit -m "feat: extract 16kHz mono wav with ffmpeg, with progress and cancel"
```

---

### Task 7: whisper-cli runner

Spawns whisper-cli and turns its streaming stdout into segments as they arrive, so the caller can show progress rather than waiting for the whole file.

The important edge case is **chunk boundaries landing mid-line**. Node delivers stdout in arbitrary chunks; a naive `chunk.split('\n')` loses or corrupts segments. Using `readline` over the stream handles it, and there is a test that deliberately splits a line across two chunks.

**Files:**
- Create: `src/main/whisper/runner.ts`
- Test: `test/main/whisper/runner.test.ts`

**Interfaces:**
- Consumes: `parseSegmentLine` from `src/main/whisper/parse.ts`; `whisperCliPath` from `src/main/binaries.ts`; `SpawnFn`/`SpawnedProcess` from `src/main/media/extract.ts`; `AppError`, `Segment`.
- Produces:
  - `type RunnerDeps = { whisperCliPath?: string; spawn?: SpawnFn }`
  - `runWhisper(options: RunOptions, deps?: RunnerDeps): Promise<Segment[]>` where
    `RunOptions = { wavPath: string; modelPath: string; language: string; threads?: number; onSegment?: (segment: Segment) => void; signal?: AbortSignal }`

- [ ] **Step 1: Write the failing tests**

Create `test/main/whisper/runner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { runWhisper } from '../../../src/main/whisper/runner.js'
import { createFakeChild } from '../../helpers/fake-child.js'

const OPTIONS = { wavPath: '/tmp/a.wav', modelPath: '/models/ggml-tiny.bin', language: 'en' }

describe('runWhisper', () => {
  it('returns the parsed segments', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStdout('[00:00:00.000 --> 00:00:02.000]  Hello there.\n')
    fake.emitStdout('[00:00:02.000 --> 00:00:04.000]  Second one.\n')
    fake.exit(0)

    await expect(promise).resolves.toEqual([
      { index: 0, startMs: 0, endMs: 2_000, text: 'Hello there.' },
      { index: 1, startMs: 2_000, endMs: 4_000, text: 'Second one.' },
    ])
  })

  it('emits each segment as it arrives', async () => {
    const fake = createFakeChild()
    const onSegment = vi.fn()
    const promise = runWhisper({ ...OPTIONS, onSegment }, { spawn: () => fake.child })

    fake.emitStdout('[00:00:00.000 --> 00:00:02.000]  Hello there.\n')
    fake.exit(0)
    await promise

    expect(onSegment).toHaveBeenCalledTimes(1)
    expect(onSegment).toHaveBeenCalledWith({ index: 0, startMs: 0, endMs: 2_000, text: 'Hello there.' })
  })

  it('reassembles a segment split across two stdout chunks', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStdout('[00:00:00.000 --> 00:00:0')
    fake.emitStdout('2.000]  Split across chunks.\n')
    fake.exit(0)

    await expect(promise).resolves.toEqual([
      { index: 0, startMs: 0, endMs: 2_000, text: 'Split across chunks.' },
    ])
  })

  it('ignores whisper log lines', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStdout('whisper_model_load: loading model\n')
    fake.emitStdout('system_info: n_threads = 4 | METAL = 1 |\n')
    fake.exit(0)

    await expect(promise).resolves.toEqual([])
  })

  it('throws WHISPER_FAILED with the stderr tail on a non-zero exit', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStderr('failed to load model\n')
    fake.exit(3)

    await expect(promise).rejects.toMatchObject({
      code: 'WHISPER_FAILED',
      detail: expect.stringContaining('failed to load model'),
    })
  })

  it('kills the process when the signal aborts', async () => {
    const controller = new AbortController()
    const fake = createFakeChild()
    const promise = runWhisper({ ...OPTIONS, signal: controller.signal }, { spawn: () => fake.child })

    controller.abort()
    fake.exit(137)

    await expect(promise).rejects.toThrow(/abort/i)
    expect(fake.killSignals).toContain('SIGKILL')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()

    await expect(runWhisper({ ...OPTIONS, signal: controller.signal }, { spawn })).rejects.toThrow(/abort/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('passes the model, wav and language to whisper-cli', async () => {
    let captured: string[] = []
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, {
      spawn: (_file, args) => {
        captured = args
        return fake.child
      },
    })
    fake.exit(0)
    await promise

    expect(captured).toContain('-m')
    expect(captured[captured.indexOf('-m') + 1]).toBe('/models/ggml-tiny.bin')
    expect(captured[captured.indexOf('-f') + 1]).toBe('/tmp/a.wav')
    expect(captured[captured.indexOf('-l') + 1]).toBe('en')
  })

  it('passes auto as the language when asked to detect', async () => {
    let captured: string[] = []
    const fake = createFakeChild()
    const promise = runWhisper(
      { ...OPTIONS, language: 'auto' },
      {
        spawn: (_file, args) => {
          captured = args
          return fake.child
        },
      },
    )
    fake.exit(0)
    await promise

    expect(captured[captured.indexOf('-l') + 1]).toBe('auto')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/whisper/runner.test.ts`
Expected: FAIL — cannot resolve `runner.js`.

- [ ] **Step 3: Implement `src/main/whisper/runner.ts`**

```ts
import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { whisperCliPath as defaultWhisperCliPath } from '../binaries.js'
import { AppError } from '../../shared/errors.js'
import type { Segment } from '../../shared/types.js'
import type { SpawnFn, SpawnedProcess } from '../media/extract.js'
import { parseSegmentLine } from './parse.js'

export type RunnerDeps = {
  whisperCliPath?: string
  spawn?: SpawnFn
}

export type RunOptions = {
  wavPath: string
  modelPath: string
  /** ISO 639-1 code, or 'auto' to detect. */
  language: string
  threads?: number
  onSegment?: (segment: Segment) => void
  signal?: AbortSignal
}

const STDERR_TAIL_BYTES = 4_000

/**
 * Run whisper-cli over a prepared WAV, emitting segments as they decode.
 *
 * stdout is consumed through readline rather than by splitting chunks, because
 * Node delivers arbitrary chunk boundaries and a segment line is routinely
 * split across two of them.
 */
export async function runWhisper(options: RunOptions, deps: RunnerDeps = {}): Promise<Segment[]> {
  const { wavPath, modelPath, language, threads, onSegment, signal } = options

  if (signal?.aborted) throw new Error('runWhisper: aborted before starting')

  const spawn = deps.spawn ?? ((file, args) => nodeSpawn(file, args) as unknown as SpawnedProcess)
  const binary = deps.whisperCliPath ?? defaultWhisperCliPath()

  const args = ['-m', modelPath, '-f', wavPath, '-l', language]
  if (threads) args.push('-t', String(threads))

  const child = spawn(binary, args)

  const segments: Segment[] = []

  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES)
  })

  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const parsed = parseSegmentLine(line)
    if (!parsed) return

    const segment: Segment = { index: segments.length, ...parsed }
    segments.push(segment)
    onSegment?.(segment)
  })

  const onAbort = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on('close', resolve)
      child.on('error', reject)
    })

    if (signal?.aborted) throw new Error('runWhisper: aborted')

    if (code !== 0) {
      throw new AppError(
        'WHISPER_FAILED',
        'Transcription failed unexpectedly.',
        `whisper-cli exited with code ${code}\n${stderrTail}`,
      )
    }

    return segments
  } finally {
    signal?.removeEventListener('abort', onAbort)
    lines.close()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/whisper/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/whisper/runner.ts test/main/whisper/runner.test.ts
git commit -m "feat: stream segments from whisper-cli with cancel support"
```

---

### Task 8: The transcription job coordinator

Sequences probe → prepare → transcribe, owns all job state, applies the spec's progress bands and ETA rule, and guarantees the temp WAV is deleted on every exit path.

Every collaborator is injected, including the clock. That is what makes the state machine, the progress arithmetic, and the cleanup testable without spawning a process or touching the disk.

**Files:**
- Create: `src/main/jobs/transcription-job.ts`
- Test: `test/main/jobs/transcription-job.test.ts`

**Interfaces:**
- Consumes: `MediaInfo`, `Segment`, `JobState`, `JobPhase`, `Unsubscribe` from `src/shared/types.ts`; `AppError` from `src/shared/errors.ts`.
- Produces:
  - `type JobDeps` (below)
  - `class TranscriptionJob` with `id`, `state`, `subscribe(listener)`, `start()`, `cancel()`
  - `PROGRESS_BANDS` constant

- [ ] **Step 1: Write the failing tests**

Create `test/main/jobs/transcription-job.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptionJob, type JobDeps } from '../../../src/main/jobs/transcription-job.js'
import { AppError } from '../../../src/shared/errors.js'
import type { JobPhase, MediaInfo, Segment } from '../../../src/shared/types.js'

const MEDIA: MediaInfo = {
  path: '/tmp/in.mp4',
  durationMs: 100_000,
  hasAudio: true,
  container: 'mov,mp4',
}

const SEGMENTS: Segment[] = [
  { index: 0, startMs: 0, endMs: 50_000, text: 'First half.' },
  { index: 1, startMs: 50_000, endMs: 100_000, text: 'Second half.' },
]

function makeDeps(overrides: Partial<JobDeps> = {}): JobDeps {
  let clock = 0
  return {
    probe: async () => MEDIA,
    extract: async () => {},
    run: async (_options, onSegment) => {
      for (const segment of SEGMENTS) onSegment(segment)
      return SEGMENTS
    },
    tempWavPath: (id) => `/tmp/${id}.wav`,
    removeFile: async () => {},
    now: () => (clock += 1_000),
    ...overrides,
  }
}

function makeJob(deps: Partial<JobDeps> = {}) {
  return new TranscriptionJob(makeDeps(deps), {
    id: 'job-1',
    filePath: '/tmp/in.mp4',
    modelPath: '/models/ggml-tiny.bin',
    language: 'en',
  })
}

describe('TranscriptionJob', () => {
  let phases: JobPhase[]

  beforeEach(() => {
    phases = []
  })

  it('moves through probing, preparing, transcribing and done', async () => {
    const job = makeJob()
    // Each phase emits several updates as progress advances; collapse runs so
    // this asserts the phase order, not the notification count.
    job.subscribe((state) => {
      if (phases.at(-1) !== state.phase) phases.push(state.phase)
    })
    await job.start()
    expect(phases).toEqual(['probing', 'preparing', 'transcribing', 'done'])
  })

  it('ends at progress 1 with the segments attached', async () => {
    const job = makeJob()
    await job.start()
    expect(job.state.progress).toBe(1)
    expect(job.state.segments).toEqual(SEGMENTS)
  })

  it('caps the preparing phase at the 0.08 band boundary', async () => {
    const progresses: number[] = []
    const job = makeJob({
      extract: async ({ onProgress }) => {
        onProgress(0.5)
        onProgress(1)
      },
      run: async () => [],
    })
    job.subscribe((state) => {
      if (state.phase === 'preparing') progresses.push(state.progress)
    })
    await job.start()
    // 0.02 on entering the phase, then the two reported fractions mapped into
    // the 0.02-0.08 band.
    expect(progresses).toEqual([0.02, 0.05, 0.08])
  })

  it('maps transcription progress into the 0.08 to 1 band', async () => {
    const progresses: number[] = []
    const job = makeJob()
    job.subscribe((state) => {
      if (state.phase === 'transcribing') progresses.push(state.progress)
    })
    await job.start()
    // 0.08 on entering, then segments ending at 50s and 100s of a 100s file.
    expect(progresses).toEqual([0.08, 0.08 + 0.92 * 0.5, 1])
  })

  it('withholds the ETA until transcription reaches ten percent', async () => {
    const etas: (number | undefined)[] = []
    const job = makeJob({
      run: async (_options, onSegment) => {
        onSegment({ index: 0, startMs: 0, endMs: 5_000, text: 'early' }) // 5%
        onSegment({ index: 1, startMs: 5_000, endMs: 50_000, text: 'later' }) // 50%
        return []
      },
    })
    job.subscribe((state) => {
      if (state.phase === 'transcribing') etas.push(state.etaMs)
    })
    await job.start()
    expect(etas[0]).toBeUndefined() // entering the phase
    expect(etas[1]).toBeUndefined() // 5%, below the threshold
    expect(etas[2]).toBeGreaterThan(0) // 50%
  })

  it('records a realtime factor on completion', async () => {
    const job = makeJob()
    await job.start()
    expect(job.state.realtimeFactor).toBeGreaterThan(0)
  })

  it('fails with NO_AUDIO_STREAM when the file has no audio', async () => {
    const job = makeJob({ probe: async () => ({ ...MEDIA, hasAudio: false }) })
    await job.start()
    expect(job.state.phase).toBe('failed')
    expect(job.state.error?.code).toBe('NO_AUDIO_STREAM')
  })

  it('never runs whisper when the file has no audio', async () => {
    const run = vi.fn(async () => [] as Segment[])
    const job = makeJob({ probe: async () => ({ ...MEDIA, hasAudio: false }), run })
    await job.start()
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates the error code from a failing extract', async () => {
    const job = makeJob({
      extract: async () => {
        throw new AppError('FFMPEG_FAILED', "Couldn't prepare the audio.", 'exit 1')
      },
    })
    await job.start()
    expect(job.state.phase).toBe('failed')
    expect(job.state.error).toEqual({
      code: 'FFMPEG_FAILED',
      message: "Couldn't prepare the audio.",
      detail: 'exit 1',
    })
  })

  it('wraps a non-AppError failure as WHISPER_FAILED', async () => {
    const job = makeJob({
      run: async () => {
        throw new Error('kaboom')
      },
    })
    await job.start()
    expect(job.state.error?.code).toBe('WHISPER_FAILED')
    expect(job.state.error?.detail).toContain('kaboom')
  })

  it('deletes the temp wav after success', async () => {
    const removeFile = vi.fn(async () => {})
    const job = makeJob({ removeFile })
    await job.start()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('deletes the temp wav after failure', async () => {
    const removeFile = vi.fn(async () => {})
    const job = makeJob({
      removeFile,
      run: async () => {
        throw new Error('kaboom')
      },
    })
    await job.start()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('cancels during preparing, skips whisper and cleans up', async () => {
    const removeFile = vi.fn(async () => {})
    const run = vi.fn(async () => [] as Segment[])
    let job!: TranscriptionJob
    job = makeJob({
      removeFile,
      run,
      extract: async ({ signal }) => {
        job.cancel()
        if (signal.aborted) throw new Error('aborted')
      },
    })
    await job.start()

    expect(job.state.phase).toBe('cancelled')
    expect(run).not.toHaveBeenCalled()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('cancels during transcribing and cleans up', async () => {
    const removeFile = vi.fn(async () => {})
    let job!: TranscriptionJob
    job = makeJob({
      removeFile,
      run: async (_options, _onSegment) => {
        job.cancel()
        throw new Error('aborted')
      },
    })
    await job.start()

    expect(job.state.phase).toBe('cancelled')
    expect(job.state.error).toBeUndefined()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('reports cancellation rather than an error when both happen', async () => {
    let job!: TranscriptionJob
    job = makeJob({
      run: async () => {
        job.cancel()
        throw new AppError('WHISPER_FAILED', 'killed', 'SIGKILL')
      },
    })
    await job.start()
    expect(job.state.phase).toBe('cancelled')
    expect(job.state.error).toBeUndefined()
  })

  it('stops notifying a listener after it unsubscribes', async () => {
    const listener = vi.fn()
    const job = makeJob()
    const unsubscribe = job.subscribe(listener)
    unsubscribe()
    await job.start()
    expect(listener).not.toHaveBeenCalled()
  })

  it('hands listeners a snapshot that later mutation cannot change', async () => {
    const snapshots: number[] = []
    const job = makeJob()
    job.subscribe((state) => snapshots.push(state.segments.length))
    await job.start()
    expect(snapshots[0]).toBe(0)
    expect(snapshots.at(-1)).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/jobs/transcription-job.test.ts`
Expected: FAIL — cannot resolve `transcription-job.js`.

- [ ] **Step 3: Implement `src/main/jobs/transcription-job.ts`**

```ts
import { AppError } from '../../shared/errors.js'
import type { JobState, MediaInfo, Segment, Unsubscribe } from '../../shared/types.js'

/** Fixed by the spec. Progress is one 0..1 value spanning every phase. */
export const PROGRESS_BANDS = {
  probing: { from: 0, to: 0.02 },
  preparing: { from: 0.02, to: 0.08 },
  transcribing: { from: 0.08, to: 1 },
} as const

/** Transcription-phase progress below which the ETA is too noisy to show. */
const ETA_THRESHOLD = 0.1

export type JobDeps = {
  probe: (filePath: string) => Promise<MediaInfo>
  extract: (options: {
    inputPath: string
    outputPath: string
    durationMs: number
    onProgress: (fraction: number) => void
    signal: AbortSignal
  }) => Promise<void>
  run: (
    options: { wavPath: string; modelPath: string; language: string; signal: AbortSignal },
    onSegment: (segment: Segment) => void,
  ) => Promise<Segment[]>
  tempWavPath: (jobId: string) => string
  /** Must succeed when the file does not exist. */
  removeFile: (path: string) => Promise<void>
  now: () => number
}

export type JobInput = {
  id: string
  filePath: string
  modelPath: string
  /** ISO 639-1 code, or 'auto'. */
  language: string
}

/**
 * Sequences one file through the pipeline and is the only holder of job state.
 *
 * Collaborators are injected so the phase machine, progress banding and cleanup
 * can be tested without spawning a process or touching the disk.
 */
export class TranscriptionJob {
  readonly id: string

  private readonly controller = new AbortController()
  private readonly listeners = new Set<(state: JobState) => void>()
  private current: JobState
  private cancelled = false

  constructor(
    private readonly deps: JobDeps,
    private readonly input: JobInput,
  ) {
    this.id = input.id
    this.current = {
      id: input.id,
      filePath: input.filePath,
      phase: 'probing',
      progress: 0,
      segments: [],
    }
  }

  get state(): JobState {
    return this.snapshot()
  }

  subscribe(listener: (state: JobState) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cancel(): void {
    if (this.isFinished()) return
    this.cancelled = true
    this.controller.abort()
  }

  async start(): Promise<void> {
    const wavPath = this.deps.tempWavPath(this.id)

    try {
      const media = await this.probePhase()
      await this.preparePhase(media, wavPath)
      await this.transcribePhase(media, wavPath)
    } catch (cause) {
      if (this.cancelled) this.finishCancelled()
      else this.finishFailed(cause)
    } finally {
      await this.deps.removeFile(wavPath)
    }
  }

  // --- phases -------------------------------------------------------------

  private async probePhase(): Promise<MediaInfo> {
    this.update({ phase: 'probing', progress: PROGRESS_BANDS.probing.from })

    const media = await this.deps.probe(this.input.filePath)
    this.throwIfCancelled()

    if (!media.hasAudio) {
      throw new AppError(
        'NO_AUDIO_STREAM',
        "This file doesn't contain any audio.",
        `${this.input.filePath} (${media.container})`,
      )
    }

    this.current = { ...this.current, media }
    return media
  }

  private async preparePhase(media: MediaInfo, wavPath: string): Promise<void> {
    const { from, to } = PROGRESS_BANDS.preparing
    this.update({ phase: 'preparing', progress: from })

    await this.deps.extract({
      inputPath: this.input.filePath,
      outputPath: wavPath,
      durationMs: media.durationMs,
      onProgress: (fraction) => {
        this.update({ progress: band(from, to, fraction) })
      },
      signal: this.controller.signal,
    })

    this.throwIfCancelled()
  }

  private async transcribePhase(media: MediaInfo, wavPath: string): Promise<void> {
    const { from, to } = PROGRESS_BANDS.transcribing
    const startedAt = this.deps.now()

    this.update({ phase: 'transcribing', progress: from })

    const segments: Segment[] = []

    await this.deps.run(
      {
        wavPath,
        modelPath: this.input.modelPath,
        language: this.input.language,
        signal: this.controller.signal,
      },
      (segment) => {
        segments.push(segment)

        const fraction =
          media.durationMs > 0 ? Math.min(1, segment.endMs / media.durationMs) : 1
        const elapsed = this.deps.now() - startedAt

        this.update({
          segments: [...segments],
          progress: band(from, to, fraction),
          etaMs:
            fraction >= ETA_THRESHOLD ? Math.round((elapsed * (1 - fraction)) / fraction) : undefined,
        })
      },
    )

    this.throwIfCancelled()

    const elapsed = Math.max(1, this.deps.now() - startedAt)

    this.update({
      phase: 'done',
      progress: 1,
      etaMs: undefined,
      segments: [...segments],
      realtimeFactor: media.durationMs / elapsed,
    })
  }

  // --- terminal states ----------------------------------------------------

  private finishCancelled(): void {
    this.update({ phase: 'cancelled', etaMs: undefined })
  }

  private finishFailed(cause: unknown): void {
    const error =
      cause instanceof AppError
        ? cause.toJSON()
        : {
            code: 'WHISPER_FAILED' as const,
            message: 'Transcription failed unexpectedly.',
            detail: cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : String(cause),
          }

    this.update({ phase: 'failed', etaMs: undefined, error })
  }

  // --- plumbing -----------------------------------------------------------

  private isFinished(): boolean {
    return ['done', 'cancelled', 'failed'].includes(this.current.phase)
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new Error('TranscriptionJob: cancelled')
  }

  private update(patch: Partial<JobState>): void {
    this.current = { ...this.current, ...patch }
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  /** Listeners get their own copy, so later mutation cannot reach them. */
  private snapshot(): JobState {
    return { ...this.current, segments: [...this.current.segments] }
  }
}

/** Map a 0..1 phase fraction into its slice of overall progress. */
function band(from: number, to: number, fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction))
  return from + (to - from) * clamped
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/jobs/transcription-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole unit suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/jobs/transcription-job.ts test/main/jobs/transcription-job.test.ts
git commit -m "feat: add transcription job coordinator with progress, eta and cleanup"
```

---

### Task 9: End-to-end integration test

Proves the whole pipeline works against real binaries and a real model. Everything before this used fakes; this is the task that would catch a wrong ffmpeg flag or a whisper-cli output format change.

The fixtures are generated once and committed. The assertion checks that the transcript **contains** the distinctive spoken words rather than matching exactly, because model output is not byte-stable across versions.

**Files:**
- Create: `scripts/fetch-test-model.mjs`
- Create: `vitest.integration.config.ts`
- Create: `test/fixtures/hello.wav`
- Create: `test/fixtures/hello.mp4`
- Create: `test/integration/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: no new production code.

- [ ] **Step 1: Create `scripts/fetch-test-model.mjs`**

```js
#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL_ = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
const dest = join(ROOT, '.cache', 'models', 'ggml-tiny.bin')

if (existsSync(dest)) {
  console.log(`tiny model already present at ${dest}`)
  process.exit(0)
}

mkdirSync(dirname(dest), { recursive: true })

console.log(`Downloading ggml-tiny.bin (~75 MB) to ${dest}`)
const response = await fetch(URL_)
if (!response.ok || !response.body) {
  console.error(`Download failed: HTTP ${response.status}`)
  process.exit(1)
}

const partial = `${dest}.part`
await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
renameSync(partial, dest)
console.log('Done.')
```

- [ ] **Step 2: Create `vitest.integration.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // A tiny-model run on a 3-second clip is fast, but a cold start on a
    // loaded CI machine is not.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
```

- [ ] **Step 3: Generate the audio fixture**

On macOS, run these from the repo root:

```bash
mkdir -p test/fixtures
say -v Samantha -o /tmp/whisper-drop-fixture.aiff "Testing one two three four."
node -e "import('ffmpeg-static').then(m=>console.log(m.default))" > /tmp/ffmpeg-path
"$(cat /tmp/ffmpeg-path)" -y -i /tmp/whisper-drop-fixture.aiff \
  -ac 1 -ar 16000 -c:a pcm_s16le test/fixtures/hello.wav
```

On Linux, substitute any TTS or a recorded clip saying the same sentence.

Verify: `ls -la test/fixtures/hello.wav` — expect roughly 60–120 KB.

- [ ] **Step 4: Generate the video fixture**

```bash
"$(cat /tmp/ffmpeg-path)" -y -f lavfi -i color=c=black:s=320x240:r=15 \
  -i test/fixtures/hello.wav -shortest \
  -c:v libx264 -pix_fmt yuv420p -c:a aac test/fixtures/hello.mp4
```

Verify: `ls -la test/fixtures/hello.mp4` — expect roughly 20–60 KB.

- [ ] **Step 5: Write the integration test**

Create `test/integration/pipeline.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractWav } from '../../src/main/media/extract.js'
import { format } from '../../src/main/export/formatters.js'
import { TranscriptionJob } from '../../src/main/jobs/transcription-job.js'
import { probe } from '../../src/main/media/probe.js'
import { runWhisper } from '../../src/main/whisper/runner.js'
import type { JobPhase } from '../../src/shared/types.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const MODEL = fileURLToPath(new URL('../../.cache/models/ggml-tiny.bin', import.meta.url))

let workDir: string

beforeAll(async () => {
  expect(existsSync(MODEL), 'run `npm run test:integration` so the tiny model is downloaded').toBe(true)
  workDir = await mkdtemp(join(tmpdir(), 'whisper-drop-'))
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function makeJob(filePath: string, id: string) {
  return new TranscriptionJob(
    {
      probe: (path) => probe(path),
      extract: (options) => extractWav(options),
      run: (options, onSegment) =>
        runWhisper({
          wavPath: options.wavPath,
          modelPath: options.modelPath,
          language: options.language,
          onSegment,
          signal: options.signal,
        }),
      tempWavPath: (jobId) => join(workDir, `${jobId}.wav`),
      removeFile: (path) => rm(path, { force: true }),
      now: () => Date.now(),
    },
    { id, filePath, modelPath: MODEL, language: 'en' },
  )
}

describe('probe against real ffprobe', () => {
  it('reads duration and audio presence from the wav fixture', async () => {
    const info = await probe(join(FIXTURES, 'hello.wav'))
    expect(info.hasAudio).toBe(true)
    expect(info.durationMs).toBeGreaterThan(500)
  })

  it('reads the mp4 fixture as having audio', async () => {
    const info = await probe(join(FIXTURES, 'hello.mp4'))
    expect(info.hasAudio).toBe(true)
  })

  it('rejects a non-media file with UNREADABLE_MEDIA', async () => {
    await expect(
      probe(fileURLToPath(new URL('../../package.json', import.meta.url))),
    ).rejects.toMatchObject({ code: 'UNREADABLE_MEDIA' })
  })
})

describe('full pipeline', () => {
  it('transcribes the wav fixture', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'wav-job')
    await job.start()

    expect(job.state.phase).toBe('done')
    expect(format(job.state.segments, 'txt').toLowerCase()).toContain('testing')
  })

  it('transcribes the mp4 fixture, proving video audio extraction works', async () => {
    const job = makeJob(join(FIXTURES, 'hello.mp4'), 'mp4-job')
    await job.start()

    expect(job.state.phase).toBe('done')
    expect(format(job.state.segments, 'txt').toLowerCase()).toContain('testing')
  })

  it('progresses through every phase in order', async () => {
    const phases: JobPhase[] = []
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'phase-job')
    job.subscribe((state) => {
      if (phases.at(-1) !== state.phase) phases.push(state.phase)
    })
    await job.start()

    expect(phases).toEqual(['probing', 'preparing', 'transcribing', 'done'])
  })

  it('produces a well-formed srt', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'srt-job')
    await job.start()

    const srt = format(job.state.segments, 'srt')
    expect(srt.startsWith('1\n')).toBe(true)
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/)
  })

  it('produces a well-formed vtt', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'vtt-job')
    await job.start()

    const vtt = format(job.state.segments, 'vtt')
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)
  })

  it('deletes the temp wav when the job completes', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'cleanup-job')
    await job.start()
    expect(existsSync(join(workDir, 'cleanup-job.wav'))).toBe(false)
  })

  it('records a realtime factor above zero', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'rtf-job')
    await job.start()
    expect(job.state.realtimeFactor).toBeGreaterThan(0)
  })

  it('cancels a running job and cleans up', async () => {
    const job = makeJob(join(FIXTURES, 'hello.mp4'), 'cancel-job')
    const started = job.start()
    job.cancel()
    await started

    expect(job.state.phase).toBe('cancelled')
    expect(existsSync(join(workDir, 'cancel-job.wav'))).toBe(false)
  })
})
```

- [ ] **Step 6: Run the integration suite**

Run: `npm run test:integration`
Expected: the tiny model downloads on first run, then PASS. If a transcript assertion fails, print the actual transcript and confirm the fixture audio is intelligible before changing the assertion.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck && npm run test:integration`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/fetch-test-model.mjs vitest.integration.config.ts test/fixtures/hello.wav test/fixtures/hello.mp4 test/integration/pipeline.test.ts
git commit -m "test: end-to-end pipeline integration against real binaries"
```

---

## Done when

- `npm test` passes the unit suite with no network access and no spawned binaries.
- `npm run typecheck` is clean.
- `npm run test:integration` transcribes both fixtures and asserts the text.
- No module under `src/main/` imports `electron`.
- A cancelled job leaves no temp WAV and no orphaned process.

## What plan 2 picks up

The model catalog, `resolveModelId`, resumable checksum-verified downloads, the on-disk model store, and persisted settings — including the `throughput` map that `JobState.realtimeFactor` feeds.
