import { ipcMain } from 'electron'
import { CHANNELS, type Channel } from '../../shared/ipc.js'
import type { DialogHandlers } from './dialog.js'
import type { DroppedFileHandlers } from './dropped-file.js'
import { toResult } from './errors.js'
import type { ExportHandlers } from './export.js'
import type { ModelHandlers } from './models.js'
import type { SettingsHandlers } from './settings.js'
import type { TranscribeHandlers } from './transcribe.js'

export type AppHandlers = {
  transcribe: TranscribeHandlers
  models: ModelHandlers
  settings: SettingsHandlers
  export: ExportHandlers
  dialog: DialogHandlers
  droppedFile: DroppedFileHandlers
}

/**
 * The only place `ipcMain` is touched. Every handler is wrapped so a rejection
 * crosses as data rather than as an Error whose `code` the bridge would strip.
 */
export function registerIpcHandlers(handlers: AppHandlers): void {
  function handle<T>(channel: Channel, run: (...args: unknown[]) => T | Promise<T>): void {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => toResult(() => run(...args)))
  }

  handle(CHANNELS.transcribeStart, (filePath) => handlers.transcribe.start(filePath))
  handle(CHANNELS.transcribeCancel, (jobId) => handlers.transcribe.cancel(jobId))

  handle(CHANNELS.modelsList, () => handlers.models.list())
  handle(CHANNELS.modelsDownload, (base) => handlers.models.download(base))
  handle(CHANNELS.modelsCancelDownload, (base) => handlers.models.cancelDownload(base))
  handle(CHANNELS.modelsRemove, (base) => handlers.models.remove(base))

  handle(CHANNELS.settingsGet, () => handlers.settings.get())
  handle(CHANNELS.settingsSet, (patch) => handlers.settings.set(patch))

  handle(CHANNELS.exportSave, (jobId, format) => handlers.export.save(jobId, format))
  handle(CHANNELS.dialogOpenFile, () => handlers.dialog.openFile())
  handle(CHANNELS.shellReveal, (path) => handlers.export.reveal(path))

  handle(CHANNELS.droppedFileRegister, (path) => handlers.droppedFile.register(path))
}
