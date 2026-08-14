import type {
  DownloadProgress,
  ErrorCode,
  ExportFormat,
  JobState,
  ModelBaseId,
  ModelEntry,
  Settings,
  Unsubscribe,
} from './types.js'

/** Every channel the renderer can reach. Anything not here is unreachable. */
export const CHANNELS = {
  transcribeStart: 'transcribe:start',
  transcribeCancel: 'transcribe:cancel',
  /** main -> renderer */
  transcribeState: 'transcribe:state',
  modelsList: 'models:list',
  modelsDownload: 'models:download',
  modelsCancelDownload: 'models:cancelDownload',
  modelsRemove: 'models:remove',
  /** main -> renderer */
  modelsProgress: 'models:progress',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  exportSave: 'export:save',
  dialogOpenFile: 'dialog:openFile',
  shellReveal: 'shell:reveal',
  /**
   * Renderer -> main only, fired from inside the preload's `pathFor`. Not on
   * `WhisperDropApi` — it isn't a capability the renderer calls deliberately,
   * it's how main learns a path it must trust for `transcribe.start`. See
   * `src/main/ipc/trusted-paths.ts`.
   */
  droppedFileRegister: 'droppedFile:register',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

/**
 * `ErrorCode` covers failures of real operations and is fixed by the parent
 * spec. These three are boundary conditions the renderer can only reach by
 * being wrong or malicious, so they live here rather than widening `ErrorCode`.
 */
export type IpcBoundaryCode = 'INVALID_REQUEST' | 'JOB_ALREADY_RUNNING' | 'UNEXPECTED'

export type IpcErrorCode = ErrorCode | IpcBoundaryCode

export const IPC_BOUNDARY_CODES = [
  'INVALID_REQUEST',
  'JOB_ALREADY_RUNNING',
  'UNEXPECTED',
] as const satisfies readonly IpcBoundaryCode[]

export type IpcFailure = {
  code: IpcErrorCode
  /** Plain language, shown directly. */
  message: string
  /** Technical detail, shown behind a disclosure. */
  detail?: string
}

/**
 * Every handler answers with this. Errors travel as data because
 * `contextBridge` copies only `message` and `stack` off a thrown Error, which
 * would drop the `code` and `detail` the error UI is built from.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcFailure }

/** One picker row, already resolved against the English-only toggle. */
export type ModelRow = {
  base: ModelBaseId
  resolved: ModelEntry
  installed: boolean
  /** Measured on this machine. Absent if this model has never been run. */
  realtimeFactor?: number
  downloading?: DownloadProgress
}

/** The complete surface exposed on `window.whisperDrop`. */
export type WhisperDropApi = {
  transcribe: {
    start(filePath: string): Promise<string>
    cancel(jobId: string): Promise<void>
    onState(callback: (state: JobState) => void): Unsubscribe
  }
  models: {
    list(): Promise<ModelRow[]>
    download(base: ModelBaseId): Promise<void>
    cancelDownload(base: ModelBaseId): Promise<void>
    remove(base: ModelBaseId): Promise<void>
    onProgress(callback: (progress: DownloadProgress) => void): Unsubscribe
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  exportTranscript: {
    save(jobId: string, format: ExportFormat): Promise<string>
  }
  dialog: {
    openFile(): Promise<string | null>
  }
  shell: {
    reveal(path: string): Promise<void>
  }
  droppedFile: {
    /**
     * Electron 32 removed `File.path`. A dropped file's real path is only
     * obtainable from the preload, via `webUtils.getPathForFile`. The preload
     * also reports the path to main over `droppedFileRegister` so
     * `transcribe.start` can trust it — see `src/main/ipc/trusted-paths.ts`.
     */
    pathFor(file: File): string
  }
}
