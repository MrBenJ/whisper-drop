# whisper-drop Part 2 — Model Management — Design

**Date:** 2026-08-13
**Status:** Approved (self-approved under the unsupervised directive — see Approval note)
**Parent spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md` — the binding
authority. This document refines its Model Management section; where the two
disagree, the parent wins and this document is the defect.

## Approval note

The parent spec was written and approved interactively. This one was written
unsupervised while the user was away, under a directive to make the recommended
call rather than wait. Every judgement call is recorded under
[Decisions made unsupervised](#decisions-made-unsupervised) so it can be
reviewed and reversed cheaply.

## Summary

Everything about getting Whisper models onto disk and remembering what the user
chose. Headless: no Electron, no UI, no IPC. Part 3 consumes what this produces.

## Scope

**In:** the model catalog, `resolveModelId`, resumable checksum-verified
downloads, the on-disk model store, and persisted settings including the
measured-throughput map.

**Out:** the model picker UI, the English-only toggle's *presentation*, the
first-run flow, IPC handlers — all Part 3. This part provides the data and
operations those screens call.

## Catalog

`src/main/models/catalog.ts` is pure data plus one pure function.

### The data is real, not approximate

The parent spec listed approximate sizes and deferred hashes to "pinned from
upstream during implementation". That is now done. Sizes and SHA-256 hashes
below were read from the HuggingFace API for `ggerganov/whisper.cpp` on
2026-08-13, and the mechanism was verified: HuggingFace's `lfs.oid` field was
confirmed byte-identical to `shasum -a 256` of a downloaded `ggml-tiny.bin`,
with the size matching exactly. These values go into the catalog verbatim.

| ModelId | File | Bytes | SHA-256 |
|---|---|---|---|
| `tiny` | `ggml-tiny.bin` | 77691713 | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| `tiny.en` | `ggml-tiny.en.bin` | 77704715 | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` |
| `base` | `ggml-base.bin` | 147951465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| `base.en` | `ggml-base.en.bin` | 147964211 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| `small` | `ggml-small.bin` | 487601967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| `small.en` | `ggml-small.en.bin` | 487614201 | `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` |
| `large-v3-turbo` | `ggml-large-v3-turbo.bin` | 1624555275 | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |
| `large-v3` | `ggml-large-v3.bin` | 3095033483 | `64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2` |

URL pattern: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`.

The API listing confirms **no `.en` variant exists above `small`**, which is
what forces the partial swap the parent spec describes.

### Types and the one pure function

```ts
type ModelBaseId = 'tiny' | 'base' | 'small' | 'large-v3-turbo' | 'large-v3'
type ModelId = ModelBaseId | 'tiny.en' | 'base.en' | 'small.en'

type ModelEntry = {
  id: ModelId
  base: ModelBaseId
  label: string          // "Base", "Large v3 Turbo"
  bytes: number
  sha256: string
  url: string
  blurb: string
  englishOnly: boolean
}

// The ONLY place a concrete ModelId is derived from a picker row.
// Returns the .en variant when English-only is on and one exists for that base;
// otherwise the multilingual id.
function resolveModelId(base: ModelBaseId, englishOnly: boolean): ModelId

const CATALOG: readonly ModelEntry[]
function entryFor(id: ModelId): ModelEntry        // throws on unknown id
function baseIds(): readonly ModelBaseId[]        // picker row order
```

Row order is fixed and ascending by capability: `tiny`, `base`, `small`,
`large-v3-turbo`, `large-v3`.

## Settings

`src/main/settings.ts`.

### The Electron problem, and how it is solved

Settings belong in the OS user-data directory, which in Electron means
`app.getPath('userData')`. But the parent spec forbids anything outside
`src/main/ipc/` from importing `electron`, and settings is not in `ipc/`.

**Resolution: injection, not an exception.** The module exports a factory taking
the directory as an argument. Part 3's composition root — which may import
Electron — passes `app.getPath('userData')`. Tests pass a temp directory. The
constraint holds unweakened and the module becomes trivially testable, which is
the same reasoning that makes `TranscriptionJob` testable in Part 1.

```ts
type Settings = {
  version: 1
  englishOnly: boolean
  activeModel: ModelBaseId | null
  language: string        // ISO 639-1, or 'auto'. Ignored while englishOnly.
  throughput: Partial<Record<ModelId, { realtimeFactor: number; samples: number }>>
}

function defaultSettings(locale: string): Settings
function createSettingsStore(dir: string): {
  read(): Promise<Settings>
  write(patch: Partial<Settings>): Promise<Settings>   // merge, persist, return merged
  recordThroughput(id: ModelId, realtimeFactor: number): Promise<Settings>
}
```

- Persisted as `<dir>/settings.json`, pretty-printed.
- **Writes are atomic**: write `settings.json.tmp`, then rename. A power cut mid-write
  must never leave a truncated file that bricks the app on next launch.
- `defaultSettings(locale)` sets `englishOnly` to true when the locale starts
  with `en`, per the parent spec's OS-locale default. `activeModel` starts
  `null`, which is what triggers Part 3's first-run picker.
- **A missing, unreadable, or malformed file yields defaults rather than an
  error.** Settings are a convenience; corrupt settings must never prevent the
  app from starting. A corrupt file is renamed to `settings.corrupt.json` before
  being replaced, so the failure is diagnosable rather than silently erased.
- `version` exists so a future migration has something to branch on. Unknown
  future versions fall back to defaults.
- `recordThroughput` keeps a running mean:
  `newMean = (oldMean * samples + observed) / (samples + 1)`, `samples + 1`.
  This is what `JobState.realtimeFactor` from Part 1 feeds.

## Store

`src/main/models/store.ts`. Same injection pattern — takes its directory.

```ts
function createModelStore(dir: string): {
  pathFor(id: ModelId): string                    // <dir>/models/<id>.bin
  isInstalled(id: ModelId): Promise<boolean>      // exists AND correct byte size
  listInstalled(): Promise<ModelId[]>
  remove(id: ModelId): Promise<void>              // succeeds when absent
  install(id: ModelId, opts): Promise<void>       // delegates to download
}
```

`isInstalled` checks the byte size against the catalog, not just existence. A
half-written file that somehow survived is not "installed" — the cheap size
check catches it without re-hashing gigabytes on every launch.

## Download

`src/main/models/download.ts`. The delicate part, and the one with the most
ways to fail quietly.

```ts
type DownloadProgress = {
  id: ModelId
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
}

