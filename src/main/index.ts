import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { createMainWindow } from './window.js'

function openWindow(): BrowserWindow {
  return createMainWindow({
    preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(import.meta.dirname, '../renderer/index.html'),
  })
}

app.whenReady().then(() => {
  openWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
