import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { candidatePath, saveTranscript } from '../../../src/main/export/save.js'
import type { Segment } from '../../../src/shared/types.js'

const SEGMENTS: Segment[] = [
  { index: 0, startMs: 0, endMs: 2_000, text: 'Hello there.' },
  { index: 1, startMs: 2_000, endMs: 4_500, text: 'This is a test.' },
]

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whisper-drop-save-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('candidatePath', () => {
  it('swaps the extension for the export format', () => {
    expect(candidatePath('/videos/interview.mp4', 'srt', 1)).toBe('/videos/interview.srt')
  })

  it('appends " (2)" for the second attempt', () => {
    expect(candidatePath('/videos/interview.mp4', 'srt', 2)).toBe('/videos/interview (2).srt')
  })

  it('keeps counting past two', () => {
    expect(candidatePath('/videos/interview.mp4', 'txt', 7)).toBe('/videos/interview (7).txt')
  })

  it('handles a source file with no extension', () => {
    expect(candidatePath('/videos/memo', 'txt', 1)).toBe('/videos/memo.txt')
  })

  it('strips only the last extension of a double extension', () => {
    expect(candidatePath('/videos/archive.tar.gz', 'txt', 1)).toBe('/videos/archive.tar.txt')
  })

  it('keeps a name that already contains a bracketed number', () => {
    expect(candidatePath('/videos/take (2).mp4', 'srt', 1)).toBe('/videos/take (2).srt')
    expect(candidatePath('/videos/take (2).mp4', 'srt', 2)).toBe('/videos/take (2) (2).srt')
  })
})

describe('saveTranscript', () => {
  it('writes next to the source file with the same basename', async () => {
    const path = await saveTranscript({
      segments: SEGMENTS,
      sourcePath: join(dir, 'interview.mp4'),
      as: 'srt',
    })

    expect(path).toBe(join(dir, 'interview.srt'))
    expect(await readFile(path, 'utf8')).toContain('00:00:00,000 --> 00:00:02,000')
  })

  it('writes the format the caller asked for', async () => {
    const source = join(dir, 'a.wav')

    expect(await readFile(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'txt' }), 'utf8'))
      .toBe('Hello there.\nThis is a test.\n')
    expect(await readFile(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'vtt' }), 'utf8'))
      .toContain('WEBVTT')
  })

  it('appends " (2)" rather than overwriting an existing file', async () => {
    const source = join(dir, 'interview.mp4')
    await writeFile(join(dir, 'interview.srt'), 'do not touch me', 'utf8')

    const path = await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'srt' })

    expect(path).toBe(join(dir, 'interview (2).srt'))
    expect(await readFile(join(dir, 'interview.srt'), 'utf8')).toBe('do not touch me')
  })

  it('keeps counting up when " (2)" is also taken', async () => {
    const source = join(dir, 'interview.mp4')
    await writeFile(join(dir, 'interview.srt'), 'x', 'utf8')
    await writeFile(join(dir, 'interview (2).srt'), 'x', 'utf8')

    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'srt' })).toBe(
      join(dir, 'interview (3).srt'),
    )
  })

  it('treats each format separately, so saving all three collides with none', async () => {
    const source = join(dir, 'interview.mp4')

    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'txt' })).toBe(
      join(dir, 'interview.txt'),
    )
    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'srt' })).toBe(
      join(dir, 'interview.srt'),
    )
    expect(await saveTranscript({ segments: SEGMENTS, sourcePath: source, as: 'vtt' })).toBe(
      join(dir, 'interview.vtt'),
    )
  })

  it('writes an empty transcript rather than failing', async () => {
    const path = await saveTranscript({ segments: [], sourcePath: join(dir, 'silent.wav'), as: 'txt' })

    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('propagates a real filesystem error instead of looping', async () => {
    await expect(
      saveTranscript({
        segments: SEGMENTS,
        sourcePath: join(dir, 'missing-folder', 'a.mp4'),
        as: 'txt',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
