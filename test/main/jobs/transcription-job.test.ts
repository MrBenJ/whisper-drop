import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptionJob, type JobDeps } from '../../../src/main/jobs/transcription-job.js'
import { AppError } from '../../../src/shared/errors.js'
import type { JobPhase, MediaInfo, Segment } from '../../../src/shared/types.js'

const MEDIA: MediaInfo = {
  path: '/tmp/in.mp4',
  durationMs: 100_000,
  hasAudio: true,
  container: 'mov,mp4',
}

const SEGMENTS: Segment[] = [
  { index: 0, startMs: 0, endMs: 50_000, text: 'First half.' },
  { index: 1, startMs: 50_000, endMs: 100_000, text: 'Second half.' },
]

function makeDeps(overrides: Partial<JobDeps> = {}): JobDeps {
  let clock = 0
  return {
    probe: async () => MEDIA,
    extract: async () => {},
    run: async (_options, onSegment) => {
      for (const segment of SEGMENTS) onSegment(segment)
      return SEGMENTS
    },
    tempWavPath: (id) => `/tmp/${id}.wav`,
    removeFile: async () => {},
    now: () => (clock += 1_000),
    ...overrides,
  }
}

function makeJob(deps: Partial<JobDeps> = {}) {
  return new TranscriptionJob(makeDeps(deps), {
    id: 'job-1',
    filePath: '/tmp/in.mp4',
    modelPath: '/models/ggml-tiny.bin',
    language: 'en',
  })
}

