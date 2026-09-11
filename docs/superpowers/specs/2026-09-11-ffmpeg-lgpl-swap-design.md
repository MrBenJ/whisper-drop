# Design: swap bundled ffmpeg to a redistributable LGPL build

Status: approved (2026-09-11)
Scope of this session: **local implementation + PR only.** Everything through a
reviewed branch/PR that builds and verifies locally. It deliberately stops
before any `git push`, `v*` tag, release-CI run, or GitHub Release — those are
the irreversible, GitHub-gated steps, driven separately with GitHub access.

## Problem

whisper-drop bundles `ffmpeg` / `ffprobe` from the `ffmpeg-static` and
`@derhuerst/ffprobe-static` npm packages. Those ship binaries built
`--enable-gpl --enable-version3 --enable-nonfree`. FFmpeg's own terms forbid
redistributing a `--enable-nonfree` binary at all, so `release.yml` builds
installers on every `v*` tag but discards them (the upload step is commented
out) and no release has ever been published.

The app uses ffmpeg/ffprobe for **decoding only** (any input media → 16 kHz
mono WAV for whisper.cpp); it never encodes. An **LGPL** build — no
`--enable-gpl`, no `--enable-nonfree` — is fully sufficient and keeps
compliance simplest against the app's MIT license. The owner chose option 1
from the README: **bundle a redistributable LGPL ffmpeg build.**

## Decisions locked in brainstorming

1. **Session scope:** local implementation + PR; stop before release.
2. **macOS ffmpeg source:** compile from source in CI with an LGPL config
   (no well-known LGPL static macOS build exists). Windows/Linux use BtbN's
   ready-made `-lgpl` static builds.
3. **Fully drop** the two npm deps (no dev fallback) — provisioning replaces
   them on every platform, including local dev.
4. **macOS build is a full LGPL build, statically linked** (`--disable-shared
   --enable-static`), not a fragile `--disable-everything` minimal build, so it
   decodes arbitrary input reliably. LGPL is the default configure posture;
   correctness = never adding `--enable-gpl`/`--enable-nonfree`.

## Architecture

### 1. Provenance & pinning — `ffmpeg.manifest.json` (new)

Sibling of `whisper.manifest.json`. Pins everything a reproducible fetch/build
needs:

- `ffmpegTag` / `ffmpegRepo` — the FFmpeg source tag we compile on macOS.
- `btbn.tag` — the pinned BtbN `ffmpeg-builds` **release** (not `latest`).
- `btbn.assets` — per `win32-x64` / `linux-x64`: the `-lgpl` archive filename,
  its download URL, and its **SHA-256**. A swapped asset fails the checksum.

Pinning to versioned releases makes every build reproducible and is what the
LGPL "corresponding source/config" offer points at.

### 2. Provisioning — `scripts/build-ffmpeg.mjs` (new), mirrors `build-whisper.mjs`

Provisions ffmpeg + ffprobe for a target `${platform}-${arch}` into
`resources/<target>/`, stamped/cached under `.cache/ffmpeg` exactly like the
whisper build:

- **macOS:** clone the pinned FFmpeg tag → `./configure` **LGPL, decode-focused**
  — no `--enable-gpl`, no `--enable-nonfree`, `--disable-shared --enable-static`
  so the executables embed libav* and depend only on system frameworks;
  `--disable-doc` etc. for speed. The x64-on-arm64 leg cross-compiles
  (`-arch x86_64`, `--enable-cross-compile`, `--arch=x86_64`). `make ffmpeg
  ffprobe`, copy both into `resources/<target>/`.
- **Windows / Linux:** download the pinned BtbN `-lgpl` archive → **verify
  SHA-256** → extract `ffmpeg`/`ffprobe` into `resources/<target>/`.
- Target arch selected by `WHISPER_DROP_TARGET_ARCH` (same env var
  `build-whisper.mjs` uses), host arch otherwise. Cross-arch only on macOS.

`npm run setup` runs `build-whisper` **and** `build-ffmpeg` for the host, so a
fresh clone has real ffmpeg/ffprobe for dev + tests (the job the npm deps used
to do implicitly).

### 3. Plumbing changes

- **`src/main/binaries.ts`:** `ffmpegPath()` / `ffprobePath()` resolve through
  the existing `resolveResourcesDir(env)` + exe name — identical to
  `resolveWhisperCliPath()`. Drop the `ffmpeg-static` / `@derhuerst/
  ffprobe-static` imports. `unpackedPath()` + `ASAR_SEGMENT` were used **only**
  by the media binaries → delete them (dead once the binaries live in
  `extraResources`, which are never inside `app.asar`).
- **`electron-builder.json`:** remove the `asarUnpack` array (both entries
  pointed at the now-removed npm packages). `extraResources` already ships the
  whole `resources/${platform}-${arch}` dir, so ffmpeg/ffprobe ride along with
  `whisper-cli` unchanged.
