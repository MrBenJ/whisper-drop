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
    license: 'LGPL-2.1-or-later, and GPL-2.0-or-later for the bundled builds',
    url: 'https://ffmpeg.org/download.html',
    note: 'Reads your file and converts its audio. Bundled via the ffmpeg-static and ffprobe-static packages and invoked as separate executables — this app links against no part of it.',
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
