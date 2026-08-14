// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toast } from '../../../src/renderer/components/Toast.js'

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the saved file name', () => {
    const { getByText } = render(
      <Toast path="/videos/interview.srt" onReveal={vi.fn()} onDismiss={vi.fn()} />,
    )

    expect(getByText('Saved interview.srt')).toBeTruthy()
  })

  it('Reveal calls onReveal with the saved path', () => {
    const onReveal = vi.fn()
    const { getByRole } = render(
      <Toast path="/videos/interview.srt" onReveal={onReveal} onDismiss={vi.fn()} />,
    )

    fireEvent.click(getByRole('button', { name: 'Reveal' }))

    expect(onReveal).toHaveBeenCalledExactlyOnceWith('/videos/interview.srt')
  })

  it('the close button calls onDismiss', () => {
    const onDismiss = vi.fn()
    const { getByRole } = render(
      <Toast path="/videos/interview.srt" onReveal={vi.fn()} onDismiss={onDismiss} />,
    )

    fireEvent.click(getByRole('button', { name: 'Dismiss' }))

    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('auto-dismisses after 6 seconds', () => {
    const onDismiss = vi.fn()
    render(<Toast path="/videos/interview.srt" onReveal={vi.fn()} onDismiss={onDismiss} />)

    vi.advanceTimersByTime(5_999)
    expect(onDismiss).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  // M9: replacing the setTimeout with a no-op used to kill no test — the test
  // above already closes that gap. This one closes the second half of the
  // bug: a parent re-render handing Toast a fresh `onDismiss` identity (which
  // is exactly what App.tsx's inline arrow does on every render) must not
  // restart the countdown.
  it('a parent re-render with a new onDismiss identity does not restart the countdown', () => {
    const onDismissA = vi.fn()
    const { rerender } = render(
      <Toast path="/videos/interview.srt" onReveal={vi.fn()} onDismiss={onDismissA} />,
    )

    vi.advanceTimersByTime(4_000)

    const onDismissB = vi.fn()
    rerender(<Toast path="/videos/interview.srt" onReveal={vi.fn()} onDismiss={onDismissB} />)

    // Only 2 more seconds are needed to reach the original 6-second mark. A
    // restarted timer would still be 4 seconds away at this point.
    vi.advanceTimersByTime(2_000)

    expect(onDismissB).toHaveBeenCalledOnce()
    expect(onDismissA).not.toHaveBeenCalled()
  })

  it('a new path (a second save) does restart the countdown', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <Toast path="/videos/interview.srt" onReveal={vi.fn()} onDismiss={onDismiss} />,
    )

    vi.advanceTimersByTime(4_000)
    rerender(<Toast path="/videos/interview.vtt" onReveal={vi.fn()} onDismiss={onDismiss} />)

    // The old timer is cleared; 4s more (8s total) is not yet 6s past the
    // new path's mount.
    vi.advanceTimersByTime(4_000)
    expect(onDismiss).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2_000)
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
