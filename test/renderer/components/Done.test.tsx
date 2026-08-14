// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Done } from '../../../src/renderer/components/Done.js'
import type { JobState, Segment } from '../../../src/shared/types.js'
import '../fake-api.js'

function segment(patch: Partial<Segment> = {}): Segment {
  return { index: 0, startMs: 0, endMs: 1000, text: 'hello', ...patch }
}

function job(segments: Segment[] = [], patch: Partial<JobState> = {}): JobState {
  return {
    id: 'job-1',
    filePath: '/videos/interview.mp4',
    phase: 'done',
    progress: 1,
    segments,
    ...patch,
  }
}

function handlers() {
  return { onSave: vi.fn(async () => {}), onCopy: vi.fn(async () => {}), onReset: vi.fn() }
}

describe('Done', () => {
  it('shows the source filename, not the full path', () => {
    const h = handlers()
    render(<Done job={job()} {...h} />)

    const text = screen.getByTestId('source-name').textContent
    expect(text).toBe('interview.mp4')
    expect(text).not.toContain('/videos/')
  })

  it('renders segment text inside data-testid="transcript"', () => {
    const h = handlers()
    render(<Done job={job([segment({ text: 'a short transcript' })])} {...h} />)

    expect(screen.getByTestId('transcript').textContent).toContain('a short transcript')
  })

  it('joins segments less than 1500 ms apart into one paragraph', () => {
    const h = handlers()
    render(
      <Done
        job={job([
          segment({ startMs: 0, endMs: 1000, text: 'one' }),
          segment({ index: 1, startMs: 1400, endMs: 2000, text: 'two' }),
        ])}
        {...h}
      />,
    )

    const paragraphs = screen.getByTestId('transcript').querySelectorAll('p')
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0]?.textContent).toBe('one two')
  })

  it('starts a new paragraph when the gap is 1500 ms or more', () => {
    const h = handlers()
    render(
      <Done
        job={job([
          segment({ startMs: 0, endMs: 1000, text: 'one' }),
          segment({ index: 1, startMs: 2500, endMs: 3000, text: 'two' }),
        ])}
        {...h}
      />,
    )

    const paragraphs = screen.getByTestId('transcript').querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]?.textContent).toBe('one')
    expect(paragraphs[1]?.textContent).toBe('two')
  })

  it('drops whitespace-only segments', () => {
    const h = handlers()
    render(
      <Done
        job={job([
          segment({ startMs: 0, endMs: 1000, text: 'one' }),
          segment({ index: 1, startMs: 1000, endMs: 1100, text: '   ' }),
          segment({ index: 2, startMs: 1100, endMs: 2000, text: 'two' }),
        ])}
        {...h}
      />,
    )

    const paragraphs = screen.getByTestId('transcript').querySelectorAll('p')
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0]?.textContent).toBe('one two')
  })

  it('renders the no-speech message for an empty segments array', () => {
    const h = handlers()
    render(<Done job={job([])} {...h} />)

    expect(screen.getByText('No speech was found in this file.')).toBeTruthy()
  })

  it("each of the three Save buttons calls onSave with its own format", () => {
    const h = handlers()
    render(<Done job={job([segment()])} {...h} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save .txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save .srt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save .vtt' }))

    expect(h.onSave).toHaveBeenNthCalledWith(1, 'txt')
    expect(h.onSave).toHaveBeenNthCalledWith(2, 'srt')
    expect(h.onSave).toHaveBeenNthCalledWith(3, 'vtt')
  })

  it('copy writes the transcript text to the clipboard', async () => {
    const h = handlers()
    render(<Done job={job([segment({ text: 'copy me' })])} {...h} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(h.onCopy).toHaveBeenCalledExactlyOnceWith('copy me'))
  })

  it('a rejected clipboard write shows the inline note and calls no error handler', async () => {
    const onCopy = vi.fn(async () => {
      throw new Error('denied')
    })
    render(
      <Done
        job={job([segment({ text: 'copy me' })])}
        onSave={vi.fn(async () => {})}
        onCopy={onCopy}
        onReset={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(screen.getByText("Couldn't copy")).toBeTruthy())
  })

  // C1: a failed save must never cost the user the finished transcript. This
  // is asserted here at the unit level; test/renderer/App.test.tsx asserts
  // the same thing end to end through the real App and reducer.
  it('a rejected save shows an inline error, keeps the transcript on screen, and leaves every Save button usable', async () => {
    const onSave = vi.fn(async () => {
      throw Object.assign(new Error('EROFS'), { code: 'EROFS' })
    })
    render(
      <Done
        job={job([segment({ text: 'still here' })])}
        onSave={onSave}
        onCopy={vi.fn(async () => {})}
        onReset={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save .srt' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    // The transcript is still rendered — this is not the app-level error view.
    expect(screen.getByTestId('transcript').textContent).toContain('still here')
    // Every Save button is still there, and still enabled.
    for (const name of ['Save .txt', 'Save .srt', 'Save .vtt']) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    }
  })

  it('dismissing the inline save error clears it without touching the transcript', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('boom')
    })
    render(<Done job={job([segment({ text: 'still here' })])} onSave={onSave} onCopy={vi.fn(async () => {})} onReset={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save .srt' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('transcript').textContent).toContain('still here')
  })

  it('a save that succeeds after a prior failure clears the error and calls onSave again', async () => {
    let attempt = 0
    const onSave = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('first attempt fails')
    })
    render(<Done job={job([segment({ text: 'still here' })])} onSave={onSave} onCopy={vi.fn(async () => {})} onReset={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save .srt' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Save .srt' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('"Transcribe another" calls onReset', () => {
    const h = handlers()
    render(<Done job={job([segment()])} {...h} />)

    fireEvent.click(screen.getByRole('button', { name: 'Transcribe another' }))

    expect(h.onReset).toHaveBeenCalledOnce()
  })
})
