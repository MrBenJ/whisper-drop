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
3. The first time you open it, **don't just double-click it** — macOS will refuse with
   *"Apple could not verify that whisper-drop is free of malware"* and offer no way past that
   dialog. Instead:
   - Open **Applications** in Finder.
   - **Right-click** (or Control-click) **whisper-drop**, and choose **Open** from the menu.
   - A similar warning appears, but this time with an **Open** button. Click it.
4. From then on, opening it normally (double-click, Spotlight, the Dock) works like any other app.
   You only do the right-click dance once.

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
- **`.deb`**: `sudo dpkg -i whisper-drop_*.deb` on Debian/Ubuntu-family distributions.

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

```bash
git clone https://github.com/MrBenJ/whisper-drop.git
cd whisper-drop
npm install
npm run setup   # builds whisper.cpp for your platform — this is the step that needs cmake
npm run dev     # launches the app
```

`npm run setup` clones a pinned tag of [whisper.cpp](https://github.com/ggml-org/whisper.cpp) into
`.cache/` and compiles it locally; that build step is what `cmake` is for. It only needs to run
once, or again after a `whisper.manifest.json` version bump.

Other useful commands, once set up:

```bash
npm test          # unit tests
npm run typecheck # TypeScript, main and renderer
npm run build     # production build, into out/
npm run test:e2e  # an end-to-end pass through the real app
```

## Licenses

whisper-drop itself is [MIT licensed](LICENSE) — Copyright (c) 2026 Ben Junya. Do what you like
with it.

It bundles two other projects to do the actual work, and credits both in an in-app **Licenses**
screen (open it from the header) as well as here:

- **[whisper.cpp](https://github.com/ggml-org/whisper.cpp)**, MIT licensed. Built from source at a
  pinned tag and bundled as its own executable — whisper-drop spawns it as a child process, it
  isn't linked into the app.
- **ffmpeg** (and `ffprobe`), used to read your media file and pull out its audio, under
  [ffmpeg's own licence](https://ffmpeg.org/legal.html) (LGPL/GPL depending on build). Like
  whisper.cpp, it's invoked as a separate executable rather than linked against, which is the
  licence position this app relies on.

## Built by Human Balance AI

whisper-drop is built and maintained by [Human Balance AI](https://humanbalanceai.com). The app
itself carries no branding — it's a plain, unbranded tool, free for anyone to use.
