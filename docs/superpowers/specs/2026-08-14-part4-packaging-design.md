# whisper-drop Part 4 — Packaging and Distribution — Design

**Date:** 2026-08-14
**Status:** Approved (self-approved under the unsupervised directive — see Approval note)
**Parent spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md` — binding authority.

## Approval note

Written unsupervised. Judgement calls are recorded under
[Decisions made unsupervised](#decisions-made-unsupervised).

## Summary

The last part: turn a working development app into installable artifacts for macOS, Windows and
Linux, and give a stranger — or a non-technical client — everything they need to run it.

Parts 1–3 are merged: 510 tests, a hardened Electron app that transcribes end to end, and CI
running unit, integration and Electron e2e jobs.

## Scope

**In:** `electron-builder` configuration and targets; making the three bundled executables resolve
correctly in a packaged app; a release workflow that builds all platforms; the README; and a
Licenses screen in the app.

**Out:** code signing and notarization (the user chose to ship unsigned for now), auto-update, and
cutting an actual public release. The parent spec's Later list is unchanged.

## The single biggest risk, stated first

`src/main/binaries.ts` resolves `../../resources/<platform>-<arch>` relative to its own module
location. In development that lands on the repo's `resources/` **by a coincidence of directory
depth from `out/main/`**. In a packaged app it will not: main is inside `app.asar`, and packed
resources live under `process.resourcesPath`.

The module already reads `process.resourcesPath` when present, but nothing asserts either branch,
and the e2e test would catch a break only by failing to transcribe — with no indication why.

**This part must pin that.** The resolution rules become explicit, and both branches get tests. A
packaging change that silently relocates a binary must fail a test, not produce an app that
launches fine and then cannot transcribe.

## What must be packaged

| Executable | Source | How it must be packed |
|---|---|---|
| `whisper-cli` | built from whisper.cpp v1.9.2 into `resources/<platform>-<arch>/` | `extraResources`, resolved via `process.resourcesPath` |
| `ffmpeg` | the `ffmpeg-static` npm package | **`asarUnpack`** — it cannot execute from inside an asar archive |
| `ffprobe` | the `ffprobe-static` npm package | **`asarUnpack`**, same reason |

The asar point is not incidental. A binary inside `app.asar` is not a real file on disk and cannot
be spawned; it must be unpacked to `app.asar.unpacked/`. Getting this wrong produces an app that
builds cleanly, installs cleanly, launches cleanly, and fails on the first transcription with an
`ENOENT` that names a path which appears to exist.

## Targets

| Platform | Target | Arch |
|---|---|---|
| macOS | DMG | arm64 and x64 |
| Windows | NSIS installer | x64 |
| Linux | AppImage and `.deb` | x64 |

Unsigned on every platform. macOS users will see *"Apple could not verify this app is free of
malware"* and must right-click → Open the first time; Windows users will see a SmartScreen warning
and must choose "More info" → "Run anyway". Both are documented in the README with the exact
click-path, written for a non-technical reader — this is the first thing a client will hit.

## Release workflow

A separate workflow from CI, triggered by a version tag **or** `workflow_dispatch`, building on
`macos-latest`, `windows-latest` and `ubuntu-latest`.

Each platform job builds whisper.cpp for its own platform (cached on the pinned tag, exactly as the
existing `integration` and `e2e` jobs do), runs `electron-builder`, and uploads its artifacts.

**Nothing is published.** No tag is pushed by this work and no GitHub Release is created. The
workflow builds and packages on all three platforms but retains no artifacts — a workflow-run
artifact on a public repo is downloadable by anyone, and the bundled `ffmpeg-static` binary isn't
legally redistributable yet (see the README's "Before publishing releases"). That is what the user
asked for: build pipeline proven, publishing left as a deliberate human act, with nothing
downloadable produced in the meantime.

The existing `ci.yml` is untouched other than where the two share cache keys.

## README

The README is the app's front door, and for a non-technical client it may be the only thing they
read. It leads with what the app does and the privacy property — audio never leaves the machine,
no telemetry, works offline once a model is downloaded — because that is the reason to trust it
with a consultation recording.

It must cover: what it is; install and first-run per platform including the unsigned-app
walkthrough; how model sizes trade off; that transcription is local; building from source
(including the `cmake` prerequisite); and the licence position — MIT for this project, MIT for
whisper.cpp, and ffmpeg under its own licence, invoked as a separate executable.

Human Balance AI is credited as the author with a link. The app itself stays visually unbranded.

## Licenses screen

An in-app screen crediting whisper.cpp, ffmpeg, Electron and React, with their licences, reachable
from the header. This is both good manners and a licence obligation for the bundled binaries.

## Testing

Packaging is the hardest thing in this project to test cheaply, so the strategy is to test the
parts that can fail silently and verify the rest by building:

- **Unit tests for path resolution**: the packaged branch (given a fake `process.resourcesPath`),
  the development branch, and the `WHISPER_DROP_WHISPER_BIN` override. These are what stop a
  packaging change silently breaking transcription.
- **A config assertion test**: `asarUnpack` covers `ffmpeg-static` and `ffprobe-static`, and
  `extraResources` covers `resources/<platform>-<arch>`. A future edit that drops either entry
  fails a test rather than producing a broken artifact.
- **A real macOS build in CI** that produces a DMG, plus Windows and Linux builds, proving the
  configuration works on each platform.
- The existing 510 tests and the e2e job stay green.

Actually launching a packaged artifact and transcribing inside it is beyond what CI can do
cheaply here; the README documents a manual smoke check for a human before any real release.

## Decisions made unsupervised

1. **No public release, and no tag pushed.** The user chose "CI green, no public release" when
   asked. The workflow supports `workflow_dispatch` so a human can trigger a packaging run on
   demand without a tag — though, per the ffmpeg-static licensing issue below, that run currently
   proves packaging works without producing a downloadable artifact. *Cost if wrong:* someone has
   to click a button to get a build.
2. **Unsigned on all platforms.** The user declined the Apple Developer Program for now. The
   README carries the walkthrough instead. *Cost if wrong:* a support question from a client;
   notarization is a later config change, not a restructure.
3. **Path resolution gets unit tests rather than a packaged-app smoke test.** A real packaged
   launch-and-transcribe in CI is possible but slow and flaky across three platforms. Unit-testing
   both resolution branches catches the realistic failure — a config change relocating a binary —
   at a fraction of the cost. *Cost if wrong:* a packaging failure that only manifests in a real
   installed app still reaches a human first.
4. **The release workflow is separate from `ci.yml`** rather than a conditional job inside it.
   Different triggers, different runtimes, different failure meanings. *Cost if wrong:* two files
   share cache-key conventions that must stay in step.