describe('TranscriptionJob', () => {
  let phases: JobPhase[]

  beforeEach(() => {
    phases = []
  })

  it('moves through probing, preparing, transcribing and done', async () => {
    const job = makeJob()
    // Each phase emits several updates as progress advances; collapse runs so
    // this asserts the phase order, not the notification count.
    job.subscribe((state) => {
      if (phases.at(-1) !== state.phase) phases.push(state.phase)
    })
    await job.start()
    expect(phases).toEqual(['probing', 'preparing', 'transcribing', 'done'])
  })

  it('ends at progress 1 with the segments attached', async () => {
    const job = makeJob()
    await job.start()
    expect(job.state.progress).toBe(1)
    expect(job.state.segments).toEqual(SEGMENTS)
  })

  it('caps the preparing phase at the 0.08 band boundary', async () => {
    const progresses: number[] = []
    const job = makeJob({
      extract: async ({ onProgress }) => {
        onProgress(0.5)
        onProgress(1)
      },
      run: async () => [],
    })
    job.subscribe((state) => {
      if (state.phase === 'preparing') progresses.push(state.progress)
    })
    await job.start()
    // 0.02 on entering the phase, then the two reported fractions mapped into
    // the 0.02-0.08 band.
    expect(progresses).toEqual([0.02, 0.05, 0.08])
  })

  it('maps transcription progress into the 0.08 to 1 band', async () => {
    const progresses: number[] = []
    const job = makeJob()
    job.subscribe((state) => {
      if (state.phase === 'transcribing') progresses.push(state.progress)
    })
    await job.start()
    // 0.08 on entering, then segments ending at 50s and 100s of a 100s file.
    expect(progresses).toEqual([0.08, 0.08 + 0.92 * 0.5, 1])
  })

  it('withholds the ETA until transcription reaches ten percent', async () => {
    const etas: (number | undefined)[] = []
    const job = makeJob({
      run: async (_options, onSegment) => {
        onSegment({ index: 0, startMs: 0, endMs: 5_000, text: 'early' }) // 5%
        onSegment({ index: 1, startMs: 5_000, endMs: 50_000, text: 'later' }) // 50%
        return []
      },
    })
    job.subscribe((state) => {
      if (state.phase === 'transcribing') etas.push(state.etaMs)
    })
    await job.start()
    expect(etas[0]).toBeUndefined() // entering the phase
    expect(etas[1]).toBeUndefined() // 5%, below the threshold
    expect(etas[2]).toBeGreaterThan(0) // 50%
  })

  it('records a realtime factor on completion', async () => {
    const job = makeJob()
    await job.start()
    expect(job.state.realtimeFactor).toBeGreaterThan(0)
  })

  it('fails with NO_AUDIO_STREAM when the file has no audio', async () => {
    const job = makeJob({ probe: async () => ({ ...MEDIA, hasAudio: false }) })
    await job.start()
    expect(job.state.phase).toBe('failed')
    expect(job.state.error?.code).toBe('NO_AUDIO_STREAM')
  })

  it('never runs whisper when the file has no audio', async () => {
    const run = vi.fn(async () => [] as Segment[])
    const job = makeJob({ probe: async () => ({ ...MEDIA, hasAudio: false }), run })
    await job.start()
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates the error code from a failing extract', async () => {
    const job = makeJob({
      extract: async () => {
        throw new AppError('FFMPEG_FAILED', "Couldn't prepare the audio.", 'exit 1')
      },
    })
    await job.start()
    expect(job.state.phase).toBe('failed')
    expect(job.state.error).toEqual({
      code: 'FFMPEG_FAILED',
      message: "Couldn't prepare the audio.",
      detail: 'exit 1',
    })
  })

  it('wraps a non-AppError failure as WHISPER_FAILED', async () => {
    const job = makeJob({
      run: async () => {
        throw new Error('kaboom')
      },
    })
    await job.start()
    expect(job.state.error?.code).toBe('WHISPER_FAILED')
    expect(job.state.error?.detail).toContain('kaboom')
  })

  it('deletes the temp wav after success', async () => {
    const removeFile = vi.fn(async () => {})
    const job = makeJob({ removeFile })
    await job.start()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('deletes the temp wav after failure', async () => {
    const removeFile = vi.fn(async () => {})
    const job = makeJob({
      removeFile,
      run: async () => {
        throw new Error('kaboom')
      },
    })
    await job.start()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('cancels during preparing, skips whisper and cleans up', async () => {
    const removeFile = vi.fn(async () => {})
    const run = vi.fn(async () => [] as Segment[])
    let job!: TranscriptionJob
    job = makeJob({
      removeFile,
      run,
      extract: async ({ signal }) => {
        job.cancel()
        if (signal.aborted) throw new Error('aborted')
      },
    })
    await job.start()

    expect(job.state.phase).toBe('cancelled')
    expect(run).not.toHaveBeenCalled()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('cancels during transcribing and cleans up', async () => {
    const removeFile = vi.fn(async () => {})
    let job!: TranscriptionJob
    job = makeJob({
      removeFile,
      run: async (_options, _onSegment) => {
        job.cancel()
        throw new Error('aborted')
      },
    })
    await job.start()

    expect(job.state.phase).toBe('cancelled')
    expect(job.state.error).toBeUndefined()
    expect(removeFile).toHaveBeenCalledWith('/tmp/job-1.wav')
  })

  it('reports cancellation rather than an error when both happen', async () => {
    let job!: TranscriptionJob
    job = makeJob({
      run: async () => {
        job.cancel()
        throw new AppError('WHISPER_FAILED', 'killed', 'SIGKILL')
      },
    })
    await job.start()
    expect(job.state.phase).toBe('cancelled')
    expect(job.state.error).toBeUndefined()
  })

  it('stops notifying a listener after it unsubscribes', async () => {
    const listener = vi.fn()
    const job = makeJob()
    const unsubscribe = job.subscribe(listener)
    unsubscribe()
    await job.start()
    expect(listener).not.toHaveBeenCalled()
  })

  it('hands listeners a snapshot that later mutation cannot change', async () => {
    const snapshots: number[] = []
    const job = makeJob()
    job.subscribe((state) => snapshots.push(state.segments.length))
    await job.start()
    expect(snapshots[0]).toBe(0)
    expect(snapshots.at(-1)).toBe(2)
  })
})
