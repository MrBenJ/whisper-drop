// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { About } from '../../../src/renderer/components/About.js'

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-about-trigger]').forEach((element) => element.remove())
})

describe('About', () => {
  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<About onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on a click outside the dialog, and not on a click inside it', () => {
    const onClose = vi.fn()
    render(<About onClose={onClose} />)

    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('focuses the dialog on mount and restores the previous focus on unmount', () => {
    const trigger = document.createElement('button')
    trigger.dataset.aboutTrigger = 'true'
    document.body.append(trigger)
    trigger.focus()

    const { unmount } = render(<About onClose={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))

    unmount()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps keyboard focus inside the modal', () => {
    render(<About onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog')
    const close = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(dialog)

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
  })
})
