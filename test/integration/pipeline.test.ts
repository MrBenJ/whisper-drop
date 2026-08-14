import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractWav } from '../../src/main/media/extract.js'
import { format } from '../../src/main/export/formatters.js'
import { TranscriptionJob } from '../../src/main/jobs/transcription-job.js'
import { probe } from '../../src/main/media/probe.js'
import { runWhisper } from '../../src/main/whisper/runner.js'
import type { JobPhase } from '../../src/shared/types.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const MODEL = fileURLToPath(new URL('../../.cache/models/ggml-tiny.bin', import.meta.url))

let workDir: string

beforeAll(async () => {
  expect(existsSync(MODEL), 'run `npm run test:integration` so the tiny model is downloaded').toBe(true)
  workDir = await mkdtemp(join(tmpdir(), 'whisper-drop-'))
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function makeJob(filePath: string, id: string) {
  return new TranscriptionJob(
    {
      probe: (path) => probe(path),
      extract: (options) => extractWav(options),
      run: (options, onSegment) =>
        runWhisper({
          wavPath: options.wavPath,
          modelPath: options.modelPath,
          language: options.language,
          onSegment,
          signal: options.signal,
        }),
      tempWavPath: (jobId) => join(workDir, `${jobId}.wav`),
      removeFile: (path) => rm(path, { force: true }),
      now: () => Date.now(),
    },
    { id, filePath, modelPath: MODEL, language: 'en' },
  )
}

describe('probe against real ffprobe', () => {
  it('reads duration and audio presence from the wav fixture', async () => {
    const info = await probe(join(FIXTURES, 'hello.wav'))
    expect(info.hasAudio).toBe(true)
    expect(info.durationMs).toBeGreaterThan(500)
  })

  it('reads the mp4 fixture as having audio', async () => {
    const info = await probe(join(FIXTURES, 'hello.mp4'))
    expect(info.hasAudio).toBe(true)
  })

  it('rejects a non-media file with UNREADABLE_MEDIA', async () => {
    await expect(
      probe(fileURLToPath(new URL('../../package.json', import.meta.url))),
    ).rejects.toMatchObject({ code: 'UNREADABLE_MEDIA' })
  })
})

describe('full pipeline', () => {
  it('transcribes the wav fixture', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'wav-job')
    await job.start()

    expect(job.state.phase).toBe('done')
    expect(format(job.state.segments, 'txt').toLowerCase()).toContain('testing')
  })

  it('transcribes the mp4 fixture, proving video audio extraction works', async () => {
    const job = makeJob(join(FIXTURES, 'hello.mp4'), 'mp4-job')
    await job.start()

    expect(job.state.phase).toBe('done')
    expect(format(job.state.segments, 'txt').toLowerCase()).toContain('testing')
  })

  it('progresses through every phase in order', async () => {
    const phases: JobPhase[] = []
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'phase-job')
    job.subscribe((state) => {
      if (phases.at(-1) !== state.phase) phases.push(state.phase)
    })
    await job.start()

    expect(phases).toEqual(['probing', 'preparing', 'transcribing', 'done'])
  })

  it('produces a well-formed srt', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'srt-job')
    await job.start()

    const srt = format(job.state.segments, 'srt')
    expect(srt.startsWith('1\n')).toBe(true)
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/)
  })

  it('produces a well-formed vtt', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'vtt-job')
    await job.start()

    const vtt = format(job.state.segments, 'vtt')
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)
  })

  it('deletes the temp wav when the job completes', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'cleanup-job')
    await job.start()
    expect(existsSync(join(workDir, 'cleanup-job.wav'))).toBe(false)
  })

  it('records a realtime factor above zero', async () => {
    const job = makeJob(join(FIXTURES, 'hello.wav'), 'rtf-job')
    await job.start()
    expect(job.state.realtimeFactor).toBeGreaterThan(0)
  })

  it('cancels a running job and cleans up', async () => {
    const job = makeJob(join(FIXTURES, 'hello.mp4'), 'cancel-job')
    const started = job.start()
    job.cancel()
    await started

    expect(job.state.phase).toBe('cancelled')
    expect(existsSync(join(workDir, 'cancel-job.wav'))).toBe(false)
  })
})
