import { BrowserWindow } from 'electron'
import { isAllowedNavigation } from './navigation.js'

export type WindowOptions = {
  preloadPath: string
  /** Set by electron-vite in dev. When absent, the built HTML is loaded. */
  rendererUrl?: string
  rendererFile: string
  /** `app.isPackaged` — the signal that gates `rendererUrl` below. */
  isPackaged: boolean
}

// Loopback only. A dev URL that resolves anywhere else (a LAN host, a
// DNS-rebound name, an outright remote origin) would hand the privileged
// preload bridge — file dialogs, model download/removal, transcription,
// export, shell reveal — to code this machine didn't serve.
const ALLOWED_DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * The one gate on `options.rendererUrl` before it ever reaches `loadURL`.
 * A packaged build must always load the built file — `rendererUrl` has no
 * legitimate reason to be set there, so its mere presence is refused, loudly,
 * rather than silently falling back to the file (which would hide the
 * misconfiguration instead of surfacing it). In development the URL still
 * has to be loopback: only `http:`/`https:` on `localhost`, `127.0.0.1`, or
 * `::1`.
 */
function resolveRendererUrl(options: WindowOptions): string | undefined {
  if (!options.rendererUrl) return undefined

  if (options.isPackaged) {
    throw new Error(
      `refusing to load rendererUrl "${options.rendererUrl}" in a packaged build — a packaged app must always load the built file`,
    )
  }

  let parsed: URL
  try {
    parsed = new URL(options.rendererUrl)
  } catch {
    throw new Error(`refusing to load rendererUrl "${options.rendererUrl}": not a valid URL`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `refusing to load rendererUrl "${options.rendererUrl}": scheme must be http: or https:, got "${parsed.protocol}"`,
    )
  }

  if (!ALLOWED_DEV_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `refusing to load rendererUrl "${options.rendererUrl}": hostname must be localhost, 127.0.0.1, or ::1, got "${parsed.hostname}"`,
    )
  }

  return options.rendererUrl
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  // Resolved before the window is constructed: a refusal must not leave a
  // hardened-but-unloaded window behind.
  const rendererUrl = resolveRendererUrl(options)

  const window = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'whisper-drop',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const denyNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (!isAllowedNavigation(window.webContents.getURL(), url)) event.preventDefault()
  }
  window.webContents.on('will-navigate', denyNavigation)
  window.webContents.on('will-frame-navigate', (event) => denyNavigation(event, event.url))

  // The app needs no device permissions. Refusing them all means a compromised
  // renderer cannot prompt for a microphone on a machine holding client audio.
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  // The request handler above governs the prompt; this governs `navigator.permissions.query`
  // and similar synchronous checks, which bypass the request handler entirely. Without this,
  // a compromised renderer could still learn whether a permission is already granted.
  window.webContents.session.setPermissionCheckHandler(() => false)

  if (rendererUrl) void window.loadURL(rendererUrl)
  else void window.loadFile(options.rendererFile)

  return window
}
