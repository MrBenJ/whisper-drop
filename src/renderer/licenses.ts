/**
 * What the Licenses screen renders. Pure data, no imports: the renderer
 * fetches nothing, so every word shown has to be here at build time.
 *
 * `url` is displayed as selectable text, never as a link — the window denies
 * navigation and refuses to open new ones, so an anchor would be dead chrome.
 */
export type LicenseEntry = {
  name: string
  /** The exact version that ships, where a version is meaningful. */
  version?: string
  license: string
  url: string
  /** One sentence: what it does here, and how it is bound in. */
  note: string
}

export const LICENSES: readonly LicenseEntry[] = [
  {
    name: 'whisper-drop',
    license: 'MIT',
    url: 'https://github.com/MrBenJ/whisper-drop',
    note: 'This app. Copyright (c) 2026 Ben Junya. Built by Human Balance AI.',
  },
  {
    name: 'whisper.cpp',
    version: 'v1.9.2',
    license: 'MIT',
    url: 'https://github.com/ggml-org/whisper.cpp',
    note: 'Runs the Whisper model on your machine. Built from source at the pinned tag and bundled as a separate executable.',
  },
  {
    name: 'FFmpeg (ffmpeg and ffprobe)',
    // Verified by running the bundled ffmpeg binary's `-version`: its
    // configuration line includes --enable-gpl --enable-version3
    // --enable-nonfree, i.e. a GPL/nonfree build, not LGPL.
    license: 'GPL-2.0-or-later, built with --enable-nonfree',
    url: 'https://ffmpeg.org/legal.html',
    note: "Reads your file and converts its audio. Bundled via the ffmpeg-static and ffprobe-static packages and invoked as separate executables — this app links against no part of it. That answers the LGPL linking question, but not the fact that the bundled binary is a nonfree build: under ffmpeg's own terms, binaries built with --enable-nonfree may not be redistributed at all. That is why this repo does not publish release artifacts today — see \"Before publishing releases\" in the README.",
  },
  {
    name: 'Electron',
    version: '43',
    license: 'MIT',
    url: 'https://github.com/electron/electron',
    note: 'The application shell.',
  },
  {
    name: 'React',
    version: '19',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
    note: 'The user interface.',
  },
]
