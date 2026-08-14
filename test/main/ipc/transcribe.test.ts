import { describe, expect, it, vi } from 'vitest'
import { createTranscribeHandlers, type JobLike } from '../../../src/main/ipc/transcribe.js'
import type { JobInput } from '../../../src/main/jobs/transcription-job.js'
import type { JobPhase, JobState, ModelId, Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

/** A TranscriptionJob stand-in whose phases the test drives by hand. */
function createFakeJob(input: JobInput) {
  const listeners = new Set<(state: JobState) => void>()
  let resolveStart: () => void = () => {}
  let current: JobState = {
    id: input.id,
    filePath: input.filePath,
    phase: 'probing',
    progress: 0,
    segments: [],
  }

  const emit = (patch: Partial<JobState>): void => {
    current = { ...current, ...patch }
    for (const listener of listeners) listener(current)
  }

  const job: JobLike = {
    id: input.id,
    get state() {
      return current
    },
    start: () =>
      new Promise<void>((resolve) => {
        resolveStart = resolve
      }),
    cancel: () => emit({ phase: 'cancelled' }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return { job, input, emit, finishStart: () => resolveStart() }
}

function harness(overrides: Partial<Parameters<typeof createTranscribeHandlers>[0]> = {}) {
  const created: ReturnType<typeof createFakeJob>[] = []
  const states: JobState[] = []
  const recordThroughput = vi.fn(async () => undefined)
  let counter = 0

  const handlers = createTranscribeHandlers({
    newJobId: () => `job-${++counter}`,
    readSettings: async () => SETTINGS,
    modelPathFor: (id: ModelId) => `/models/${id}.bin`,
    isInstalled: async () => true,
    createJob: (input) => {
      const fake = createFakeJob(input)
      created.push(fake)
      return fake.job
    },
    recordThroughput,
    emitState: (state) => states.push(state),
    // Every existing test drops a file "already selected through whisper-drop";
    // the trust-boundary tests below override this explicitly.
    consumeTrustedPath: () => true,
    ...overrides,
  })

  return { handlers, created, states, recordThroughput }
}

const done = (durationMs = 10_000): Partial<JobState> => ({
  phase: 'done' as JobPhase,
  progress: 1,
  realtimeFactor: durationMs / 1_000,
})

describe('transcribe.start', () => {
  it('returns a job id generated in main, not anything the caller supplied', async () => {
    const { handlers, created } = harness()
    const id = await handlers.start('/videos/interview.mp4')

    expect(id).toBe('job-1')
    expect(created[0]?.input.id).toBe('job-1')
  })

  it('passes the dropped path through unchanged — it is the one path from outside', async () => {
    const { handlers, created } = harness()
    await handlers.start('/videos/weird name (1).m4v')

    expect(created[0]?.input.filePath).toBe('/videos/weird name (1).m4v')
  })

  it('rejects a non-string or empty file path', async () => {
    const { handlers } = harness()

    await expect(handlers.start(42)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.start('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.start(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a path main never issued', async () => {
    const { handlers, created } = harness({ consumeTrustedPath: () => false })

    await expect(handlers.start('/etc/passwd')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(created).toHaveLength(0)
  })

  it('accepts a path main issued, and consumes it exactly once', async () => {
    const consumeTrustedPath = vi.fn((path: string) => path === '/videos/interview.mp4')
    const { handlers, created } = harness({ consumeTrustedPath })
    await handlers.start('/videos/interview.mp4')

    expect(created).toHaveLength(1)
    expect(consumeTrustedPath).toHaveBeenCalledWith('/videos/interview.mp4')
  })

  it('resolves the model against the English-only toggle', async () => {
    const { handlers, created } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    await handlers.start('/a.wav')

    expect(created[0]?.input.modelPath).toBe('/models/base.en.bin')
  })

  it('forces language to en while English-only is on', async () => {
    const { handlers, created } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true, language: 'fr' }),
    })
    await handlers.start('/a.wav')

    expect(created[0]?.input.language).toBe('en')
  })

  it('passes the chosen language through when English-only is off', async () => {
    const { handlers, created } = harness({
      readSettings: async () => ({ ...SETTINGS, language: 'fr' }),
    })
    await handlers.start('/a.wav')

    expect(created[0]?.input.language).toBe('fr')
  })

  it('refuses with NO_MODEL_INSTALLED when no model is chosen', async () => {
    const { handlers } = harness({ readSettings: async () => ({ ...SETTINGS, activeModel: null }) })

    await expect(handlers.start('/a.wav')).rejects.toMatchObject({ code: 'NO_MODEL_INSTALLED' })
  })

  it('refuses with MODEL_FILE_MISSING when the resolved model is not on disk', async () => {
    const { handlers } = harness({ isInstalled: async () => false })

    await expect(handlers.start('/a.wav')).rejects.toMatchObject({ code: 'MODEL_FILE_MISSING' })
  })

  it('refuses a second job while one is running', async () => {
    const { handlers } = harness()
    await handlers.start('/a.wav')

    await expect(handlers.start('/b.wav')).rejects.toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
    })
  })

  it('refuses a second job that races the first across its first await', async () => {
    const { handlers, created } = harness()
    const results = await Promise.allSettled([handlers.start('/a.wav'), handlers.start('/b.wav')])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(created).toHaveLength(1)
  })

  it('allows a new job once the previous one finishes', async () => {
    const { handlers, created } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit(done())

    await expect(handlers.start('/b.wav')).resolves.toBe('job-2')
  })

  it('allows a new job once the previous one is cancelled', async () => {
    const { handlers } = harness()
    const id = await handlers.start('/a.wav')
    await handlers.cancel(id)

    await expect(handlers.start('/b.wav')).resolves.toBe('job-2')
  })

  it('allows a new job once the previous one fails', async () => {
    const { handlers, created } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit({ phase: 'failed', error: { code: 'WHISPER_FAILED', message: 'boom' } })

    await expect(handlers.start('/b.wav')).resolves.toBe('job-2')
  })

  it('forwards every state update to the renderer', async () => {
    const { handlers, created, states } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit({ phase: 'transcribing', progress: 0.5 })

    expect(states.at(-1)).toMatchObject({ phase: 'transcribing', progress: 0.5 })
  })

  it('records measured throughput against the resolved model id on completion', async () => {
    const { handlers, created, recordThroughput } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    await handlers.start('/a.wav')
    created[0]?.emit(done(12_000))

    expect(recordThroughput).toHaveBeenCalledWith('base.en', 12)
  })

  it('records throughput once, not on every later update', async () => {
    const { handlers, created, recordThroughput } = harness()
    await handlers.start('/a.wav')
    created[0]?.emit(done())
    created[0]?.emit(done())

    expect(recordThroughput).toHaveBeenCalledTimes(1)
  })

  it('does not record throughput for a cancelled or failed job', async () => {
    const { handlers, recordThroughput } = harness()
    const id = await handlers.start('/a.wav')
    await handlers.cancel(id)

    expect(recordThroughput).not.toHaveBeenCalled()
  })

  it('survives a throughput write that rejects', async () => {
    const { handlers, created } = harness({
      recordThroughput: async () => {
        throw new Error('disk full')
      },
    })
    await handlers.start('/a.wav')

    expect(() => created[0]?.emit(done())).not.toThrow()
  })
})

describe('transcribe.cancel', () => {
  it('cancels a known job', async () => {
    const { handlers, created } = harness()
    const id = await handlers.start('/a.wav')
    await handlers.cancel(id)

    expect(created[0]?.job.state.phase).toBe('cancelled')
  })

  it('rejects an unknown job id rather than treating it as anything else', async () => {
    const { handlers } = harness()
    await handlers.start('/a.wav')

    await expect(handlers.cancel('job-999')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a path-shaped job id', async () => {
    const { handlers } = harness()

    await expect(handlers.cancel('../../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects a non-string job id', async () => {
    const { handlers } = harness()

    await expect(handlers.cancel({ id: 'job-1' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe('transcribe.stateOf', () => {
  it('returns the state of a known job', async () => {
    const { handlers } = harness()
    const id = await handlers.start('/a.wav')

    expect(handlers.stateOf(id)?.filePath).toBe('/a.wav')
  })

  it('returns undefined for an unknown job', () => {
    const { handlers } = harness()

    expect(handlers.stateOf('nope')).toBeUndefined()
  })

  it('forgets the previous job once a new one starts, so nothing accumulates', async () => {
    const { handlers, created } = harness()
    const first = await handlers.start('/a.wav')
    created[0]?.emit(done())
    await handlers.start('/b.wav')

    expect(handlers.stateOf(first)).toBeUndefined()
  })
})

describe('transcribe.cancelActive', () => {
  it('cancels the running job and waits for its cleanup to finish', async () => {
    const { handlers, created } = harness()
    await handlers.start('/a.wav')

    let settled = false
    const quit = handlers.cancelActive().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(created[0]?.job.state.phase).toBe('cancelled')
    expect(settled).toBe(false)

    created[0]?.finishStart()
    await quit
    expect(settled).toBe(true)
  })

  it('resolves immediately when nothing is running', async () => {
    const { handlers } = harness()

    await expect(handlers.cancelActive()).resolves.toBeUndefined()
  })
})
