import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import type { ModelRow, WhisperDropApi } from '../../src/shared/ipc.js'
import type { DownloadProgress, JobState, Settings } from '../../src/shared/types.js'

afterEach(() => {
  cleanup()
})

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

export function modelRow(overrides: Partial<ModelRow> & Pick<ModelRow, 'base'>): ModelRow {
  return {
    resolved: {
      id: overrides.base,
      base: overrides.base,
      label: overrides.base,
      bytes: 147_951_465,
      sha256: 'x'.repeat(64),
      url: `https://example.invalid/${overrides.base}`,
      blurb: 'Good default. Quick, decent accuracy.',
      englishOnly: false,
    },
    installed: false,
    ...overrides,
  }
}

export type FakeApi = {
  api: WhisperDropApi
  /** Push a JobState to every `transcribe.onState` subscriber. */
  emitState: (state: JobState) => void
  /** Push a DownloadProgress to every `models.onProgress` subscriber. */
  emitProgress: (progress: DownloadProgress) => void
  /** How many subscribers are live — asserts effects clean up on unmount. */
  stateSubscribers: () => number
}

export function installFakeApi(overrides: Partial<WhisperDropApi> = {}): FakeApi {
  const stateListeners = new Set<(state: JobState) => void>()
  const progressListeners = new Set<(progress: DownloadProgress) => void>()

  const api: WhisperDropApi = {
    transcribe: {
      start: vi.fn(async () => 'job-1'),
      cancel: vi.fn(async () => {}),
      onState: (callback) => {
        stateListeners.add(callback)
        return () => stateListeners.delete(callback)
      },
      ...overrides.transcribe,
    },
    models: {
      list: vi.fn(async () => [] as ModelRow[]),
      download: vi.fn(async () => {}),
      cancelDownload: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      onProgress: (callback) => {
        progressListeners.add(callback)
        return () => progressListeners.delete(callback)
      },
      ...overrides.models,
    },
    settings: {
      get: vi.fn(async () => DEFAULT_SETTINGS),
      set: vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch })),
      ...overrides.settings,
    },
    exportTranscript: {
      save: vi.fn(async () => '/videos/interview.srt'),
      ...overrides.exportTranscript,
    },
    dialog: { openFile: vi.fn(async () => null), ...overrides.dialog },
    shell: { reveal: vi.fn(async () => {}), ...overrides.shell },
    droppedFile: { pathFor: vi.fn(() => '/videos/interview.mp4'), ...overrides.droppedFile },
  }

  Object.defineProperty(window, 'whisperDrop', { value: api, configurable: true, writable: true })

  return {
    api,
    emitState: (state) => {
      for (const listener of [...stateListeners]) listener(state)
    },
    emitProgress: (progress) => {
      for (const listener of [...progressListeners]) listener(progress)
    },
    stateSubscribers: () => stateListeners.size,
  }
}
