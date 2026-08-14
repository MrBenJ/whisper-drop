import { describe, expect, it } from 'vitest'
import { createDialogHandlers } from '../../../src/main/ipc/dialog.js'
import { createDroppedFileHandlers } from '../../../src/main/ipc/dropped-file.js'
import { createTranscribeHandlers, type JobLike } from '../../../src/main/ipc/transcribe.js'
import { createTrustedPaths } from '../../../src/main/ipc/trusted-paths.js'
import type { Settings } from '../../../src/shared/types.js'

const SETTINGS: Settings = {
  version: 1,
  englishOnly: false,
  activeModel: 'base',
  language: 'auto',
  throughput: {},
}

function harness() {
  const trustedPaths = createTrustedPaths()
  const dialog = createDialogHandlers({
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/videos/dialog-pick.mp4'] }),
    issuePath: trustedPaths.issue,
  })
  const droppedFile = createDroppedFileHandlers({ issuePath: trustedPaths.issue })
  const transcribe = createTranscribeHandlers({
    newJobId: () => 'job-1',
    readSettings: async () => SETTINGS,
    modelPathFor: () => '/models/base.bin',
    isInstalled: async () => true,
    createJob: (input) =>
      ({
        id: input.id,
        state: { id: input.id, filePath: input.filePath, phase: 'probing', progress: 0, segments: [] },
        start: () => new Promise<void>(() => {}),
        cancel: () => {},
        subscribe: () => () => {},
      }) satisfies JobLike,
    recordThroughput: async () => undefined,
    emitState: () => {},
    consumeTrustedPath: trustedPaths.consume,
  })

  return { dialog, droppedFile, transcribe }
}

describe('the path trust boundary end to end', () => {
  it('start rejects a path main never issued', async () => {
    const { transcribe } = harness()

    await expect(transcribe.start('/etc/passwd')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('start accepts a path returned by dialog.openFile', async () => {
    const { dialog, transcribe } = harness()
    const path = await dialog.openFile()

    await expect(transcribe.start(path)).resolves.toEqual(expect.any(String))
  })

  it('start accepts a path returned by droppedFile.pathFor (reported via register)', async () => {
    const { droppedFile, transcribe } = harness()
    await droppedFile.register('/videos/dropped.mp4')

    await expect(transcribe.start('/videos/dropped.mp4')).resolves.toEqual(expect.any(String))
  })
})
