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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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
    hasTrustedPath: () => true,
    consumeTrustedPath: () => {},
    issueTrustedPath: () => {},
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
    const { handlers, created } = harness({ hasTrustedPath: () => false })

    await expect(handlers.start('/etc/passwd')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(created).toHaveLength(0)
  })

  it('accepts a path main issued, and consumes it exactly once', async () => {
    // A minimal stand-in for the real trusted-paths registry: hasTrustedPath
    // stays true only until consumeTrustedPath actually removes the entry.
    const trusted = new Set(['/videos/interview.mp4'])
    const hasTrustedPath = vi.fn((path: string) => trusted.has(path))
    const consumeTrustedPath = vi.fn((path: string) => {
      trusted.delete(path)
    })
    const { handlers, created } = harness({ hasTrustedPath, consumeTrustedPath })
    await handlers.start('/videos/interview.mp4')

    expect(created).toHaveLength(1)
    expect(consumeTrustedPath).toHaveBeenCalledWith('/videos/interview.mp4')
    expect(consumeTrustedPath).toHaveBeenCalledTimes(1)

    // Proves consume actually spent the entry, not just that it was called.
    await expect(handlers.start('/videos/interview.mp4')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('leaves the path usable for a retry when a later check rejects the request', async () => {
    // Mirrors a fresh profile: defaultSettings() sets activeModel: null, so a
    // brand-new install's very first drop must not burn its own path.
    const trusted = new Set(['/a.wav'])
    let settings: Settings = { ...SETTINGS, activeModel: null }
    const { handlers, created } = harness({
      hasTrustedPath: (path) => trusted.has(path),
      consumeTrustedPath: (path) => {
        trusted.delete(path)
      },
      readSettings: async () => settings,
    })

    await expect(handlers.start('/a.wav')).rejects.toMatchObject({ code: 'NO_MODEL_INSTALLED' })
    expect(trusted.has('/a.wav')).toBe(true)

    // Once a model is chosen, the very same path — never re-selected — works.
    settings = SETTINGS
    await expect(handlers.start('/a.wav')).resolves.toBe('job-1')
    expect(created).toHaveLength(1)
  })

  it('re-issues the trusted path when the job it started ends in failure, so a retry is legitimate (I2)', async () => {
    const trusted = new Set(['/a.wav'])
    const hasTrustedPath = vi.fn((path: string) => trusted.has(path))
    const consumeTrustedPath = vi.fn((path: string) => {
      trusted.delete(path)
    })
    const issueTrustedPath = vi.fn((path: string) => {
      trusted.add(path)
    })
    const { handlers, created } = harness({ hasTrustedPath, consumeTrustedPath, issueTrustedPath })

    await handlers.start('/a.wav')
    expect(trusted.has('/a.wav')).toBe(false) // spent by the successful start

    created[0]?.emit({ phase: 'failed', error: { code: 'WHISPER_FAILED', message: 'boom' } })

    expect(issueTrustedPath).toHaveBeenCalledWith('/a.wav')
    expect(trusted.has('/a.wav')).toBe(true) // re-issued, not left spent

    // The identical path, never re-selected through the dialog or a drop,
    // is now legitimately usable again.
    await expect(handlers.start('/a.wav')).resolves.toBe('job-2')
    expect(created).toHaveLength(2)
  })

  it('does not re-issue the trusted path when the job is cancelled rather than failed', async () => {
    const trusted = new Set(['/a.wav'])
    const hasTrustedPath = vi.fn((path: string) => trusted.has(path))
    const consumeTrustedPath = vi.fn((path: string) => {
      trusted.delete(path)
    })
    const issueTrustedPath = vi.fn((path: string) => {
      trusted.add(path)
    })
    const { handlers, created } = harness({ hasTrustedPath, consumeTrustedPath, issueTrustedPath })

    const id = await handlers.start('/a.wav')
    await handlers.cancel(id)

    expect(issueTrustedPath).not.toHaveBeenCalled()
    expect(trusted.has('/a.wav')).toBe(false)
    expect(created).toHaveLength(1)
  })

  it('does not re-issue the trusted path when the job finishes successfully', async () => {
    const trusted = new Set(['/a.wav'])
    const hasTrustedPath = vi.fn((path: string) => trusted.has(path))
    const consumeTrustedPath = vi.fn((path: string) => {
      trusted.delete(path)
    })
    const issueTrustedPath = vi.fn((path: string) => {
      trusted.add(path)
    })
    const { handlers, created } = harness({ hasTrustedPath, consumeTrustedPath, issueTrustedPath })

    await handlers.start('/a.wav')
    created[0]?.emit(done())

    expect(issueTrustedPath).not.toHaveBeenCalled()
    expect(trusted.has('/a.wav')).toBe(false)
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
    const { handlers, created, recordThroughput } = harness()
    await handlers.start('/a.wav')
    // realtimeFactor is set deliberately, so it's the phase check — not the
    // `realtimeFactor !== undefined` guard alone — that has to reject this.
    created[0]?.emit({ phase: 'cancelled', realtimeFactor: 5 })

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

  it('waits out a start() that has not reached job.start() yet, rather than racing it', async () => {
    const gate = deferred<void>()
    const { handlers, created } = harness({
      readSettings: async () => {
        await gate.promise
        return SETTINGS
      },
    })

    const starting = handlers.start('/a.wav')

    let settled = false
    const quit = handlers.cancelActive().then(() => {
      settled = true
    })

    // start() is still stuck inside readSettings: no job exists yet, so the
    // old implementation would have resolved cancelActive here regardless.
    await Promise.resolve()
    expect(created).toHaveLength(0)
    expect(settled).toBe(false)

    gate.resolve()
    await starting

    // The job now exists; cancelActive should have moved on to cancel it and
    // wait for its cleanup, exactly like the "running job" case above.
    await Promise.resolve()
    expect(created[0]?.job.state.phase).toBe('cancelled')
    expect(settled).toBe(false)

    created[0]?.finishStart()
    await quit
    expect(settled).toBe(true)
  })
})
