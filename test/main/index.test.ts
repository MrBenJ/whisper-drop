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
let singleInstanceLock = true

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []
  static getAllWindows = vi.fn(() => FakeBrowserWindow.instances)

  webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    getURL: vi.fn(() => ''),
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
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
    requestSingleInstanceLock: () => singleInstanceLock,
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

// Wraps the real `rm`, so the `finally { removeFile(wavPath) }` cleanup every
// job runs still actually deletes the temp file — this only adds visibility
// into what path was passed, for the tempWavPath wiring test below.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

/** Mirrors the preload's own unwrap, without going through contextBridge. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const listener = registered.get(channel)
  if (!listener) throw new Error(`no handler registered for ${channel}`)
  const result = (await listener({}, ...args)) as IpcResult<T>
  if (result.ok) return result.value
  throw result.error
}

/**
 * Seeds a model the real stores will see as installed, and makes it active —
 * shared by every test below that needs `transcribe:start` to actually reach
 * job creation instead of stopping at NO_MODEL_INSTALLED. See the second test
 * above for why a sparse file of the right length is enough.
 */
async function seedInstalledModel(): Promise<void> {
  const tiny = entryFor('tiny')
  const modelPath = join(userDataDir, 'models', `${tiny.id}.bin`)
  await mkdir(join(userDataDir, 'models'), { recursive: true })
  await writeFile(modelPath, '')
  await truncate(modelPath, tiny.bytes)
  await invoke(CHANNELS.settingsSet, { activeModel: 'tiny', englishOnly: false })
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
  singleInstanceLock = true
  userDataDir = await mkdtemp(join(tmpdir(), 'whisper-drop-root-'))
  tempDir = await mkdtemp(join(tmpdir(), 'whisper-drop-root-temp-'))
  vi.resetModules()
  // The mocked `electron` module (app.quit, etc.) is not re-created by
  // resetModules — only cleared here — so call counts from an earlier test
  // (e.g. the single-instance-lock test's own app.quit()) can't leak into a
  // later test's assertions about whether *this* test caused a call.
  vi.clearAllMocks()
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

  // I5: four more survivors in the composition root, each proven here.

  it('quits immediately when another instance already holds the single-instance lock, instead of opening a second window', async () => {
    singleInstanceLock = false
    await bootTheRealRoot()

    const { app } = await import('electron')
    expect(app.quit).toHaveBeenCalled()
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('mints a fresh id per job rather than a constant, so two jobs never collide', async () => {
    await bootTheRealRoot()
    await seedInstalledModel()

    // A fake path is enough: probe() is cancelled before it would ever
    // succeed or fail on it, so its realism doesn't matter here.
    openDialogResult = { canceled: false, filePaths: ['/videos/job-a.mp4'] }
    const pathA = await invoke<string | null>(CHANNELS.dialogOpenFile)
    const jobIdA = await invoke<string>(CHANNELS.transcribeStart, pathA)
    expect(jobIdA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    // Cancelling aborts the real ffprobe subprocess via the AbortSignal probe()
    // is wired with, which settles the job fast and deterministically — no
    // need to wait on ffprobe's own timing against a path that doesn't exist.
    await invoke(CHANNELS.transcribeCancel, jobIdA)

    // JOB_ALREADY_RUNNING clears asynchronously, once the aborted probe's
    // rejection propagates through the job's phase machine — so the next
    // start is retried rather than assumed to succeed immediately.
    openDialogResult = { canceled: false, filePaths: ['/videos/job-b.mp4'] }
    const pathB = await invoke<string | null>(CHANNELS.dialogOpenFile)

    const deadline = Date.now() + 5_000
    let jobIdB: string | undefined
    while (jobIdB === undefined && Date.now() < deadline) {
      try {
        jobIdB = await invoke<string>(CHANNELS.transcribeStart, pathB)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    expect(jobIdB).toBeDefined()
    // A hardcoded constant in place of `randomUUID()` would hand out this
    // exact same id twice.
    expect(jobIdB).not.toBe(jobIdA)
  })

  it("names each job's temp wav after its own id, not a fixed filename", async () => {
    openDialogResult = { canceled: false, filePaths: ['/videos/job-temp.mp4'] }
    await bootTheRealRoot()
    await seedInstalledModel()

    const path = await invoke<string | null>(CHANNELS.dialogOpenFile)
    const jobId = await invoke<string>(CHANNELS.transcribeStart, path)

    // Cancelling drives the job to its `finally` block fast, where
    // `removeFile(wavPath)` always runs regardless of outcome.
    await invoke(CHANNELS.transcribeCancel, jobId)

    const { rm } = (await import('node:fs/promises')) as unknown as {
      rm: { mock: { calls: unknown[][] } }
    }
    const expectedWavPath = join(tempDir, `whisper-drop-${jobId}.wav`)
    const deadline = Date.now() + 5_000
    while (
      !rm.mock.calls.some((call) => call[0] === expectedWavPath) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // A constant filename in place of `whisper-drop-${jobId}.wav` would never
    // produce this exact, job-scoped path.
    expect(rm.mock.calls.some((call) => call[0] === expectedWavPath)).toBe(true)
  })

  it('waits for cancelActive to settle before quitting on before-quit, rather than quitting immediately', async () => {
    await bootTheRealRoot()

    const beforeQuitHandlers = appListeners.get('before-quit') ?? []
    expect(beforeQuitHandlers.length).toBeGreaterThan(0)

    const { app } = await import('electron')
    const event = { preventDefault: vi.fn() }
    beforeQuitHandlers[0]?.(event)

    expect(event.preventDefault).toHaveBeenCalled()
    // cancelActive() awaits pendingStart, then activeRun — both already-
    // resolved promises here — before its `.finally(() => app.quit())` runs.
    // A plain `app.quit()` in its place would already have fired by now.
    expect(app.quit).not.toHaveBeenCalled()

    for (let i = 0; i < 10; i++) await Promise.resolve()

    expect(app.quit).toHaveBeenCalled()
  })
})
