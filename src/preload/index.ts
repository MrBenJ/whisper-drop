import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CHANNELS, type IpcResult, type ModelRow, type WhisperDropApi } from '../shared/ipc.js'
import type { DownloadProgress, JobState, Settings, Unsubscribe } from '../shared/types.js'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (result.ok) return result.value
  // Rejected with the plain failure object rather than an Error: contextBridge
  // copies only `message` and `stack` off an Error, which would drop `code`
  // and `detail` — the two fields the error UI is built from.
  throw result.error
}

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const api: WhisperDropApi = {
  transcribe: {
    start: (filePath) => invoke<string>(CHANNELS.transcribeStart, filePath),
    cancel: (jobId) => invoke<void>(CHANNELS.transcribeCancel, jobId),
    onState: (callback) => subscribe<JobState>(CHANNELS.transcribeState, callback),
  },
  models: {
    list: () => invoke<ModelRow[]>(CHANNELS.modelsList),
    download: (base) => invoke<void>(CHANNELS.modelsDownload, base),
    cancelDownload: (base) => invoke<void>(CHANNELS.modelsCancelDownload, base),
    remove: (base) => invoke<void>(CHANNELS.modelsRemove, base),
    onProgress: (callback) => subscribe<DownloadProgress>(CHANNELS.modelsProgress, callback),
  },
  settings: {
    get: () => invoke<Settings>(CHANNELS.settingsGet),
    set: (patch) => invoke<Settings>(CHANNELS.settingsSet, patch),
  },
  exportTranscript: {
    save: (jobId, format) => invoke<string>(CHANNELS.exportSave, jobId, format),
  },
  dialog: {
    openFile: () => invoke<string | null>(CHANNELS.dialogOpenFile),
  },
  shell: {
    reveal: (path) => invoke<void>(CHANNELS.shellReveal, path),
  },
  droppedFile: {
    pathFor: (file) => {
      const path = webUtils.getPathForFile(file)
      // Fire-and-forget, and safe to not await: ipcRenderer.invoke preserves
      // send order over its one channel, and the main-side register handler
      // does no awaiting of its own, so it is fully handled before the next
      // message — the transcribe:start this path is about to be used for —
      // is even dispatched. An empty path (the synthetic-File case the e2e
      // test's comment describes) is not registered; transcribe.start would
      // reject an empty path before it ever checks trust anyway.
      if (path) void ipcRenderer.invoke(CHANNELS.droppedFileRegister, path).catch(() => {})
      return path
    },
  },
}

contextBridge.exposeInMainWorld('whisperDrop', api)
