import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS } from '../../../src/shared/ipc.js'

type Listener = (event: unknown, ...args: unknown[]) => unknown

const registered = new Map<string, Listener>()
const invoked = new Set<string>()
const subscribed = new Set<string>()
let exposedApi: Record<string, unknown> | undefined

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      registered.set(channel, listener)
    },
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      invoked.add(channel)
      const listener = registered.get(channel)
      if (!listener) throw new Error(`no main handler registered for ${channel}`)
      return listener({}, ...args)
    },
    on: (channel: string) => {
      subscribed.add(channel)
    },
    off: () => {},
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposedApi = api
    },
  },
  webUtils: {
    getPathForFile: () => '/videos/dropped.mp4',
  },
}))

const REQUEST_CHANNELS = Object.values(CHANNELS).filter(
  (channel) => channel !== CHANNELS.transcribeState && channel !== CHANNELS.modelsProgress,
)

async function registerAllHandlers(): Promise<void> {
  const { registerIpcHandlers } = await import('../../../src/main/ipc/index.js')
  registerIpcHandlers({
    transcribe: {
      start: async () => 'job-1',
      cancel: async () => {},
      stateOf: () => undefined,
      cancelActive: async () => {},
    },
    models: {
      list: async () => [],
      download: async () => {},
      cancelDownload: async () => {},
      remove: async () => {},
    },
    settings: {
      get: async () => ({
        version: 1,
        englishOnly: false,
        activeModel: null,
        language: 'auto',
        throughput: {},
      }),
      set: async () => ({
        version: 1,
        englishOnly: false,
        activeModel: null,
        language: 'auto',
        throughput: {},
      }),
    },
    export: {
      save: async () => '/videos/interview.txt',
      reveal: async () => {},
    },
    dialog: {
      openFile: async () => null,
    },
    droppedFile: {
      register: async () => {},
    },
  })
}

async function exerciseThePreload(): Promise<void> {
  await import('../../../src/preload/index.js')
  const api = exposedApi as {
    transcribe: {
      start: (p: string) => Promise<unknown>
      cancel: (id: string) => Promise<unknown>
      onState: (cb: () => void) => void
    }
    models: {
      list: () => Promise<unknown>
      download: (id: string) => Promise<unknown>
      cancelDownload: (id: string) => Promise<unknown>
      remove: (id: string) => Promise<unknown>
      onProgress: (cb: () => void) => void
    }
    settings: { get: () => Promise<unknown>; set: (p: object) => Promise<unknown> }
    exportTranscript: { save: (id: string, as: string) => Promise<unknown> }
    dialog: { openFile: () => Promise<unknown> }
    shell: { reveal: (p: string) => Promise<unknown> }
    droppedFile: { pathFor: (f: unknown) => string }
  }

  await api.transcribe.start('/videos/interview.mp4')
  await api.transcribe.cancel('job-1')
  api.transcribe.onState(() => {})

  await api.models.list()
  await api.models.download('tiny')
  await api.models.cancelDownload('tiny')
  await api.models.remove('tiny')
  api.models.onProgress(() => {})

  await api.settings.get()
  await api.settings.set({})

  await api.exportTranscript.save('job-1', 'txt')
  await api.dialog.openFile()
  await api.shell.reveal('/videos/interview.txt')

  api.droppedFile.pathFor({} as never)
  // pathFor's registration invoke is fire-and-forget; let it land.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('main and preload agree on every channel name', () => {
  beforeEach(() => {
    registered.clear()
    invoked.clear()
    subscribed.clear()
    exposedApi = undefined
    vi.resetModules()
  })

  it('registers exactly the channels the channel list declares as requests', async () => {
    await registerAllHandlers()

    expect([...registered.keys()].sort()).toEqual([...REQUEST_CHANNELS].sort())
  })

  it('invokes exactly the channels main registers — a typo on either side fails this', async () => {
    await registerAllHandlers()
    await exerciseThePreload()

    expect([...invoked].sort()).toEqual([...registered.keys()].sort())
  })

  it('subscribes to exactly the two push channels', async () => {
    await registerAllHandlers()
    await exerciseThePreload()

    expect([...subscribed].sort()).toEqual(
      [CHANNELS.transcribeState, CHANNELS.modelsProgress].sort(),
    )
  })
})
