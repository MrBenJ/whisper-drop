import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entryFor } from '../../src/main/models/catalog.js'
import { CHANNELS } from '../../src/shared/ipc.js'
import type { IpcResult } from '../../src/shared/ipc.js'

/**
 * Drives the real composition root (`src/main/index.ts`) through a faked
 * `electron`, the same trick `test/main/ipc/wiring.test.ts` uses for the
 * preload. Every handler module is already unit-tested against injected
 * fakes; this is the one place that proves `newJobId`, `hasTrustedPath`,
 * `consumeTrustedPath`, and the two `issuePath` calls are wired to the real
 * things they claim to be — a wiring mistake here (e.g. `hasTrustedPath: ()
 * => true` or a no-op `consumeTrustedPath`) would otherwise fail no test at
 * all. Proving `consumeTrustedPath` specifically requires a start() that
 * actually succeeds (past every model check, not just the trust one), which
 * is why the second test below seeds a fake installed model rather than
 * stopping at NO_MODEL_INSTALLED.
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

  it('accepts a path returned by dialog:openFile, then spends it', async () => {
    openDialogResult = { canceled: false, filePaths: ['/videos/e2e-real-root.mp4'] }
    await bootTheRealRoot()

    // Seed a model the real stores will see as installed, so start() runs
    // all the way to consumeTrustedPath instead of stopping earlier at the
    // unrelated NO_MODEL_INSTALLED check. isInstalled only compares file
    // size to the catalog, so a sparse file of the right length is enough —
    // no need to actually fetch or write out a real model.
    const tiny = entryFor('tiny')
    const modelPath = join(userDataDir, 'models', `${tiny.id}.bin`)
    await mkdir(join(userDataDir, 'models'), { recursive: true })
    await writeFile(modelPath, '')
    await truncate(modelPath, tiny.bytes)
    // englishOnly is forced off: the fake profile's locale ('en-US') would
    // otherwise make resolveModelId pick 'tiny.en', which the seeded file
    // above (named for plain 'tiny') wouldn't match.
    await invoke(CHANNELS.settingsSet, { activeModel: 'tiny', englishOnly: false })

    const path = await invoke<string | null>(CHANNELS.dialogOpenFile)
    expect(path).toBe('/videos/e2e-real-root.mp4')

    // Got all the way past the trust boundary and every model check — this
    // is what actually reaches consumeTrustedPath, not just hasTrustedPath.
    await expect(invoke(CHANNELS.transcribeStart, path)).resolves.toEqual(expect.any(String))

    // The entry was genuinely spent by that start() — not merely checked and
    // left alone — so the identical path, never re-issued, is now rejected
    // on trust grounds alone. A no-op consumeTrustedPath would let this
    // resolve again instead of rejecting.
    await expect(invoke(CHANNELS.transcribeStart, path)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
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
