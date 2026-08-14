import type { IpcFailure, ModelRow } from '../../shared/ipc.js'
import type { JobState, Settings } from '../../shared/types.js'

/** The five states the spec fixes. `first-run` doubles as the model picker. */
export type AppView = 'first-run' | 'idle' | 'working' | 'done' | 'error'

export type AppState = {
  settings: Settings | null
  models: ModelRow[]
  job: JobState | null
  /** Set on cancel so buffered segments cannot advance the bar afterwards. */
  frozen: boolean
  error: IpcFailure | null
  /** The path of the last export, for the toast's Reveal action. */
  savedPath: string | null
  /** The picker is reachable at any time, so it overlays a view rather than being one. */
  pickerOpen: boolean
  /** True between dropping a file and the first JobState arriving. */
  starting: boolean
}

export type AppEvent =
  | { type: 'loaded'; settings: Settings; models: ModelRow[] }
  | { type: 'models-changed'; models: ModelRow[] }
  | { type: 'settings-changed'; settings: Settings }
  | { type: 'start-requested' }
  | { type: 'job-state'; state: JobState }
  | { type: 'cancel-requested' }
  | { type: 'failed'; error: IpcFailure }
  | { type: 'saved'; path: string }
  | { type: 'toast-dismissed' }
  | { type: 'picker-opened' }
  | { type: 'picker-closed' }
  | { type: 'reset' }

export const INITIAL_STATE: AppState = {
  settings: null,
  models: [],
  job: null,
  frozen: false,
  error: null,
  savedPath: null,
  pickerOpen: false,
  starting: false,
}

/** The row the active model resolves to under the current toggle, if any. */
export function activeRow(state: AppState): ModelRow | undefined {
  if (!state.settings || state.settings.activeModel === null) return undefined
  return state.models.find((row) => row.base === state.settings?.activeModel)
}

/**
 * Ready means the *resolved* model is on disk. Flipping the English-only
 * toggle can therefore un-ready an app that was ready a moment ago, because
 * `base` and `base.en` are separate files — which is exactly when the picker
 * should come back.
 */
export function isReady(state: AppState): boolean {
  return activeRow(state)?.installed === true
}

export function viewFor(state: AppState): AppView {
  if (state.error) return 'error'

  if (state.job) {
    if (state.job.phase === 'failed') return 'error'
    if (state.job.phase === 'done') return 'done'
    if (state.job.phase !== 'cancelled') return 'working'
  }

  if (state.starting) return 'working'

  return isReady(state) ? 'idle' : 'first-run'
}

export function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'loaded':
      return { ...state, settings: event.settings, models: event.models }

    case 'models-changed':
      return { ...state, models: event.models }

    case 'settings-changed':
      return { ...state, settings: event.settings }

    case 'start-requested':
      return { ...state, starting: true, job: null, error: null, frozen: false, savedPath: null }

    case 'job-state': {
      // A late update from a job the UI has already moved on from. Dropping it
      // is what stops a cancelled run's buffered segments reopening Working.
      if (state.job && state.job.id !== event.state.id && !state.starting) return state

      if (event.state.phase === 'cancelled') {
        return { ...state, job: null, starting: false, frozen: false, error: null }
      }

      if (event.state.phase === 'failed') {
        return {
          ...state,
          job: event.state,
          starting: false,
          error: event.state.error ?? { code: 'UNEXPECTED', message: 'Transcription failed.' },
        }
      }

      // Frozen: take the new phase and segments, keep the progress and ETA the
      // user last saw, so the bar stops rather than creeping after Cancel.
      const next =
        state.frozen && state.job
          ? { ...event.state, progress: state.job.progress, etaMs: state.job.etaMs }
          : event.state

      return { ...state, job: next, starting: false }
    }

    case 'cancel-requested':
      return { ...state, frozen: true }

    case 'failed':
      return { ...state, error: event.error, starting: false }

    case 'saved':
      return { ...state, savedPath: event.path }

    case 'toast-dismissed':
      return { ...state, savedPath: null }

    case 'picker-opened':
      return { ...state, pickerOpen: true }

    case 'picker-closed':
      return { ...state, pickerOpen: false }

    case 'reset':
      return { ...state, job: null, error: null, frozen: false, savedPath: null, starting: false }
  }
}
