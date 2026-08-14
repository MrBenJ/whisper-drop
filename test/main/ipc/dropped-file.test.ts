import { describe, expect, it, vi } from 'vitest'
import { createDroppedFileHandlers } from '../../../src/main/ipc/dropped-file.js'

describe('droppedFile.register', () => {
  it('issues the reported path as trusted', async () => {
    const issuePath = vi.fn()
    const handlers = createDroppedFileHandlers({ issuePath })
    await handlers.register('/videos/interview.mp4')

    expect(issuePath).toHaveBeenCalledWith('/videos/interview.mp4')
  })

  it('rejects a non-string or empty path rather than issuing it', async () => {
    const issuePath = vi.fn()
    const handlers = createDroppedFileHandlers({ issuePath })

    await expect(handlers.register(42)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.register('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(handlers.register(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(issuePath).not.toHaveBeenCalled()
  })
})
