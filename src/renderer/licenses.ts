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
    // Verified against the bundled binaries' embedded configuration: no
    // --enable-gpl and no --enable-nonfree, i.e. a plain LGPL build.
    license: 'LGPL-2.1-or-later',
    url: 'https://ffmpeg.org/legal.html',
    note: "Reads your file and converts its audio to the format the transcriber needs. whisper-drop bundles a redistributable LGPL build — configured without --enable-gpl or --enable-nonfree — and invokes it as a separate executable, linking against no part of it. The corresponding source and exact build configuration are available: on macOS it is compiled from FFmpeg's tagged source (see ffmpeg.manifest.json and scripts/build-ffmpeg.mjs in the repository); on Windows and Linux it is BtbN's published LGPL static build (github.com/BtbN/FFmpeg-Builds).",
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
  {
    name: 'Lato',
    license: 'SIL OFL 1.1',
    url: 'https://fonts.google.com/specimen/Lato',
    note: 'The interface typeface, bundled locally. Nothing is fetched from Google Fonts at runtime.',
  },
  {
    name: 'Josefin Sans',
    license: 'SIL OFL 1.1',
    url: 'https://fonts.google.com/specimen/Josefin+Sans',
    note: 'The heading typeface, bundled locally. Nothing is fetched from Google Fonts at runtime.',
  },
]
