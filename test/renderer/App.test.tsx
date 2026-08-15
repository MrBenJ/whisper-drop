// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/App.js'
import type { JobState } from '../../src/shared/types.js'
import { installFakeApi, modelRow } from './fake-api.js'

/** The one installed row that puts the app in the `idle` view (ready to
 * transcribe) instead of `first-run`, for tests that don't care about the
 * picker itself. */
function readyModels() {
  return [modelRow({ base: 'base', installed: true })]
}

async function waitForReady(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('browse')).toBeTruthy())
}

describe('App', () => {
  it('unsubscribes from transcribe.onState and models.onProgress on unmount', async () => {
    const fake = installFakeApi()

    const { unmount } = render(<App />)

    await waitFor(() => {
      expect(fake.api.settings.get).toHaveBeenCalled()
    })

    // Proves the subscription happened at all — a `0` here from a broken
    // effect would otherwise let the unmount assertion below pass vacuously.
    expect(fake.stateSubscribers()).toBe(1)
    expect(fake.progressSubscribers()).toBe(1)

    unmount()

    expect(fake.stateSubscribers()).toBe(0)
    expect(fake.progressSubscribers()).toBe(0)
  })

  it('Browse opens the file dialog and starts a transcription with the chosen path', async () => {
    const start = vi.fn(async () => 'job-1')
    const openFile = vi.fn(async () => '/videos/interview.mp4')
    installFakeApi({
      models: { list: vi.fn(async () => readyModels()) } as never,
      dialog: { openFile } as never,
      transcribe: { start } as never,
    })

    render(<App />)
    await waitForReady()

    fireEvent.click(screen.getByTestId('browse'))

    await waitFor(() => expect(openFile).toHaveBeenCalledOnce())
    await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith('/videos/interview.mp4'))
  })

  it('downloading a model refreshes the model list and clears the downloading state once it settles', async () => {
    let installed = false
    const list = vi.fn(async () => [modelRow({ base: 'base', installed })])
    const download = vi.fn(async () => {
      installed = true
    })
    installFakeApi({ models: { list, download } as never })

    render(<App />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))

    expect(download).toHaveBeenCalledExactlyOnceWith('base')
    // downloadModel's own finally re-lists, on top of the initial load — the
    // re-list is what turns `installed` into `true` for the app's next
    // render, flipping it out of first-run into the ready `idle` view.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await waitForReady()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('a successful save shows the toast, and Reveal calls shell.reveal with the saved path', async () => {
    const save = vi.fn(async () => '/videos/interview.srt')
    const reveal = vi.fn(async () => {})
    const fake = installFakeApi({
      models: { list: vi.fn(async () => readyModels()) } as never,
      dialog: { openFile: vi.fn(async () => '/videos/interview.mp4') } as never,
      exportTranscript: { save } as never,
      shell: { reveal } as never,
    })

    render(<App />)
    await waitForReady()
    fireEvent.click(screen.getByTestId('browse'))
    await waitFor(() => expect(fake.api.transcribe.start).toHaveBeenCalled())

    fake.emitState({
      id: 'job-1',
      filePath: '/videos/interview.mp4',
      phase: 'done',
      progress: 1,
      segments: [{ index: 0, startMs: 0, endMs: 1_000, text: 'Hello world.' }],
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Save .srt' }))

    await waitFor(() => expect(screen.getByText('Saved interview.srt')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    await waitFor(() => expect(reveal).toHaveBeenCalledExactlyOnceWith('/videos/interview.srt'))
  })

  // C1: a failed export must never destroy the finished transcript. Before
  // this fix, export.ts's UNEXPECTED wrapping routed a failed save through
  // the app-level error view, whose only action (dismiss/"Start over")
  // dispatched `reset` and nulled `job` — wiping a transcript main still had.
  it('a failed export leaves the transcript on screen and Save still available (C1)', async () => {
    let saveAttempts = 0
    const save = vi.fn(async () => {
      saveAttempts += 1
      if (saveAttempts === 1) throw Object.assign(new Error('EROFS'), { code: 'EROFS' })
      return '/videos/interview.srt'
    })
    const fake = installFakeApi({
      models: { list: vi.fn(async () => readyModels()) } as never,
      dialog: { openFile: vi.fn(async () => '/videos/interview.mp4') } as never,
      exportTranscript: { save } as never,
    })

    render(<App />)
    await waitForReady()
    fireEvent.click(screen.getByTestId('browse'))
    await waitFor(() => expect(fake.api.transcribe.start).toHaveBeenCalled())

    fake.emitState({
      id: 'job-1',
      filePath: '/videos/interview.mp4',
      phase: 'done',
      progress: 1,
      segments: [{ index: 0, startMs: 0, endMs: 1_000, text: 'Do not lose me.' }],
    })

    await screen.findByTestId('transcript')
    fireEvent.click(screen.getByRole('button', { name: 'Save .srt' }))

    // The offered action, right here in Done — not the app-level error view.
    await screen.findByRole('alert')
    expect(screen.getByTestId('transcript').textContent).toContain('Do not lose me.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    // Still Done, still the same transcript, Save still available.
    expect(screen.getByTestId('transcript').textContent).toContain('Do not lose me.')
    fireEvent.click(screen.getByRole('button', { name: 'Save .srt' }))

    await waitFor(() => expect(screen.getByText('Saved interview.srt')).toBeTruthy())
    expect(saveAttempts).toBe(2)
  })

  // I2: a transcription failure must leave a working Retry, not a dead end.
  // Before the main-side fix (re-issuing the trusted path on `failed`), the
  // renderer plumbing exercised here already worked — this guards the
  // renderer half so a regression to the main-side fix shows up here too via
  // the second `start()` call actually happening and actually completing.
  it('Retry after a transcription failure starts and completes a second job (I2)', async () => {
    let starts = 0
    const start = vi.fn(async () => {
      starts += 1
      return starts === 1 ? 'job-1' : 'job-2'
    })
    const fake = installFakeApi({
      models: { list: vi.fn(async () => readyModels()) } as never,
      dialog: { openFile: vi.fn(async () => '/videos/interview.mp4') } as never,
      transcribe: { start } as never,
    })

    render(<App />)
    await waitForReady()
    fireEvent.click(screen.getByTestId('browse'))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))

    const failed: JobState = {
      id: 'job-1',
      filePath: '/videos/interview.mp4',
      phase: 'failed',
      progress: 0.4,
      segments: [],
      error: { code: 'WHISPER_FAILED', message: 'It broke.' },
    }
    fake.emitState(failed)

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(start).toHaveBeenNthCalledWith(2, '/videos/interview.mp4')

    fake.emitState({
      id: 'job-2',
      filePath: '/videos/interview.mp4',
      phase: 'done',
      progress: 1,
      segments: [{ index: 0, startMs: 0, endMs: 1_000, text: 'Second try worked.' }],
    })

    await waitFor(() =>
      expect(screen.getByTestId('transcript').textContent).toContain('Second try worked.'),
    )
  })

  it('the Licenses button in the header opens the Licenses dialog, and Close dismisses it', async () => {
    installFakeApi({ models: { list: vi.fn(async () => readyModels()) } as never })

    render(<App />)
    await waitForReady()

    fireEvent.click(screen.getByRole('button', { name: 'Licenses' }))
    expect(screen.getByRole('dialog', { name: 'Licenses' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
