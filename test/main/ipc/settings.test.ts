import { describe, expect, it, vi } from 'vitest'
import { createSettingsHandlers } from '../../../src/main/ipc/settings.js'
import type { Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: { base: { realtimeFactor: 9, samples: 2 } },
}

function harness() {
  const write = vi.fn(async (patch: Partial<Settings>) => ({ ...SETTINGS, ...patch }))
  const handlers = createSettingsHandlers({ read: async () => SETTINGS, write })
  return { handlers, write }
}

describe('settings.get', () => {
  it('returns the persisted settings', async () => {
    const { handlers } = harness()

    expect(await handlers.get()).toEqual(SETTINGS)
  })
})

describe('settings.set', () => {
  it('writes englishOnly', async () => {
    const { handlers, write } = harness()
    const result = await handlers.set({ englishOnly: true })

    expect(write).toHaveBeenCalledWith({ englishOnly: true })
    expect(result.englishOnly).toBe(true)
  })

  it('writes activeModel, including null', async () => {
    const { handlers, write } = harness()
    await handlers.set({ activeModel: 'large-v3-turbo' })
    await handlers.set({ activeModel: null })

    expect(write).toHaveBeenNthCalledWith(1, { activeModel: 'large-v3-turbo' })
    expect(write).toHaveBeenNthCalledWith(2, { activeModel: null })
  })

  it('writes an ISO 639-1 language and auto', async () => {
    const { handlers, write } = harness()
    await handlers.set({ language: 'fr' })
    await handlers.set({ language: 'auto' })

    expect(write).toHaveBeenNthCalledWith(1, { language: 'fr' })
    expect(write).toHaveBeenNthCalledWith(2, { language: 'auto' })
  })

  it('rejects a patch that is not a plain object', async () => {
    const { handlers, write } = harness()

    for (const patch of [null, 'englishOnly', 42, ['englishOnly']]) {
      await expect(handlers.set(patch)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects an unknown key rather than dropping it silently', async () => {
    const { handlers, write } = harness()

    await expect(handlers.set({ modelsDir: '/tmp' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses to let the renderer write throughput — it is measured, not asserted', async () => {
    const { handlers } = harness()

    await expect(
      handlers.set({ throughput: { base: { realtimeFactor: 999, samples: 1 } } }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('refuses to let the renderer set version', async () => {
    const { handlers } = harness()

    await expect(handlers.set({ version: 2 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a mistyped englishOnly', async () => {
    const { handlers } = harness()

    await expect(handlers.set({ englishOnly: 'yes' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects an activeModel that is not a picker row', async () => {
    const { handlers } = harness()

    await expect(handlers.set({ activeModel: 'base.en' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(handlers.set({ activeModel: '../../etc' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects a language that is not auto or an ISO 639-1 code', async () => {
    const { handlers } = harness()

    for (const language of ['english', 'EN', '', '-l --output-file /etc/x', 42]) {
      await expect(handlers.set({ language })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
  })

  it('rejects the whole patch when any key is bad, rather than writing the good half', async () => {
    const { handlers, write } = harness()

    await expect(handlers.set({ englishOnly: true, language: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('accepts an empty patch', async () => {
    const { handlers, write } = harness()
    await handlers.set({})

    expect(write).toHaveBeenCalledWith({})
  })
})
