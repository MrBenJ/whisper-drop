import { describe, expect, it, vi } from 'vitest'
import type { WhisperDropApi } from '../../src/shared/ipc.js'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  getPathForFile: vi.fn(),
  exposeInMainWorld: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, off: mocks.off },
  webUtils: { getPathForFile: mocks.getPathForFile },
}))

// Side effect: running this registers the bridge, exactly as it would in a
// real preload context.
import '../../src/preload/index.js'

describe('preload subscribe()', () => {
  it('does not let one throwing subscriber block another on the same channel', () => {
    const api = mocks.exposeInMainWorld.mock.calls[0]?.[1] as WhisperDropApi

    const broken = vi.fn(() => {
      throw new Error('boom')
    })
    const ok = vi.fn()

    api.transcribe.onState(broken)
    api.transcribe.onState(ok)

    // Each onState call registers its own ipcRenderer.on listener for the
    // same channel, same as electron's real event dispatch.
    const listeners = mocks.on.mock.calls
      .filter(([channel]) => channel === 'transcribe:state')
      .map(([, listener]) => listener as (event: unknown, payload: unknown) => void)

    expect(listeners).toHaveLength(2)

    const payload = { id: 'job-1' }
    for (const listener of listeners) {
      expect(() => listener({}, payload)).not.toThrow()
    }

    expect(broken).toHaveBeenCalledWith(payload)
    expect(ok).toHaveBeenCalledWith(payload)
  })
})
