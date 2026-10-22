# Handoff: swap ffmpeg to a redistributable build, then publish the first release

You are working in `/Users/bjunya/code/hbai/opensource/whisper-drop` (repo
`MrBenJ/whisper-drop`, Electron app, electron-vite + electron-builder, version 0.1.0,
no releases published yet). Read the repo's README and any CLAUDE/AGENTS files first,
and follow the repo's existing superpowers workflow (brainstorm → plan → TDD) for the
implementation portion.

## The problem (why no release exists)

The app bundles `ffmpeg-static` and `@derhuerst/ffprobe-static` from npm. Those ship
binaries built with `--enable-nonfree`, which FFmpeg's licensing terms say may not be
redistributed at all. Because of this, `.github/workflows/release.yml` deliberately
builds installers for all four platform targets on every `v*` tag and then **discards
them** — the artifact-upload step is commented out with a long explanation and the
instruction "Restore verbatim when it's time to re-enable." The README section
"Before publishing releases" documents the same blocker and the two resolution
options. The repo owner (Ben) has chosen: **bundle a redistributable ffmpeg build
instead** (option 1). That is this task.

Key fact that makes this tractable: whisper-drop uses ffmpeg/ffprobe for **decoding
only** (any input media → 16 kHz mono WAV for whisper.cpp). It never encodes, so none
of the nonfree or GPL-only encoder components are needed. An **LGPL-only** ffmpeg
build is fully sufficient. Prefer LGPL over plain-GPL: the app is MIT and LGPL keeps
compliance simplest (attribution + a pointer to the ffmpeg source/config used).

## Scope

1. **Choose per-platform redistributable ffmpeg + ffprobe binaries.**
   - Windows x64 and Linux x64: BtbN's ffmpeg-builds project publishes ready-made
     **LGPL** static builds (variants literally named `*-lgpl`) containing both
     `ffmpeg` and `ffprobe`. Verify the variant chosen really is the LGPL one.
   - macOS arm64 and x64: no equivalent well-known LGPL static build exists; expect
     to **compile ffmpeg in CI** (autotools, LGPL config: no `--enable-gpl`, no
     `--enable-nonfree`, decode-focused; static or self-contained). Cache it the way
     `release.yml` already caches the whisper.cpp build. If you instead find a
     reputable prebuilt LGPL macOS source, verify its config before trusting it.
   - Acceptance check for every binary, all platforms: `ffmpeg -version` /
     `ffprobe -version` "configuration:" line contains **no `--enable-nonfree`** (and
     no `--enable-gpl` if claiming LGPL). Automate this — don't eyeball it.

2. **Wire the new binaries into the existing plumbing.** Touchpoints found by grep:
   - `src/main/binaries.ts` — resolves ffmpeg/ffprobe paths (currently from the npm
     packages via asarUnpack). Likely new home: `resources/${platform}-${arch}/`
     next to `whisper-cli`, which `electron-builder.json`'s `extraResources` already
     ships. That would also let you drop the npm deps and the
     `asarUnpack`/arch-reinstall gymnastics in `release.yml`.
   - `src/main/media/extract.ts` — the decode call sites.
   - `src/types/ffmpeg-static.d.ts` — delete if the npm deps go.
   - `scripts/verify-before-pack.mjs` and `scripts/verify-release-binaries.mjs` —
     update the existence/arch checks for the new locations, and add the
     license-flags check from step 1.
   - `src/renderer/licenses.ts` — the in-app Licenses screen. Replace the nonfree
     ffmpeg attribution with the LGPL notice for the new builds, including where the
     corresponding source and build configuration can be obtained (LGPL requires
     this offer).

3. **Update `release.yml`.** Remove the now-unneeded ffmpeg-static arch-reinstall
   step; add the binary fetch/compile step; restore the commented-out artifact
   upload; and add release publication on `v*` tags (e.g. a final job that attaches
   all four platforms' artifacts to a GitHub Release — needs `contents: write` on
   that job only). Keep `fail-fast: false` and the unsigned-build settings
   (`identity: null`, `CSC_IDENTITY_AUTO_DISCOVERY: false`) exactly as they are.

4. **Update the README.** Resolve the "Before publishing releases" section (say what
   was done), update the Licenses section, and confirm the per-platform install
   instructions match what the release actually contains: macOS `.dmg` for arm64 and
   x64, Windows NSIS `.exe`, Linux `.AppImage` + `.deb`.

5. **Verify, then release.**
   - Local: `npm test`, `npm run test:integration`, `npm run test:e2e` on this
     Mac (arm64) with the new binaries in place; transcribe at least one `.m4a` and
     one `.mp4` end to end via the built app.
   - CI: push a branch, run the release workflow via `workflow_dispatch`, confirm
     all four legs green and the artifacts contain the compliant binaries.
   - Then tag `v0.1.0`, push the tag, confirm the GitHub Release appears with all
     five assets, and download-check one of them.

## Hard constraints

- **Never upload or publish any artifact containing the current nonfree ffmpeg** —
  not even a temporary workflow artifact; the repo is public and workflow artifacts
  are world-downloadable the moment they exist. This is the exact exposure the
  current setup exists to prevent. The upload step stays disabled until the swap is
  verified.
- macOS builds stay unsigned/un-notarized (existing decision; README documents the
  Gatekeeper flow).
- Work on a branch + PR per the repo's conventions; don't push directly to main.

## Not in scope

Ben's personal site (benjunya.com, separate session) will link to this repo's
Releases page once this ships — nothing to do here for that.
