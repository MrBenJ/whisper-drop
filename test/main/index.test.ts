import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS } from '../../src/shared/ipc.js'
import type { IpcResult } from '../../src/shared/ipc.js'

/**
 * Drives the real composition root (`src/main/index.ts`) through a faked
 * `electron`, the same trick `test/main/ipc/wiring.test.ts` uses for the
 * preload. Every handler module is already unit-tested against injected
 * fakes; this is the one place that proves `newJobId`, `hasTrustedPath` /
 * `consumeTrustedPath`, and the two `issuePath` calls are wired to the real
 * things they claim to be — a wiring mistake here (e.g. `consumeTrustedPath:
 * () => true`) would otherwise fail no test at all.
 */

type Listener = (event: unknown, ...args: unknown[]) => unknown

const registered = new Map<string, Listener>()
const appListeners = new Map<string, ((...args: unknown[]) => void)[]>()

let userDataDir: string
let tempDir: string
let openDialogResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  static getAllWindows = vi.fn(() => FakeBrowserWindow.instances)

  webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    getURL: vi.fn(() => ''),
    session: { setPermissionRequestHandler: vi.fn() },
    send: vi.fn(),
  }
  once = vi.fn()
  show = vi.fn()
  focus = vi.fn()
  restore = vi.fn()
  isMinimized = vi.fn(() => false)
  isDestroyed = vi.fn(() => false)
  loadURL = vi.fn(async () => {})
  loadFile = vi.fn(async () => {})

  constructor() {
    FakeBrowserWindow.instances.push(this)
  }
}

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: (name: string) => (name === 'temp' ? tempDir : userDataDir),
    getLocale: () => 'en-US',
    on: (event: string, cb: (...args: unknown[]) => void) => {
      const list = appListeners.get(event) ?? []
      list.push(cb)
      appListeners.set(event, list)
    },
    quit: vi.fn(),
    exit: vi.fn(),
  },
  BrowserWindow: FakeBrowserWindow,
  dialog: {
    showOpenDialog: vi.fn(async () => openDialogResult),
  },
  shell: {
    showItemInFolder: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      registered.set(channel, listener)
    },
  },
}))

/** Mirrors the preload's own unwrap, without going through contextBridge. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const listener = registered.get(channel)
  if (!listener) throw new Error(`no handler registered for ${channel}`)
  const result = (await listener({}, ...args)) as IpcResult<T>
  if (result.ok) return result.value
  throw result.error
}

async function bootTheRealRoot(): Promise<void> {
  await import('../../src/main/index.js')
  // The whole whenReady().then(setup) body is synchronous once entered; it
  // just needs a couple of microtask hops to run after the dynamic import.
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(async () => {
  registered.clear()
  appListeners.clear()
  FakeBrowserWindow.instances = []
  openDialogResult = { canceled: true, filePaths: [] }
  userDataDir = await mkdtemp(join(tmpdir(), 'whisper-drop-root-'))
  tempDir = await mkdtemp(join(tmpdir(), 'whisper-drop-root-temp-'))
  vi.resetModules()
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
  await rm(tempDir, { recursive: true, force: true })
})

describe('the composition root, wired for real', () => {
  it('rejects transcribe:start for a path main never issued', async () => {
    await bootTheRealRoot()

    await expect(invoke(CHANNELS.transcribeStart, '/etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('accepts a path returned by dialog:openFile', async () => {
    openDialogResult = { canceled: false, filePaths: ['/videos/e2e-real-root.mp4'] }
    await bootTheRealRoot()

    const path = await invoke<string | null>(CHANNELS.dialogOpenFile)
    expect(path).toBe('/videos/e2e-real-root.mp4')

    // Got past the trust boundary — on a fresh profile the only way it can
    // still fail is because no model is installed, never INVALID_REQUEST.
    await expect(invoke(CHANNELS.transcribeStart, path)).rejects.toMatchObject({
      code: 'NO_MODEL_INSTALLED',
    })
  })

  it('focuses the existing window on a relaunch instead of doing nothing', async () => {
    await bootTheRealRoot()

    const secondInstanceHandlers = appListeners.get('second-instance') ?? []
    expect(secondInstanceHandlers.length).toBeGreaterThan(0)
    for (const handler of secondInstanceHandlers) handler()

    expect(FakeBrowserWindow.instances[0]?.focus).toHaveBeenCalled()
  })
})
