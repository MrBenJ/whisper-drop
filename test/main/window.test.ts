import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `src/main/window.ts` is the most security-load-bearing file in the app —
 * sandbox, context isolation, node integration, the window-open handler, the
 * navigation guard, and the permission handlers all live here — and until
 * now it was asserted only by human reading. This proves each of those five
 * hardening decisions with the same `vi.mock('electron')` approach
 * `test/main/index.test.ts` already uses for the composition root.
 */

type Listener = (...args: unknown[]) => unknown

class FakeWebContents {
  setWindowOpenHandler = vi.fn()
  handlers = new Map<string, Listener[]>()
  on = vi.fn((event: string, cb: Listener) => {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
  })
  getURL = vi.fn(() => 'app://whisper-drop/index.html')
  session = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }

  handlersFor(event: string): Listener[] {
    return this.handlers.get(event) ?? []
  }
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = []

  webContents = new FakeWebContents()
  once = vi.fn()
  show = vi.fn()
  loadURL = vi.fn(async () => {})
  loadFile = vi.fn(async () => {})

  constructor(public options: unknown) {
    FakeBrowserWindow.instances.push(this)
  }
}

vi.mock('electron', () => ({ BrowserWindow: FakeBrowserWindow }))

beforeEach(() => {
  FakeBrowserWindow.instances = []
  vi.resetModules()
})

async function build(overrides: { rendererUrl?: string; isPackaged?: boolean } = {}) {
  const { createMainWindow } = await import('../../src/main/window.js')
  createMainWindow({
    preloadPath: '/out/preload/index.cjs',
    rendererFile: '/out/renderer/index.html',
    isPackaged: false,
    ...overrides,
  })
  const win = FakeBrowserWindow.instances[0]
  if (!win) throw new Error('createMainWindow did not construct a BrowserWindow')
  return win
}

async function buildThrows(overrides: { rendererUrl?: string; isPackaged?: boolean }) {
  const { createMainWindow } = await import('../../src/main/window.js')
  return () =>
    createMainWindow({
      preloadPath: '/out/preload/index.cjs',
      rendererFile: '/out/renderer/index.html',
      isPackaged: false,
      ...overrides,
    })
}

describe('createMainWindow', () => {
  it('constructs the window with exactly the hardened webPreferences', async () => {
    const win = await build()

    expect((win.options as { webPreferences: unknown }).webPreferences).toEqual({
      preload: '/out/preload/index.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    })
  })

  it('denies every window-open request', async () => {
    const win = await build()

    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = win.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => {
      action: string
    }
    expect(handler()).toEqual({ action: 'deny' })
  })

  it('installs a navigation guard that denies a foreign URL and allows the current one', async () => {
    const win = await build()

    const willNavigate = win.webContents.handlersFor('will-navigate')[0]
    expect(willNavigate).toBeDefined()

    const denied = { preventDefault: vi.fn() }
    willNavigate?.(denied, 'https://evil.example/')
    expect(denied.preventDefault).toHaveBeenCalledTimes(1)

    const allowed = { preventDefault: vi.fn() }
    willNavigate?.(allowed, win.webContents.getURL())
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('installs the same navigation guard for will-frame-navigate', async () => {
    const win = await build()

    const willFrameNavigate = win.webContents.handlersFor('will-frame-navigate')[0]
    expect(willFrameNavigate).toBeDefined()

    const denied = { preventDefault: vi.fn(), url: 'https://evil.example/' }
    willFrameNavigate?.(denied)
    expect(denied.preventDefault).toHaveBeenCalledTimes(1)

    const allowed = { preventDefault: vi.fn(), url: win.webContents.getURL() }
    willFrameNavigate?.(allowed)
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('refuses every permission request', async () => {
    const win = await build()

    expect(win.webContents.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    const handler = win.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void
    const callback = vi.fn()
    handler({}, 'media', callback)
    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('refuses every permission check (M12)', async () => {
    const win = await build()

    expect(win.webContents.session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    const handler = win.webContents.session.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      ...args: unknown[]
    ) => boolean
    expect(handler({}, 'media', 'app://whisper-drop')).toBe(false)
  })
})

/**
 * P1: `rendererUrl` (sourced from `ELECTRON_RENDERER_URL`) reaches `loadURL`
 * on the same window that exposes the full `window.whisperDrop` bridge.
 * Nothing about the hardened `webPreferences` above stops a malicious or
 * misconfigured `rendererUrl` from handing that bridge to remote code — this
 * is the separate gate that does.
 */
describe('rendererUrl gate (P1)', () => {
  it('refuses rendererUrl entirely in a packaged build, even a loopback one', async () => {
    const throws = await buildThrows({ rendererUrl: 'http://localhost:5173', isPackaged: true })

    expect(throws).toThrow(/localhost:5173/)
    expect(throws).toThrow(/packaged/)
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('loads the built file in a packaged build when no rendererUrl is set', async () => {
    const win = await build({ isPackaged: true })

    expect(win.loadFile).toHaveBeenCalledExactlyOnceWith('/out/renderer/index.html')
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('refuses a non-loopback origin in development', async () => {
    const throws = await buildThrows({ rendererUrl: 'https://example.com', isPackaged: false })

    expect(throws).toThrow(/example\.com/)
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('refuses a LAN host in development', async () => {
    const throws = await buildThrows({ rendererUrl: 'http://192.168.1.5:5173', isPackaged: false })

    expect(throws).toThrow(/192\.168\.1\.5/)
    expect(FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('accepts http://localhost:5173 in development and loads it', async () => {
    const win = await build({ rendererUrl: 'http://localhost:5173', isPackaged: false })

    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith('http://localhost:5173')
    expect(win.loadFile).not.toHaveBeenCalled()
  })
})
