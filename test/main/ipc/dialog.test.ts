import { describe, expect, it, vi } from 'vitest'
import { createDialogHandlers } from '../../../src/main/ipc/dialog.js'

function harness(showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>) {
  const issuePath = vi.fn()
  const handlers = createDialogHandlers({ showOpenDialog, issuePath })
  return { handlers, issuePath }
}

describe('dialog.openFile', () => {
  it('returns the chosen path', async () => {
    const { handlers } = harness(async () => ({ canceled: false, filePaths: ['/videos/a.mp4'] }))

    expect(await handlers.openFile()).toBe('/videos/a.mp4')
  })

  it('issues the chosen path as trusted, so transcribe.start will accept it', async () => {
    const { handlers, issuePath } = harness(async () => ({
      canceled: false,
      filePaths: ['/videos/a.mp4'],
    }))
    await handlers.openFile()

    expect(issuePath).toHaveBeenCalledWith('/videos/a.mp4')
  })

  it('returns null when the user cancels, and issues nothing', async () => {
    const { handlers, issuePath } = harness(async () => ({ canceled: true, filePaths: [] }))

    expect(await handlers.openFile()).toBeNull()
    expect(issuePath).not.toHaveBeenCalled()
  })

  it('returns null when the dialog reports success with no path', async () => {
    const { handlers, issuePath } = harness(async () => ({ canceled: false, filePaths: [] }))

    expect(await handlers.openFile()).toBeNull()
    expect(issuePath).not.toHaveBeenCalled()
  })

  it('takes the first path when several come back', async () => {
    const { handlers } = harness(async () => ({ canceled: false, filePaths: ['/a.mp4', '/b.mp4'] }))

    expect(await handlers.openFile()).toBe('/a.mp4')
  })
})
