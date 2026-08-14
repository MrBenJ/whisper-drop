// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorView } from '../../../src/renderer/components/ErrorView.js'
import { presentError } from '../../../src/renderer/errors.js'
import type { IpcFailure } from '../../../src/shared/ipc.js'
import '../fake-api.js'

function handlers() {
  return { onRetry: vi.fn(), onOpenPicker: vi.fn(), onDismiss: vi.fn() }
}

describe('ErrorView', () => {
  it("renders the failure's own message as the heading", () => {
    const failure: IpcFailure = { code: 'WHISPER_FAILED', message: 'It broke in a specific way.' }
    render(<ErrorView failure={failure} {...handlers()} />)

    expect(screen.getByRole('heading', { name: 'It broke in a specific way.' })).toBeTruthy()
  })

  it("renders the code's suggestion", () => {
    const failure: IpcFailure = { code: 'WHISPER_FAILED', message: '' }
    render(<ErrorView failure={failure} {...handlers()} />)

    expect(screen.getByText(presentError(failure).suggestion)).toBeTruthy()
  })

  it('NO_MODEL_INSTALLED renders a "Choose a model" button calling onOpenPicker', () => {
    const h = handlers()
    render(<ErrorView failure={{ code: 'NO_MODEL_INSTALLED', message: '' }} {...h} />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose a model' }))

    expect(h.onOpenPicker).toHaveBeenCalledOnce()
  })

  it('WHISPER_FAILED renders "Try again" calling onRetry', () => {
    const h = handlers()
    render(<ErrorView failure={{ code: 'WHISPER_FAILED', message: '' }} {...h} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(h.onRetry).toHaveBeenCalledOnce()
  })

  it('DOWNLOAD_NETWORK_ERROR renders the download retry', () => {
    const h = handlers()
    render(<ErrorView failure={{ code: 'DOWNLOAD_NETWORK_ERROR', message: '' }} {...h} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try the download again' }))

    expect(h.onRetry).toHaveBeenCalledOnce()
  })

  it('the technical detail is behind a closed <details> and is not visible before it is opened', () => {
    render(
      <ErrorView
        failure={{ code: 'WHISPER_FAILED', message: '', detail: 'a very specific stack trace' }}
        {...handlers()}
      />,
    )

    // jsdom doesn't apply the UA stylesheet that hides a closed <details>'s
    // body, so the only reliable signal here is the element's own state —
    // real browsers hide unopened detail content from this alone.
    const details = document.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('pre')?.textContent).toContain('a very specific stack trace')
  })

  it('the detail block contains the code, the message and the detail', () => {
    render(
      <ErrorView
        failure={{ code: 'FFMPEG_FAILED', message: 'Nope.', detail: 'exit 1' }}
        {...handlers()}
      />,
    )

    const pre = document.querySelector('pre')
    expect(pre?.textContent).toBe('code: FFMPEG_FAILED\nmessage: Nope.\nexit 1')
  })

  it('a failure with no detail still renders the disclosure with code and message', () => {
    render(<ErrorView failure={{ code: 'FFMPEG_FAILED', message: 'Nope.' }} {...handlers()} />)

    const pre = document.querySelector('pre')
    expect(pre?.textContent).toBe('code: FFMPEG_FAILED\nmessage: Nope.')
  })

  it('no raw stack text appears outside the <pre>', () => {
    const detail = 'Error: boom\n    at Object.<anonymous> (/app/main.js:42:11)'
    render(
      <ErrorView failure={{ code: 'WHISPER_FAILED', message: 'Plain language only.', detail }} {...handlers()} />,
    )

    const pre = document.querySelector('pre')
    expect(pre?.textContent).toContain(detail)

    document.body.querySelectorAll('*').forEach((el) => {
      if (el.tagName === 'PRE' || el.closest('pre')) return
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
      expect(own).not.toContain('at Object.<anonymous>')
    })
  })
})
