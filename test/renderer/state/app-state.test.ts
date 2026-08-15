import { describe, expect, it } from 'vitest'
import {
  INITIAL_STATE,
  activeRow,
  isReady,
  reduce,
  viewFor,
  type AppEvent,
  type AppState,
} from '../../../src/renderer/state/app-state.js'
import type { ModelRow } from '../../../src/shared/ipc.js'
import type { JobState, Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

const row = (base: ModelRow['base'], installed: boolean): ModelRow => ({
  base,
  resolved: {
    id: base,
    base,
    label: base,
    bytes: 1,
    sha256: 'x',
    url: 'x',
    blurb: 'x',
    englishOnly: false,
  },
  installed,
})

const job = (patch: Partial<JobState> = {}): JobState => ({
  id: 'job-1',
  filePath: '/videos/interview.mp4',
  phase: 'transcribing',
  progress: 0.5,
  segments: [],
  ...patch,
})

/** Fold a sequence of events, the way the app actually applies them. */
function run(events: AppEvent[], from: AppState = INITIAL_STATE): AppState {
  return events.reduce(reduce, from)
}

const READY = run([
  { type: 'loaded', settings: SETTINGS, models: [row('tiny', false), row('base', true)] },
])

describe('viewFor', () => {
  it('starts on first-run before anything has loaded', () => {
    expect(viewFor(INITIAL_STATE)).toBe('first-run')
  })

  it('shows first-run when no model is chosen', () => {
    expect(
      viewFor(run([{ type: 'loaded', settings: { ...SETTINGS, activeModel: null }, models: [] }])),
    ).toBe('first-run')
  })

  it('shows first-run when the chosen model is not installed', () => {
    expect(
      viewFor(run([{ type: 'loaded', settings: SETTINGS, models: [row('base', false)] }])),
    ).toBe('first-run')
  })

  it('shows idle once the chosen model is installed', () => {
    expect(viewFor(READY)).toBe('idle')
  })

  it('shows working from the moment a file is accepted, before the first state arrives', () => {
    expect(viewFor(run([{ type: 'start-requested' }], READY))).toBe('working')
  })

  it('shows working through every running phase', () => {
    for (const phase of ['probing', 'preparing', 'transcribing'] as const) {
      expect(viewFor(run([{ type: 'job-state', state: job({ phase }) }], READY)), phase).toBe(
        'working',
      )
    }
  })

  it('shows done when the job completes', () => {
    expect(viewFor(run([{ type: 'job-state', state: job({ phase: 'done' }) }], READY))).toBe('done')
  })

  it('returns to idle when the job is cancelled — cancelling is not an error', () => {
    expect(
      viewFor(run([{ type: 'job-state', state: job({ phase: 'cancelled' }) }], READY)),
    ).toBe('idle')
  })

  it('shows error when the job fails', () => {
    expect(
      viewFor(
        run(
          [
            {
              type: 'job-state',
              state: job({ phase: 'failed', error: { code: 'WHISPER_FAILED', message: 'boom' } }),
            },
          ],
          READY,
        ),
      ),
    ).toBe('error')
  })

  it('shows error when an IPC call fails outright', () => {
    expect(viewFor(run([{ type: 'failed', error: { code: 'NO_MODEL_INSTALLED', message: 'x' } }], READY))).toBe(
      'error',
    )
  })

  it('is not one of the five states for the picker — the picker overlays them', () => {
    const state = run([{ type: 'picker-opened' }], READY)

    expect(state.pickerOpen).toBe(true)
    expect(viewFor(state)).toBe('idle')
  })

  it('is not one of the five states for licenses either — same overlay treatment', () => {
    const state = run([{ type: 'licenses-opened' }], READY)

    expect(state.licensesOpen).toBe(true)
    expect(viewFor(state)).toBe('idle')
  })

  it('licenses-closed clears licensesOpen', () => {
    const state = run([{ type: 'licenses-opened' }, { type: 'licenses-closed' }], READY)

    expect(state.licensesOpen).toBe(false)
  })
})

describe('the English-only toggle', () => {
  it('un-readies the app when the toggle resolves to a model that is not installed', () => {
    const state = run(
      [
        { type: 'settings-changed', settings: { ...SETTINGS, englishOnly: true } },
        { type: 'models-changed', models: [row('base', false)] },
      ],
      READY,
    )

    expect(isReady(state)).toBe(false)
    expect(viewFor(state)).toBe('first-run')
  })

  it('finds the row for the active model', () => {
    expect(activeRow(READY)?.base).toBe('base')
  })

  it('finds no row when no model is active', () => {
    expect(
      activeRow(run([{ type: 'settings-changed', settings: { ...SETTINGS, activeModel: null } }], READY)),
    ).toBeUndefined()
  })
})

describe('progress freezing on cancel', () => {
  it('keeps the displayed progress and eta after cancel is requested', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ progress: 0.5, etaMs: 30_000 }) },
        { type: 'cancel-requested' },
        { type: 'job-state', state: job({ progress: 0.62, etaMs: 21_000 }) },
      ],
      READY,
    )

    expect(state.job?.progress).toBe(0.5)
    expect(state.job?.etaMs).toBe(30_000)
  })

  it('still takes the new segments and phase, so the state stays honest', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ progress: 0.5 }) },
        { type: 'cancel-requested' },
        {
          type: 'job-state',
          state: job({
            progress: 0.62,
            segments: [{ index: 0, startMs: 0, endMs: 1, text: 'late' }],
          }),
        },
      ],
      READY,
    )

    expect(state.job?.segments).toHaveLength(1)
  })

  it('unfreezes when the cancellation lands', () => {
    const state = run(
      [
        { type: 'job-state', state: job() },
        { type: 'cancel-requested' },
        { type: 'job-state', state: job({ phase: 'cancelled' }) },
      ],
      READY,
    )

    expect(state.frozen).toBe(false)
    expect(state.job).toBeNull()
  })
})

