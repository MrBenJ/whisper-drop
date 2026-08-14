// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropZone } from '../../../src/renderer/components/DropZone.js'
import { installFakeApi } from '../fake-api.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function makeFile(name: string): File {
  return new File(['data'], name, { type: 'video/mp4' })
}

describe('DropZone', () => {
  it('renders the drop prompt and a browse button', () => {
    installFakeApi()
    render(<DropZone onFile={vi.fn()} onBrowse={vi.fn()} />)

    expect(screen.getByText('Drop an audio or video file')).toBeTruthy()
    expect(screen.getByTestId('browse')).toBeTruthy()
  })

  it('dropping one file calls onFile with the path droppedFile.pathFor returned', () => {
    const fake = installFakeApi({
      droppedFile: { pathFor: vi.fn(() => '/videos/chosen.mp4') },
    })
    const onFile = vi.fn()
    render(<DropZone onFile={onFile} onBrowse={vi.fn()} />)

    fireEvent.drop(screen.getByRole('button', { name: /drop an audio or video file/i }), {
      dataTransfer: { files: [makeFile('a.mp4')] },
    })

    expect(fake.api.droppedFile.pathFor).toHaveBeenCalledTimes(1)
    expect(onFile).toHaveBeenCalledExactlyOnceWith('/videos/chosen.mp4')
  })

  it('dropping three files calls onFile exactly once, with the first file path', () => {
    installFakeApi({
      droppedFile: { pathFor: vi.fn((file: File) => `/dropped/${file.name}`) },
    })
    const onFile = vi.fn()
    render(<DropZone onFile={onFile} onBrowse={vi.fn()} />)

    fireEvent.drop(screen.getByRole('button', { name: /drop an audio or video file/i }), {
      dataTransfer: { files: [makeFile('a.mp4'), makeFile('b.mp4'), makeFile('c.mp4')] },
    })

    expect(onFile).toHaveBeenCalledExactlyOnceWith('/dropped/a.mp4')
  })

  it('dropping three files renders the one-at-a-time message', () => {
    installFakeApi()
    render(<DropZone onFile={vi.fn()} onBrowse={vi.fn()} />)

    fireEvent.drop(screen.getByRole('button', { name: /drop an audio or video file/i }), {
      dataTransfer: { files: [makeFile('a.mp4'), makeFile('b.mp4'), makeFile('c.mp4')] },
    })

    expect(
      screen.getByText('whisper-drop handles one file at a time for now — using the first.'),
    ).toBeTruthy()
  })

  it('dropping zero files calls onFile never and shows no error', () => {
    installFakeApi()
    const onFile = vi.fn()
    render(<DropZone onFile={onFile} onBrowse={vi.fn()} />)

    fireEvent.drop(screen.getByRole('button', { name: /drop an audio or video file/i }), {
      dataTransfer: { files: [] },
    })

    expect(onFile).not.toHaveBeenCalled()
    expect(screen.queryByText(/error/i)).toBeNull()
  })

  it('onDragOver sets the hovering class and calls preventDefault on the event', () => {
    installFakeApi()
    const preventDefault = vi.spyOn(Event.prototype, 'preventDefault')
    render(<DropZone onFile={vi.fn()} onBrowse={vi.fn()} />)

    const dropzone = screen.getByRole('button', { name: /drop an audio or video file/i })
    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } })

    expect(dropzone.className).toMatch(/drop-zone--hovering/)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('clicking browse calls onBrowse', () => {
    installFakeApi()
    const onBrowse = vi.fn()
    render(<DropZone onFile={vi.fn()} onBrowse={onBrowse} />)

    fireEvent.click(screen.getByTestId('browse'))

    expect(onBrowse).toHaveBeenCalledExactlyOnceWith()
  })

  it('disabled renders the reason text, disables the browse button, and a drop calls onFile never', () => {
    installFakeApi()
    const onFile = vi.fn()
    render(<DropZone disabled reason="Waiting for the model." onFile={onFile} onBrowse={vi.fn()} />)

    expect(screen.getByText('Waiting for the model.')).toBeTruthy()
    expect((screen.getByTestId('browse') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.drop(screen.getByRole('button', { name: /drop an audio or video file/i }), {
      dataTransfer: { files: [makeFile('a.mp4')] },
    })

    expect(onFile).not.toHaveBeenCalled()
  })

  it('the drop zone is reachable by keyboard: it has an accessible name and tabIndex 0', () => {
    installFakeApi()
    render(<DropZone onFile={vi.fn()} onBrowse={vi.fn()} />)

    const dropzone = screen.getByRole('button', { name: /drop an audio or video file/i })
    expect(dropzone.getAttribute('aria-label')).toBeTruthy()
    expect(dropzone.getAttribute('tabIndex')).toBe('0')
  })
})