function downloadModel(opts: {
  entry: ModelEntry
  destPath: string
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch     // injected for tests
}): Promise<void>
```

Sequence:

1. **Disk-space precheck** via `node:fs`'s `statfs` — available natively in Node
   22, so no dependency. Require free bytes `>= remaining + 64 MB` headroom.
   Fail `INSUFFICIENT_DISK_SPACE` before a single byte is fetched, because
   discovering it at 2.8 GB of 3.1 GB is the worst possible time.
2. **Resume**: if `<destPath>.part` exists, send `Range: bytes=<size>-`.
   - Response `206` → append.
   - Response `200` → the server ignored the range; **discard the partial and
     restart from zero.** Appending to a full-body response is the classic way to
     produce a corrupt file that still looks the right shape.
   - `.part` larger than the catalog's `bytes` → discard and restart.
3. **Stream to `.part`**, hashing incrementally with `node:crypto` so the file is
   never read twice.
4. **Verify** the digest against the catalog. Mismatch → delete `.part`, throw
   `DOWNLOAD_CHECKSUM_MISMATCH`.
5. **Atomic rename** `.part` → final. Nothing unverified is ever renamed into place.

Cancellation aborts the stream and **leaves `.part` intact** so a later attempt
resumes — the whole point of having a partial file.

Network failure throws `DOWNLOAD_NETWORK_ERROR`, also leaving `.part`. **No
automatic retry in v1**: a retry loop that hides a genuinely broken connection is
worse than an error the user can act on, and Part 3's UI offers an explicit
Retry that resumes.

All four codes already exist in Part 1's `ErrorCode`.

## Testing

Same shape as Part 1 — pure logic tested exhaustively, effects tested against
real but local resources.

**Pure, no mocks:** `resolveModelId` (the `.en` swap for tiny/base/small, the
no-op for both large rows, and both directions of the toggle); catalog structural
integrity (every `ModelBaseId` has a multilingual entry, every hash is 64 hex
chars, every URL matches the pattern, every `bytes` is positive, no duplicate ids).

**Settings, against a temp directory:** defaults from an `en-US` locale versus
`fr-FR`; round-trip; partial-patch merge; the running-mean arithmetic across
several samples; a corrupt file yielding defaults *and* being preserved as
`settings.corrupt.json`; an atomic write leaving no `.tmp` behind.

**Download, against a local HTTP server — no network in tests.** A server that
serves a known small blob and can be told to misbehave: honour Range, ignore
Range and return 200, return the wrong bytes, drop the connection mid-body.
Cases: clean download; resume from a partial; a 200-to-a-Range-request causing a
restart rather than corruption; checksum mismatch deleting `.part`; abort leaving
`.part` intact; insufficient disk space refusing before any fetch.

The 200-response case is the single most important test here, because it is the
failure that produces a plausible-looking corrupt file rather than an error.

## Interfaces produced for Part 3

`resolveModelId`, `CATALOG`, `entryFor`, `baseIds`, `createSettingsStore`,
`createModelStore`, `downloadModel`, and the `Settings` / `ModelEntry` /
`DownloadProgress` / `ModelId` / `ModelBaseId` types.

Part 3's `models.list()` composes these into one row per `ModelBaseId`, resolved
against the current `englishOnly` setting, annotated with installed state and
the measured `realtimeFactor`.

## Decisions made unsupervised

Each is the recommended option among alternatives actually considered.

1. **Directory injection over an Electron import exception.** Alternatives: let
   `settings.ts` import `electron` (breaks a spec constraint for convenience); a
   separate `paths.ts` that imports Electron (moves the violation rather than
   removing it). Injection keeps the constraint intact and makes the module
   testable with a temp dir. *Cost if wrong:* Part 3 must pass a directory in
   two places.
2. **No automatic download retry in v1.** Alternatives: exponential backoff (hides
   real breakage, and a wrong-bytes server would be retried pointlessly);
   retry-once. An explicit user-facing Retry that resumes from `.part` is
   honest and already in the parent spec's UI. *Cost if wrong:* a user on a flaky
   connection clicks Retry more than they would like.
3. **Corrupt settings fall back to defaults instead of throwing**, preserving the
   bad file as `settings.corrupt.json`. Alternative: fail loudly on startup —
   unacceptable, it makes a convenience file able to brick the app. *Cost if
   wrong:* a user silently loses preferences after a corruption they never see;
   mitigated by keeping the file.
4. **`isInstalled` checks byte size, not a full hash.** Alternative: re-hash on
   every check — correct but re-reads up to 3.1 GB on every launch. Size catches
   truncation, which is the realistic failure; full verification already happens
   at download time. *Cost if wrong:* a file corrupted in place after a verified
   download is not detected until whisper-cli fails on it.
5. **A 200 response to a Range request restarts rather than appends.** Not really
   a judgement call — appending is a correctness bug — but recorded because it is
   the kind of thing that gets "optimised" later by someone who assumes the
   server honoured the header.
