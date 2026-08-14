import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, shell } from 'electron'
import { CHANNELS } from '../shared/ipc.js'
import { saveTranscript } from './export/save.js'
import { createDialogHandlers } from './ipc/dialog.js'
import { createDroppedFileHandlers } from './ipc/dropped-file.js'
import { createExportHandlers } from './ipc/export.js'
import { registerIpcHandlers } from './ipc/index.js'
import { createModelHandlers } from './ipc/models.js'
import { createSettingsHandlers } from './ipc/settings.js'
import { createTranscribeHandlers, type TranscribeHandlers } from './ipc/transcribe.js'
import { createTrustedPaths } from './ipc/trusted-paths.js'
import { TranscriptionJob } from './jobs/transcription-job.js'
import { extractWav } from './media/extract.js'
import { probe } from './media/probe.js'
import { createModelStore } from './models/store.js'
import { createSettingsStore } from './settings.js'
import { runWhisper } from './whisper/runner.js'
import { createMainWindow } from './window.js'

let transcribe: TranscribeHandlers | null = null
let quitting = false

async function setup(): Promise<void> {
  // The one place the user-data directory is read. Everything below takes it
  // by injection, which is what keeps those modules Electron-free.
  const userData = app.getPath('userData')
  const models = createModelStore(userData)
  const settings = createSettingsStore(userData, app.getLocale())
  // The only two ways a path enters the renderer — the open dialog and a
  // dropped file's `pathFor` — issue into this registry. `transcribe.start`
  // checks and then consumes from it, so a path the renderer never received
  // from main is never trusted, regardless of how it is shaped.
  const trustedPaths = createTrustedPaths()

  let window: BrowserWindow | null = null
  const send = (channel: string, payload: unknown): void => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  transcribe = createTranscribeHandlers({
    newJobId: () => randomUUID(),
    readSettings: () => settings.read(),
    modelPathFor: (id) => models.pathFor(id),
    isInstalled: (id) => models.isInstalled(id),
    recordThroughput: (id, realtimeFactor) => settings.recordThroughput(id, realtimeFactor),
    emitState: (state) => send(CHANNELS.transcribeState, state),
    hasTrustedPath: (path) => trustedPaths.has(path),
    consumeTrustedPath: (path) => trustedPaths.consume(path),
    createJob: (input) =>
      new TranscriptionJob(
        {
          probe: (path, signal) => probe(path, { signal }),
          extract: (options) => extractWav(options),
          run: (options, onSegment) => runWhisper({ ...options, onSegment }),
          // The id is a main-generated UUID, so it is safe in a path here.
          tempWavPath: (jobId) => join(app.getPath('temp'), `whisper-drop-${jobId}.wav`),
          removeFile: (path) => rm(path, { force: true }),
          now: () => Date.now(),
        },
        input,
      ),
  })

  registerIpcHandlers({
    transcribe,
    models: createModelHandlers({
      readSettings: () => settings.read(),
      isInstalled: (id) => models.isInstalled(id),
      install: (id, options) => models.install(id, options),
      remove: (id) => models.remove(id),
      emitProgress: (progress) => send(CHANNELS.modelsProgress, progress),
    }),
    settings: createSettingsHandlers({
      read: () => settings.read(),
      write: (patch) => settings.write(patch),
    }),
    export: createExportHandlers({
      lookupJob: (jobId) => transcribe?.stateOf(jobId),
      writeTranscript: (options) => saveTranscript(options),
      reveal: (path) => shell.showItemInFolder(path),
    }),
    dialog: createDialogHandlers({
      showOpenDialog: async () => {
        const result = window
          ? await dialog.showOpenDialog(window, { properties: ['openFile'] })
          : await dialog.showOpenDialog({ properties: ['openFile'] })
        return { canceled: result.canceled, filePaths: result.filePaths }
      },
      issuePath: (path) => trustedPaths.issue(path),
    }),
    droppedFile: createDroppedFileHandlers({
      issuePath: (path) => trustedPaths.issue(path),
    }),
  })

  const openWindow = (): BrowserWindow =>
    createMainWindow({
      preloadPath: join(import.meta.dirname, '../preload/index.cjs'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererFile: join(import.meta.dirname, '../renderer/index.html'),
    })

  window = openWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) window = openWindow()
  })
}

function bootstrap(): void {
  // Two mains would race each other over settings.json and the model store.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  // A relaunch while we're already running quits the second copy (above) and
  // fires this on the first instead — surface the existing window rather
  // than leaving the relaunch look like it silently did nothing.
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.whenReady()
    .then(setup)
    .catch((cause) => {
      // No window exists yet to show this in — the only place left is the
      // console — and a partially-initialised app is worse than none.
      console.error('whisper-drop: failed to start', cause)
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // The one temp-WAV escape path part 1 could not close: quitting mid-job.
  app.on('before-quit', (event) => {
    if (quitting || transcribe === null) return
    quitting = true
    event.preventDefault()
    void transcribe.cancelActive().finally(() => app.quit())
  })
}

bootstrap()
