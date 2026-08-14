// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Working } from '../../../src/renderer/components/Working.js'
import { formatPercent } from '../../../src/renderer/format.js'
import type { JobState } from '../../../src/shared/types.js'
import '../fake-api.js'

function job(patch: Partial<JobState> = {}): JobState {
  return {
    id: 'job-1',
    filePath: '/videos/interview.mp4',
    phase: 'transcribing',
    progress: 0.5,
    segments: [],
    ...patch,
  }
}

describe('Working', () => {
  it('shows the source filename, not the full path', () => {
    render(<Working job={job()} frozen={false} onCancel={vi.fn()} />)

    const text = screen.getByTestId('source-name').textContent
    expect(text).toBe('interview.mp4')
    expect(text).not.toContain('/videos/')
  })

  it('shows the phase label for each of probing, preparing, transcribing', () => {
    for (const [phase, label] of [
      ['probing', 'Reading the file'],
      ['preparing', 'Preparing audio'],
      ['transcribing', 'Transcribing'],
    ] as const) {
      const { unmount } = render(<Working job={job({ phase })} frozen={false} onCancel={vi.fn()} />)
      expect(screen.getByText(label)).toBeTruthy()
      unmount()
    }
  })

  it('shows the media duration once media is present, and nothing before', () => {
    const { rerender } = render(<Working job={job()} frozen={false} onCancel={vi.fn()} />)
    expect(screen.queryByText(/^\d+:\d{2}$/)).toBeNull()

    rerender(
      <Working
        job={job({ media: { path: '/videos/interview.mp4', durationMs: 247_000, hasAudio: true, container: 'mp4' } })}
        frozen={false}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('4:07')).toBeTruthy()
  })

  it('role="progressbar" carries aria-valuenow matching formatPercent(progress)', () => {
    render(<Working job={job({ progress: 0.4269 })} frozen={false} onCancel={vi.fn()} />)

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      String(formatPercent(0.4269)),
    )
  })

  it('shows the ETA text when etaMs is set', () => {
    render(<Working job={job({ etaMs: 80_000 })} frozen={false} onCancel={vi.fn()} />)

    expect(screen.getByText(/1 min 20 sec/)).toBeTruthy()
  })

  it('renders no ETA element at all when etaMs is undefined', () => {
    render(<Working job={job({ etaMs: undefined })} frozen={false} onCancel={vi.fn()} />)

    expect(document.querySelector('.working-eta')).toBeNull()
  })

  it('clicking Cancel calls onCancel once', () => {
    const onCancel = vi.fn()
    render(<Working job={job()} frozen={false} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('with frozen, Cancel is disabled and reads "Cancelling…"', () => {
    render(<Working job={job()} frozen={true} onCancel={vi.fn()} />)

    const button = screen.getByRole('button', { name: 'Cancelling…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