- **`package.json`:** remove `ffmpeg-static` and `@derhuerst/ffprobe-static`
  from `dependencies`; add a `setup` step that also provisions ffmpeg (or a
  `build-ffmpeg` script the `setup` script chains).
- **`src/types/ffmpeg-static.d.ts`:** delete (module shims for the removed deps).

### 4. Verify scripts + the license gate

- **`scripts/verify-release-binaries.mjs`:** point the ffmpeg/ffprobe checks at
  `resources/${platform}-${arch}/{ffmpeg,ffprobe}` (was `node_modules/...`);
  keep the Mach-O / PE / ELF arch-header detection.
- **New license-flags gate, by byte-scanning the binary — not executing it.**
  ffmpeg compiles its full `configuration:` string into the executable, so the
  check reads the binary and asserts its bytes contain **no `--enable-nonfree`
  and no `--enable-gpl`**. This works cross-arch: the macOS-x64-on-arm64 leg
  can't be *run* on the runner but *can* be scanned, so all four binaries are
  gated automatically ("don't eyeball it"). A binary that fails is never
  packaged.
- **`scripts/verify-before-pack.mjs`:** unchanged — it already shells out to
  `verify-release-binaries.mjs`, so local `electron-builder` runs inherit the
  same gate.

### 5. `release.yml`

- Remove the "Install the `${arch}` ffmpeg-static binary" reinstall step.
- Add an ffmpeg provision step (`node scripts/build-ffmpeg.mjs` — compile on
  macOS, fetch+checksum on win/linux), cached per `${platform}-${arch}` with a
  key derived from the ffmpeg manifest.
- Keep the verify step (now also license-gated).
- **Restore the commented-out `upload-artifact` step verbatim.**
- Add a **release-publishing job**, gated on `v*` tags only, with
  `permissions: contents: write` scoped to that job alone, that downloads all
  four legs' artifacts and attaches them to a GitHub Release (5 assets: 2 dmg,
  1 exe, AppImage + deb).
- Leave `fail-fast: false`, `mac.identity: null`, and
  `CSC_IDENTITY_AUTO_DISCOVERY: false` exactly as they are.

*(Implemented this session but exercised only in the gated release follow-up.)*

### 6. `licenses.ts` + README

- **`src/renderer/licenses.ts`:** rewrite the FFmpeg entry — license = the LGPL
  build (e.g. `LGPL-2.1-or-later`, no nonfree/gpl); note states it's an LGPL
  build invoked as a separate executable and **where the corresponding source +
  exact build configuration are obtained** (FFmpeg tag + our configure flags;
  BtbN release for win/linux), which satisfies the LGPL source offer.
- **README:** resolve "Before publishing releases" (state option 1 was done and
  how); rewrite "Releases" (artifacts now published) and "Licenses" (LGPL, not
  nonfree); confirm install instructions match the real assets — macOS `.dmg`
  arm64 + x64, Windows NSIS `.exe`, Linux `.AppImage` + `.deb`.

### 7. Testing (TDD) & honest limits

Adjust failing tests first, then implement:

- `test/main/binaries.test.ts` — ffmpeg/ffprobe now resolve from
  `resources/<target>`; delete the `unpackedPath` describe block.
- `test/build/verify-release-binaries.test.ts` — new resources paths; add
  cases for the license byte-scan (reject a binary whose bytes contain
  `--enable-nonfree` / `--enable-gpl`; accept a clean one).
- `test/build/electron-builder-config.test.ts` — drop the two asarUnpack
  assertions; assert `asarUnpack` is absent (or the media packages are not
  referenced).
- `test/renderer/licenses.test.ts` — expected FFmpeg entry text/license.
- `test/build/app-icon.test.ts` — imports `ffmpeg-static`; switch to the
  resources ffmpeg path (via `resolveResourcesDir`/`ffmpegPath`).

Then on this arm64 Mac: `npm test`, `npm run test:integration`, `npm run
test:e2e`, plus a real `.m4a` and `.mp4` transcoded end to end through the built
app, all against a freshly compiled LGPL macOS-arm64 ffmpeg.

**Honest limit:** only the macOS-arm64 path is fully compiled + verified here.
The Windows/Linux BtbN fetch and the full four-leg CI matrix are implemented
carefully but exercised only in the gated release follow-up (GitHub access
required).

## Hard constraints (carried from the handoff)

- **Never upload/publish any artifact containing the current nonfree ffmpeg** —
  not even a temporary workflow artifact. The upload step stays disabled until
  the swap is verified in CI. (This session doesn't touch CI running at all.)
- macOS builds stay unsigned/un-notarized.
- Work on a branch + PR; never push to main.

## Out of scope

benjunya.com linking to the Releases page (separate session).
