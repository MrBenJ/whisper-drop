# Manual testing plan

Everything in this project is verified by machines except the part that matters most:
a real person, on real hardware, putting a real file through a real installed app.
This document is that gap, written down.

**Nothing below has ever been done.** The app has transcribed exactly one file in its
life — a 1-second `hello.mp4` — inside a headless CI container. Treat every checkbox
here as genuinely unknown, not as a formality.

Work top to bottom. The sessions are ordered so that a failure early kills the ones
after it, which saves you the time.

---

## Session 0 — Prerequisites (5 min)

You are testing **the installed app**, not `npm run dev`. Running from source shares
almost none of the risk: the packaged app resolves its binaries from a completely
different path, and that resolution is the single most likely thing to be broken.

```bash
cd whisper-drop
npm run build
npx electron-builder --mac --arm64      # ~2 min; DMG lands in dist/
```

Then **install it like a client would** — open the DMG, drag to Applications, launch
from Applications. Do not run it out of `dist/mac-arm64/`.

- [ ] DMG builds without error
- [ ] App appears in Applications and launches

---

## Session 1 — The unsigned-install wall (10 min)

This is the first thing every client hits, and it is documented from Apple's docs
rather than from anyone actually doing it. If the README is wrong here, a
non-technical client is stopped dead at step one and blames you, not Apple.

Test on a Mac where whisper-drop has **never** been opened. If that's this machine,
clear Gatekeeper's memory of it first:

```bash
sudo xattr -d com.apple.quarantine /Applications/whisper-drop.app 2>/dev/null
xattr -w com.apple.quarantine "0081;00000000;Safari;" /Applications/whisper-drop.app
```

- [ ] Double-clicking produces the blocked dialog
- [ ] The dialog's wording matches what the README quotes
- [ ] The README's System Settings → Privacy & Security → **Open Anyway** path works,
      step for step, with no undocumented step in between
- [ ] After that, the app opens normally on every later launch

**Fail looks like:** the dialog says something else, or Open Anyway doesn't appear, or
it appears but a second dialog follows. Any of those means rewriting the README's
macOS section — for macOS 26, which is what your clients are on now.

---

## Session 2 — First run on an empty profile (15 min)

Simulates a client's very first launch. Wipe the profile first:

```bash
rm -rf ~/Library/Application\ Support/whisper-drop
```

- [ ] The guided model picker appears rather than an empty drop zone
- [ ] Sizes and descriptions read sensibly to someone who has never heard of Whisper
- [ ] The **English only / All languages** toggle visibly swaps what the rows will download
- [ ] With All languages on, a language picker appears in the header
- [ ] Toggling to English only makes it disappear

Now download a model **through the app**, over the real network. This has never
happened — every test to date used a pre-fetched file and a fake HTTP server.

- [ ] Download **Base** (148 MB). Progress advances; it completes; the row flips to installed
- [ ] Download **Large v3 Turbo** (1.6 GB). Same, and check the time is tolerable
- [ ] **Mid-download, turn off Wi-Fi.** You should get a clear network error, not a
      crash and not a checksum error
- [ ] Turn Wi-Fi back on and download again. It should **resume**, not restart from zero
      — watch whether the progress bar picks up near where it stopped
- [ ] Quit the app mid-download, relaunch, download again. Also resumes