describe('stale job updates', () => {
  it('ignores an update for a job the UI has moved past', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ id: 'job-2', progress: 0.9 }) },
        { type: 'job-state', state: job({ id: 'job-1', progress: 0.1 }) },
      ],
      READY,
    )

    expect(state.job?.id).toBe('job-2')
    expect(state.job?.progress).toBe(0.9)
  })

  it('accepts the first update after a start, whatever its id', () => {
    const state = run([{ type: 'start-requested' }, { type: 'job-state', state: job() }], READY)

    expect(state.job?.id).toBe('job-1')
  })
})

describe('reset', () => {
  it('clears the job, error, toast and freeze so the drop zone comes back', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ phase: 'done' }) },
        { type: 'saved', path: '/videos/interview.srt' },
        { type: 'reset' },
      ],
      READY,
    )

    expect(state).toMatchObject({ job: null, error: null, savedPath: null, frozen: false })
    expect(viewFor(state)).toBe('idle')
  })

  it('leaves the models and settings alone', () => {
    const state = run([{ type: 'reset' }], READY)

    expect(state.settings).toEqual(SETTINGS)
    expect(state.models).toHaveLength(2)
  })

  it('clears a previous run when a new file is dropped', () => {
    const state = run(
      [
        { type: 'job-state', state: job({ phase: 'done' }) },
        { type: 'saved', path: '/videos/interview.srt' },
        { type: 'start-requested' },
      ],
      READY,
    )

    expect(state).toMatchObject({ job: null, error: null, savedPath: null, starting: true })
  })
})

describe('the export toast', () => {
  it('records the saved path', () => {
    expect(run([{ type: 'saved', path: '/videos/a.srt' }], READY).savedPath).toBe('/videos/a.srt')
  })

  it('clears on dismissal', () => {
    expect(
      run([{ type: 'saved', path: '/videos/a.srt' }, { type: 'toast-dismissed' }], READY).savedPath,
    ).toBeNull()
  })
})

describe('a failed job', () => {
  it('carries the job’s own error into the error view', () => {
    const state = run(
      [
        {
          type: 'job-state',
          state: job({
            phase: 'failed',
            error: { code: 'FFMPEG_FAILED', message: 'Nope.', detail: 'exit 1' },
          }),
        },
      ],
      READY,
    )

    expect(state.error).toEqual({ code: 'FFMPEG_FAILED', message: 'Nope.', detail: 'exit 1' })
  })

  it('substitutes a failure when the job somehow failed without one', () => {
    const state = run([{ type: 'job-state', state: job({ phase: 'failed' }) }], READY)

    expect(state.error?.code).toBe('UNEXPECTED')
  })
})
