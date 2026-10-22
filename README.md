# whisper-drop

Drag an audio or video file onto the window. Get a transcript. That's the whole app.

whisper-drop runs [OpenAI's Whisper](https://github.com/openai/whisper) speech-to-text models on
your own machine via [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — no server, no
account, no upload.

## Your files never leave your machine

This is the reason to trust the app with something you wouldn't want sitting on someone else's
server: a client call, a confidential interview, a voice memo you haven't cleared with anyone.

- Audio and video are read, converted, and transcribed entirely on your computer.
- The app sends no telemetry and phones home to nobody.
- The only thing it ever fetches over the network is a Whisper model file, the one time you
  download it. After that, transcription works fully offline.

Nothing about this is configurable, because it isn't a setting — it's the whole design.

## Installing

Pick your platform below. whisper-drop isn't code-signed (see [Why unsigned](#why-unsigned)
below), so your operating system will warn you the first time you open it. That warning is
expected — here's exactly what to click through.

### macOS

1. Download the `.dmg` for your Mac (arm64 for Apple Silicon, x64 for an Intel Mac) and open it.
2. Drag **whisper-drop** into your Applications folder.
3. The first time you open it — however you open it — macOS will refuse with *"Apple could not
   verify that whisper-drop is free of malware."* That warning is expected: it means "an
   unrecognized developer built this," not "this is dangerous" (see [Why
   unsigned](#why-unsigned)). On a current Mac, this dialog offers only **Move to Trash** and
   **Done** — there is no **Open** button here, so don't look for one. Click **Done**, then:
   - Open **System Settings**.
   - Go to **Privacy & Security**, and scroll down to the **Security** section near the bottom.
   - You'll see a line reading something like *"whisper-drop was blocked to protect your Mac."*
     Click **Open Anyway** next to it.
   - Authenticate with your password or Touch ID when asked.
   - One more confirmation dialog appears — this one does have an **Open Anyway** button. Click it,
     and the app launches.
4. From then on, opening it normally (double-click, Spotlight, the Dock) works like any other app.
   You only do this once.

> **macOS 14 (Sonoma) and earlier:** those versions still show an **Open** button directly on the
> right-click menu — open **Applications** in Finder, **Right-click** (or Control-click)
> **whisper-drop**, choose **Open**, then click **Open** again on the dialog that follows. Apple
> removed this shortcut in macOS 15 Sequoia, which is why the System Settings path above is now the
> one that works on any current Mac.

### Windows

1. Download and run the installer `.exe`.
2. Windows SmartScreen will interrupt with *"Windows protected your PC"* and a blue **Don't run**
   button. Don't click that.
   - Click **More info**. A **Run anyway** button appears below the warning text.
   - Click **Run anyway**, then continue through the installer as normal.
3. This only happens on the installer itself. Launching the installed app afterwards is unremarkable.

### Linux

Two options, your choice:

- **AppImage**: download it, `chmod +x` it, and run it directly. No install step.
- **`.deb`**: `sudo apt install ./whisper-drop_*.deb` on Debian/Ubuntu-family distributions. (Not
  `dpkg -i` — it installs the package but leaves its dependencies unmet; `apt install` with a
  relative/local path resolves them too.)

Neither is signed, but Linux doesn't gate unsigned binaries the way macOS and Windows do, so there
is no extra click-path to document here.

### Why unsigned

Signing costs money every year (an Apple Developer account, a Windows code-signing certificate)
and this is a free tool. The warnings above are the honest tradeoff — they look alarming, but
they mean "an unrecognized developer built this," not "this is dangerous." You can verify what
you're running by reading the source in this repository, or by building it yourself (below).

## First run: choosing a model

The first time you open whisper-drop, it asks you to pick and download a Whisper model before it
will accept a file. Every model transcribes the same languages — the difference is size, speed,
and accuracy:

| Model | Download | Roughly |
|---|---|---|
| Tiny | ~78 MB | Fastest, roughest. Fine for a quick voice memo. |
| Base | ~148 MB | A reasonable default — quick, decent accuracy. |
| Small | ~488 MB | Noticeably better with accents and crosstalk. |
| Large v3 Turbo | ~1.6 GB | Near-best accuracy, several times faster than Large v3. |
| Large v3 | ~3.1 GB | The most accurate, and the slowest. |

**For anything longer than a few minutes — a meeting, an interview, a course recording — Large v3
Turbo is the recommendation.** It gets you nearly all of Large v3's accuracy in a fraction of the
time, which matters once a file runs to 30, 60, or 90 minutes.

You can download more than one model and switch between them at any time from the model button in
the header, without losing anything you've already downloaded.

### The "English only" toggle

Next to the model list is an English-only switch. Turning it on swaps in a different set of
model *weights* — English-only versions of Tiny, Base, and Small that are a little faster and a
little more accurate on English audio specifically. It does not filter or hide any models: every
model still appears in the list. (Large v3 Turbo and Large v3 have no English-only weights to
swap in — OpenAI never released them at that size — so those two rows stay exactly as they are
either way.)

## Building from source

You'll want this if you're on a platform without a pre-built download, want to audit exactly what
runs, or want to contribute.

**Prerequisites:**

- [Node.js](https://nodejs.org/) 22 or later
- [`cmake`](https://cmake.org/) — needed to compile whisper.cpp from source
- `git`
- **On macOS only:** a C toolchain with `make` and `clang` (the Xcode Command Line Tools —
  `xcode-select --install`), because ffmpeg is compiled from source there. (Windows and Linux
  download a prebuilt LGPL ffmpeg, so they need no compiler for it.)

```bash
git clone https://github.com/MrBenJ/whisper-drop.git
cd whisper-drop
npm install
npm run setup   # builds whisper.cpp and provisions ffmpeg for your platform
npm run dev     # launches the app
```

`npm run setup` clones a pinned tag of [whisper.cpp](https://github.com/ggml-org/whisper.cpp) into
`.cache/` and compiles it locally (that step is what `cmake` is for), then provisions ffmpeg and
ffprobe into `resources/` — compiled from source on macOS, downloaded and checksum-verified from
[BtbN](https://github.com/BtbN/FFmpeg-Builds) on Windows and Linux. It only needs to run once, or
again after a `whisper.manifest.json` or `ffmpeg.manifest.json` version bump.

Other useful commands, once set up:

```bash
npm test          # unit tests
npm run typecheck # TypeScript, main and renderer
npm run build     # production build, into out/
npm run test:e2e  # an end-to-end pass through the real app
```

## Releases

`.github/workflows/release.yml`, triggered by pushing a `v*` tag or running it manually
(`workflow_dispatch`), builds installers for all four targets (macOS arm64, macOS x64, Windows x64,
Linux x64). Before any artifact is uploaded, a verification step byte-scans every bundled
`ffmpeg`/`ffprobe` for the forbidden `--enable-gpl`/`--enable-nonfree` build flags and fails the job
if it finds them, so only redistributable LGPL binaries can ever leave the runner (see
[Licenses](#licenses) below). On a `v*` tag, a final job publishes those artifacts to a **draft**
GitHub Release; a human runs the [manual smoke check](#manual-smoke-check-before-release) and then
presses publish.

If you want to test a packaged build yourself, build it locally — see
[Building from source](#building-from-source) above; `npm run build` followed by
`npx electron-builder` (with the flags for your platform, e.g. `--mac --arm64`) produces the same
installer the workflow would. Packaging checks every bundled executable against the requested
platform and architecture before it starts (and re-runs the license byte-scan), so a
cross-architecture command fails rather than silently producing an installer with
host-architecture media tools.

### Manual smoke check before release

CI proves the app builds and packages on all four targets; it does not prove a packaged artifact
actually transcribes on a real machine. (This is not hypothetical — code review once caught this
exact workflow silently packaging an arm64 `ffmpeg` into the macOS x64 build, which would have
installed, launched, and looked perfect while every transcription failed.) Once release artifacts
are being produced again, before treating a build as release-ready, a human should, **for each of
the four artifacts** (macOS arm64, macOS x64, Windows x64, Linux x64):

1. Build (or otherwise obtain) that platform's installer.
2. Install it the way an end user would — see the platform instructions above, including the
   unsigned-app walkthrough (macOS System Settings path, Windows SmartScreen "Run anyway", or
   `apt install ./whisper-drop_*.deb` / the AppImage directly on Linux).
3. Launch it and drop in one real audio or video file.
4. Confirm it transcribes successfully end to end — the app opening is not enough; the point is to
   catch a failure that only shows up once ffmpeg or whisper-cli actually runs.

Ideally do this on real hardware per architecture, especially for macOS x64 — a VM or Rosetta can
mask exactly the arch-mismatch failure this check exists to catch.

## Licenses

whisper-drop itself is [MIT licensed](LICENSE) — Copyright (c) 2026 Ben Junya. Do what you like
with it.

It bundles two other projects to do the actual work, and credits both in an in-app **Licenses**
screen (open it from the header) as well as here:

- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)**, MIT licensed. Built from source at a
  pinned tag and bundled as its own executable — whisper-drop spawns it as a child process, it
  isn't linked into the app.
- **ffmpeg** (and `ffprobe`), used to read your media file and pull out its audio. whisper-drop
  bundles a **redistributable LGPL build** — configured without `--enable-gpl` or `--enable-nonfree`
  — and invokes it as a separate executable, linking against no part of it. The binaries are sourced
  per platform: on macOS, compiled from FFmpeg's tagged source (see `ffmpeg.manifest.json` and
  `scripts/build-ffmpeg.mjs`); on Windows and Linux, [BtbN's published LGPL static
  build](https://github.com/BtbN/FFmpeg-Builds), pinned by checksum. The corresponding source and
  exact build configuration are available from those same references, which satisfies
  [ffmpeg's LGPL terms](https://ffmpeg.org/legal.html). Every binary's embedded configuration is
  byte-scanned for the forbidden flags at pack time, so a non-redistributable build can never ship.

### Publishing releases — resolved

The redistribution blocker earlier versions of this section described is resolved. whisper-drop now
bundles a **redistributable LGPL ffmpeg build** (option 1 — an LGPL build without `--enable-gpl` or
`--enable-nonfree`), so there is no nonfree binary to withhold: macOS is compiled from FFmpeg's
tagged source with an LGPL configuration, and Windows and Linux use BtbN's checksum-pinned LGPL
static builds. `scripts/verify-release-binaries.mjs` byte-scans every bundled binary for the
forbidden flags and fails both local packaging and the release workflow if any appear, so the
guarantee is enforced automatically rather than by inspection.

## Built by Human Balance AI

whisper-drop is built and maintained by [Human Balance AI](https://humanbalanceai.com). The app
itself carries no branding — it's a plain, unbranded tool, free for anyone to use.
