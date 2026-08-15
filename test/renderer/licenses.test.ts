import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LICENSES } from '../../src/renderer/licenses.js'

describe('the licence data', () => {
  it('credits every bundled project the app ships or runs', () => {
    expect(LICENSES.map((entry) => entry.name)).toEqual([
      'whisper-drop',
      'whisper.cpp',
      'FFmpeg (ffmpeg and ffprobe)',
      'Electron',
      'React',
    ])
  })

  it('gives every entry a licence, a source URL and a note', () => {
    for (const entry of LICENSES) {
      expect(entry.license.length, entry.name).toBeGreaterThan(0)
      expect(entry.url, entry.name).toMatch(/^https:\/\//)
      expect(entry.note.length, entry.name).toBeGreaterThan(0)
    }
  })

  it('says ffmpeg is invoked as a separate executable, which is the licence position', () => {
    const ffmpeg = LICENSES.find((entry) => entry.name.startsWith('FFmpeg'))
    expect(ffmpeg?.note).toMatch(/separate executable/i)
  })

  // The version shown has to be the version that ships. Nothing else in the
  // renderer can read the manifest, so this is the only thing keeping the two
  // in step when the tag is bumped.
  it('shows the whisper.cpp tag that whisper.manifest.json actually pins', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../whisper.manifest.json', import.meta.url)), 'utf8'),
    ) as { whisperCppTag: string }

    expect(LICENSES.find((entry) => entry.name === 'whisper.cpp')?.version).toBe(
      manifest.whisperCppTag,
    )
  })
})
