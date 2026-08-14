import { AppError } from '../../shared/errors.js'
import type { JobPhase, JobState, ModelId, Settings, Unsubscribe } from '../../shared/types.js'
import type { JobInput } from '../jobs/transcription-job.js'
import { resolveModelId } from '../models/catalog.js'
import { IpcError } from './errors.js'
import { requireNonEmptyString } from './validate.js'

/** The part of `TranscriptionJob` this module uses, so tests can inject a fake. */
export type JobLike = {
  readonly id: string
  readonly state: JobState
  start(): Promise<void>
  cancel(): void
  subscribe(listener: (state: JobState) => void): Unsubscribe
}

export type TranscribeDeps = {
  newJobId: () => string
  readSettings: () => Promise<Settings>
  modelPathFor: (id: ModelId) => string
  isInstalled: (id: ModelId) => Promise<boolean>
  createJob: (input: JobInput) => JobLike
  recordThroughput: (id: ModelId, realtimeFactor: number) => Promise<unknown>
  emitState: (state: JobState) => void
  /**
   * True and consumes the entry if `filePath` is one main itself issued, via
   * `dialog.openFile` or a dropped file's `pathFor`. The renderer cannot name
   * a path main did not first hand it — this is what enforces that.
   */
  consumeTrustedPath: (filePath: string) => boolean
}

export type TranscribeHandlers = {
  start(filePath: unknown): Promise<string>
  cancel(jobId: unknown): Promise<void>
  /** For the export handler. Not reachable over IPC. */
  stateOf(jobId: string): JobState | undefined
  /** For `before-quit`: cancel and wait for the temp WAV to be deleted. */
  cancelActive(): Promise<void>
}

function isTerminal(phase: JobPhase): boolean {
  return phase === 'done' || phase === 'cancelled' || phase === 'failed'
}

export function createTranscribeHandlers(deps: TranscribeDeps): TranscribeHandlers {
  // The id is a key here and nothing else. It is generated in main and never
  // reaches a path builder the renderer can influence.
  const jobs = new Map<string, JobLike>()
  let activeId: string | null = null
  // Set before the first await so two starts racing across it can't both pass
  // the busy check.
  let starting = false
  let activeRun: Promise<void> = Promise.resolve()

  async function start(filePath: unknown): Promise<string> {
    const path = requireNonEmptyString(filePath, 'filePath')

    // Boundary check first, before the busy check: a forged path is rejected
    // the same way whether or not a job happens to be running.
    if (!deps.consumeTrustedPath(path)) {
      throw new IpcError(
        'INVALID_REQUEST',
        'That file was not selected through whisper-drop.',
        `filePath=${JSON.stringify(path.slice(0, 200))}`,
      )
    }

    if (starting || activeId !== null) {
      throw new IpcError(
        'JOB_ALREADY_RUNNING',
        'whisper-drop transcribes one file at a time. Cancel the current one first.',
      )
    }
    starting = true

    try {
      const settings = await deps.readSettings()
      if (settings.activeModel === null) {
        throw new AppError('NO_MODEL_INSTALLED', 'Choose a model first.')
      }

      const modelId = resolveModelId(settings.activeModel, settings.englishOnly)
      if (!(await deps.isInstalled(modelId))) {
        throw new AppError(
          'MODEL_FILE_MISSING',
          "That model isn't on disk anymore.",
          `model=${modelId}`,
        )
      }

      const id = deps.newJobId()
      const job = deps.createJob({
        id,
        filePath: path,
        modelPath: deps.modelPathFor(modelId),
        language: settings.englishOnly ? 'en' : settings.language,
      })

      // Starting a new file means the UI has left Done, so the previous job's
      // segments are unreachable. Clearing here is what keeps the map at one
      // entry instead of retaining every transcript of the session.
      jobs.clear()
      jobs.set(id, job)
      activeId = id

      let recorded = false
      job.subscribe((state) => {
        deps.emitState(state)

        if (!recorded && state.phase === 'done' && state.realtimeFactor !== undefined) {
          recorded = true
          void deps.recordThroughput(modelId, state.realtimeFactor).catch(() => {})
        }

        if (isTerminal(state.phase) && activeId === id) activeId = null
      })

      activeRun = job.start()
      void activeRun.catch(() => {})

      return id
    } finally {
      starting = false
    }
  }

  async function cancel(jobId: unknown): Promise<void> {
    const id = requireNonEmptyString(jobId, 'jobId')
    const job = jobs.get(id)
    if (!job) {
      throw new IpcError('INVALID_REQUEST', 'That transcription is no longer running.', `jobId=${id}`)
    }
    job.cancel()
  }

  function stateOf(jobId: string): JobState | undefined {
    return jobs.get(jobId)?.state
  }

  async function cancelActive(): Promise<void> {
    if (activeId !== null) jobs.get(activeId)?.cancel()
    await activeRun.catch(() => {})
  }

  return { start, cancel, stateOf, cancelActive }
}
