// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Licenses } from '../../../src/renderer/components/Licenses.js'
import { LICENSES } from '../../../src/renderer/licenses.js'
import '../fake-api.js'

describe('Licenses', () => {
  it('is a labelled, modal dialog', () => {
    render(<Licenses onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Licenses' })).toBeTruthy()
  })

  it('renders every entry in LICENSES, each with its licence and URL as text', () => {
    render(<Licenses onClose={vi.fn()} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(LICENSES.length)
    for (const entry of LICENSES) {
      expect(screen.getByText(entry.name)).toBeTruthy()
      expect(screen.getByText(entry.url)).toBeTruthy()
    }
    // Selectable text, not a link — the window denies navigation.
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('calls onClose from the close button', () => {
    const onClose = vi.fn()
    render(<Licenses onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<Licenses onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on a click outside the dialog, and not on a click inside it', () => {
    const onClose = vi.fn()
    render(<Licenses onClose={onClose} />)

    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
