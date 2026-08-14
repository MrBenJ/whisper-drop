import { BrowserWindow } from 'electron'
import { isAllowedNavigation } from './navigation.js'

export type WindowOptions = {
  preloadPath: string
  /** Set by electron-vite in dev. When absent, the built HTML is loaded. */
  rendererUrl?: string
  rendererFile: string
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
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

  if (options.rendererUrl) void window.loadURL(options.rendererUrl)
  else void window.loadFile(options.rendererFile)

  return window
}