**Fail looks like:** a checksum-mismatch error after an interruption (means the resume
logic misclassified a short transfer as corruption), or a resume that silently starts
over (means the `.part` file isn't being found).

---

## Session 3 — Your three real use cases (60 min, mostly waiting)

The whole point of the app. Use genuine files, not test clips.

### 3a. Voice memo (<15 s)

- [ ] Drop a real voice memo. Transcript appears
- [ ] The text is actually right — read it against the audio
- [ ] With **All languages** on, check the auto-detected language. Whisper's
      auto-detect is least reliable on very short clips; if it guesses wrong here,
      that's a real finding and the fix is to default short files to your locale

### 3b. Course video (10–45 min)

- [ ] Drop an actual course recording
- [ ] Progress moves steadily rather than sitting at one number
- [ ] The ETA appears once past the early phase and is roughly honest — note the
      estimate at 20% and compare it to the real finish time
- [ ] Note the wall-clock time and which model you used. **Write it down** — this is
      the first real throughput number the project has ever had
- [ ] Transcript quality is good enough to actually use for course work

### 3c. Consultation recording (90 min) — the important one

This is the longest, most confidential, highest-consequence path, and it is completely
unproven. Use a real 90-minute recording.

- [ ] It completes at all
- [ ] Watch Activity Monitor while it runs: whisper-drop's memory, and whether the
      machine thermally throttles or the fans peg for the duration
- [ ] Check free disk space during the run — the audio is extracted to a temp WAV of
      roughly 170 MB for 90 minutes
- [ ] The transcript is complete — **check the end**, not just the beginning. A
      truncated tail is the failure mode that looks like success
- [ ] Timestamps at the end of a 90-minute file are still accurate (drift shows up late)
- [ ] The app stays responsive throughout; the window doesn't beachball

**While this runs, note the realtime factor the app reports when it finishes.** That
number tells you whether Large v3 is usable for consultations or whether Turbo is the
only practical choice — which is a real product decision you can't make without it.

---

## Session 4 — Exports (15 min)

- [ ] Export **.txt** — opens cleanly, paragraphs readable
- [ ] Export **.srt** — load it into a real video player alongside the source video
      and confirm subtitles land on the right words at the right time
- [ ] Export **.vtt** — same check
- [ ] Copy-to-clipboard puts the full transcript on the clipboard, not a truncated view
- [ ] **Export into a folder you don't have write access to** (e.g. `/`). You should get
      an inline error banner and **the transcript must still be on screen and still
      re-saveable**. Losing a 90-minute transcript to a failed save was a real bug here
      and this is the check that it stayed fixed

---

## Session 5 — Things going wrong (20 min)

Every one of these has a hand-written user-facing message that no user has ever read.
Judge them as a client would: does this tell me what to do next?

- [ ] A **video with no audio track** → clear "no audio" message
- [ ] A **corrupt/truncated media file** → clear unreadable-media message, no crash
- [ ] A **DRM-protected file** (e.g. a purchased .m4v) → fails gracefully
- [ ] A **non-media file** (a PDF renamed to .mp4) → clear error
- [ ] **Cancel mid-transcription** on a long file → stops promptly, returns to a usable
      state, and `whisper-cli` actually disappears from Activity Monitor rather than
      running on invisibly
- [ ] **Cancel, then immediately start the same file again** → works
- [ ] **Let a transcription fail, then press Try again** → actually retries. This path
      was broken twice during development in two different ways
- [ ] **Quit the app mid-transcription**, then check `$TMPDIR` for orphaned
      `whisper-drop-*.wav` files. A 170 MB leak per abandoned job is worth knowing about
- [ ] **Delete the model file** while the app is open, then transcribe → clear
      "model missing" message rather than a raw error

---

## Session 6 — Awkward real-world files (15 min)

Paths are the classic source of "works on my machine". None of these have been tried.

- [ ] Filename with **spaces**
- [ ] Filename with an **apostrophe** (`Ben's session.mp4`) — shell-quoting bugs live here
- [ ] Filename with **non-ASCII / emoji**
- [ ] A file on an **external drive**
- [ ] A file in **iCloud Drive that isn't downloaded locally** (the dataless-file case —
      this one is genuinely likely to misbehave)
- [ ] A file with a very long path
- [ ] Drop **two files at once** → refused clearly, not half-started
- [ ] Drop a second file **while one is transcribing** → refused clearly, not queued
      silently and forgotten

---

## Session 7 — The client's-eyes pass (30 min)

Hand the DMG to someone non-technical — ideally an actual client — and **watch without
helping**. Note every point where they hesitate.

- [ ] They get past the Gatekeeper warning using only the README
- [ ] They pick a model without asking you which one
- [ ] They understand the English-only toggle
- [ ] They find the transcript and get it out of the app
- [ ] They are convinced the audio stays on their machine — the privacy claim is the
      reason they'd trust it with a consultation recording, so it has to land

---

## Session 8 — Other platforms (only if you're shipping beyond Mac)

`release.yml` has **never run once**. No Windows or Linux artifact has ever existed,
and macOS x64 has never been built either. Until one is, treat those three targets as
unwritten rather than untested.

```bash
gh workflow run release.yml     # builds all four targets; retains nothing by design
```

- [ ] The workflow completes green on all four targets
- [ ] Then, per target, do Sessions 1–3a on real hardware

macOS x64 needs a **real Intel Mac**. Rosetta on an Apple Silicon machine masks exactly
the architecture mismatch this check exists to catch — it already happened once.

---

## Blocking issue before any of this reaches a client

The bundled `ffmpeg-static` binary is built `--enable-nonfree`, which FFmpeg's terms say
must not be redistributed at all. Handing a DMG to a client is redistribution.

**Testing it yourself is fine. Giving the artifact to anyone is not, until this is
resolved.** See "Before publishing releases" in the README for the two options.
