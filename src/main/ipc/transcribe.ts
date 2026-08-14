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
   * Non-consuming: true if `filePath` is one main itself issued, via
   * `dialog.openFile` or a dropped file's `pathFor`. The renderer cannot name
   * a path main did not first hand it — this is what enforces that. Checked
   * before any later step (busy, no model, model missing) that can still
   * reject the request, so a rejection there doesn't spend the path — see
   * `consumeTrustedPath`.
   */
  hasTrustedPath: (filePath: string) => boolean
  /** Spends the trust entry. Called only once `start` is committed to running. */
  consumeTrustedPath: (filePath: string) => void
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
  // Resolves once the in-flight start() has either produced a job or failed.
  // Before that, activeId is still null — there is no job for cancelActive to
  // cancel yet — but a temp WAV may be about to be created, so a quit landing
  // in this window must wait it out rather than proceeding immediately.
  let pendingStart: Promise<void> = Promise.resolve()

  async function start(filePath: unknown): Promise<string> {
    const path = requireNonEmptyString(filePath, 'filePath')

    // Boundary check first, before the busy check: a forged path is rejected
    // the same way whether or not a job happens to be running. Non-consuming:
    // spending the entry here would strand a legitimate retry behind a later
    // rejection (busy / no model / model missing) — see consumeTrustedPath
    // below, called only once start is committed to running.
    if (!deps.hasTrustedPath(path)) {
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

    let settlePendingStart: () => void = () => {}
    pendingStart = new Promise((resolve) => {
      settlePendingStart = resolve
    })

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

      // Spent only now: every check above can still reject, and a rejection
      // must not burn the one path a retry would need.
      deps.consumeTrustedPath(path)

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
      settlePendingStart()
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
    // Wait out any start() that hasn't reached job.start() yet — before it
    // settles, activeId is still null and there is nothing here to cancel.
    await pendingStart
    if (activeId !== null) jobs.get(activeId)?.cancel()
    await activeRun.catch(() => {})
  }

  return { start, cancel, stateOf, cancelActive }
}
