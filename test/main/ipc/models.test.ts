import { describe, expect, it, vi } from 'vitest'
import { createModelHandlers, type ModelsDeps } from '../../../src/main/ipc/models.js'
import type { DownloadProgress, ModelId, Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (cause: unknown) => void }

function deferred(): Deferred {
  let resolve: () => void = () => {}
  let reject: (cause: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(overrides: Partial<ModelsDeps> = {}) {
  const installs: { id: ModelId; signal: AbortSignal; onProgress: (p: DownloadProgress) => void }[] =
    []
  const gate = deferred()
  const removed: ModelId[] = []
  const emitted: DownloadProgress[] = []

  const handlers = createModelHandlers({
    readSettings: async () => SETTINGS,
    isInstalled: async () => false,
    install: async (id, options) => {
      installs.push({ id, ...options })
      await gate.promise
    },
    remove: async (id) => {
      removed.push(id)
    },
    emitProgress: (progress) => emitted.push(progress),
    ...overrides,
  })

  return { handlers, installs, removed, emitted, gate }
}

const progress = (received: number): DownloadProgress => ({
  id: 'base',
  receivedBytes: received,
  totalBytes: 147_951_465,
  bytesPerSecond: 1_000_000,
})

describe('models.list', () => {
  it('returns one row per picker row, in capability order', async () => {
    const { handlers } = harness()

    expect((await handlers.list()).map((row) => row.base)).toEqual([
      'tiny',
      'base',
      'small',
      'large-v3-turbo',
      'large-v3',
    ])
  })

  it('resolves each row against the English-only toggle', async () => {
    const { handlers } = harness({ readSettings: async () => ({ ...SETTINGS, englishOnly: true }) })
    const rows = await handlers.list()

    expect(rows.map((row) => row.resolved.id)).toEqual([
      'tiny.en',
      'base.en',
      'small.en',
      'large-v3-turbo',
      'large-v3',
    ])
  })

  it('reports install state per resolved model', async () => {
    const { handlers } = harness({ isInstalled: async (id) => id === 'small' })
    const rows = await handlers.list()

    expect(rows.find((row) => row.base === 'small')?.installed).toBe(true)
    expect(rows.find((row) => row.base === 'base')?.installed).toBe(false)
  })

  it('shows a measured realtime factor only for models actually run here', async () => {
    const { handlers } = harness({
      readSettings: async () => ({
        ...SETTINGS,
        throughput: { base: { realtimeFactor: 12.5, samples: 3 } },
      }),
    })
    const rows = await handlers.list()

    expect(rows.find((row) => row.base === 'base')?.realtimeFactor).toBe(12.5)
    expect(rows.find((row) => row.base === 'tiny')?.realtimeFactor).toBeUndefined()
  })

  it('reads throughput for the resolved id, not the row, so the toggle swaps it too', async () => {
    const { handlers } = harness({
      readSettings: async () => ({
        ...SETTINGS,
        englishOnly: true,
        throughput: { base: { realtimeFactor: 12.5, samples: 3 } },
      }),
    })
    const rows = await handlers.list()

    expect(rows.find((row) => row.base === 'base')?.realtimeFactor).toBeUndefined()
  })

  it('reports an in-flight download on its row', async () => {
    const { handlers, installs } = harness()
    void handlers.download('base')
    await Promise.resolve()
    installs[0]?.onProgress(progress(1_000))

    const rows = await handlers.list()
    expect(rows.find((row) => row.base === 'base')?.downloading?.receivedBytes).toBe(1_000)
    expect(rows.find((row) => row.base === 'tiny')?.downloading).toBeUndefined()
  })
})

describe('models.download', () => {
  it('installs the model the row resolves to', async () => {
    const { handlers, installs, gate } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    const running = handlers.download('small')
    gate.resolve()
    await running

    expect(installs[0]?.id).toBe('small.en')
  })

  it('forwards progress to the renderer', async () => {
    const { handlers, installs, emitted } = harness()
    void handlers.download('base')
    await Promise.resolve()
    installs[0]?.onProgress(progress(2_000))

    expect(emitted).toEqual([progress(2_000)])
  })

  it('joins an in-flight download instead of starting a second one', async () => {
    const { handlers, installs, gate } = harness()
    const first = handlers.download('base')
    const second = handlers.download('base')
    gate.resolve()
    await Promise.all([first, second])

    expect(installs).toHaveLength(1)
  })

  it('rejects a base id that is not a catalog row', async () => {
    const { handlers } = harness()

    await expect(handlers.download('huge')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.download('../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(handlers.download('tiny.en')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.download(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('propagates a real download failure', async () => {
    const { handlers } = harness({
      install: async () => {
        throw Object.assign(new Error('nope'), { code: 'DOWNLOAD_NETWORK_ERROR' })
      },
    })

    await expect(handlers.download('base')).rejects.toThrow('nope')
  })

  it('allows a retry after a failure', async () => {
    let attempts = 0
    const { handlers } = harness({
      install: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('nope')
      },
    })

    await expect(handlers.download('base')).rejects.toThrow('nope')
    await expect(handlers.download('base')).resolves.toBeUndefined()
  })
})

describe('models.cancelDownload', () => {
  it('aborts the in-flight download for that row', async () => {
    const { handlers, installs } = harness()
    void handlers.download('base')
    await Promise.resolve()
    await handlers.cancelDownload('base')

    expect(installs[0]?.signal.aborted).toBe(true)
  })

  it('resolves rather than erroring when nothing is downloading', async () => {
    const { handlers } = harness()

    await expect(handlers.cancelDownload('base')).resolves.toBeUndefined()
  })

  it('reports a cancelled download as success, not as an error', async () => {
    const abort = vi.fn()
    const { handlers, installs } = harness({
      install: async (_id, options) => {
        abort()
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve))
        throw new Error('downloadModel: aborted')
      },
    })

    const running = handlers.download('base')
    await Promise.resolve()
    await handlers.cancelDownload('base')

    await expect(running).resolves.toBeUndefined()
    expect(installs).toHaveLength(0)
    expect(abort).toHaveBeenCalled()
  })

  it('rejects a base id that is not a catalog row', async () => {
    const { handlers } = harness()

    await expect(handlers.cancelDownload('nope')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe('models.remove', () => {
  it('removes the model the row resolves to', async () => {
    const { handlers, removed } = harness({
      readSettings: async () => ({ ...SETTINGS, englishOnly: true }),
    })
    await handlers.remove('tiny')

    expect(removed).toEqual(['tiny.en'])
  })

  it('rejects a base id that is not a catalog row before touching the store', async () => {
    const { handlers, removed } = harness()

    await expect(handlers.remove('../../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(removed).toEqual([])
  })
})
