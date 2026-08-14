import { describe, expect, it, vi } from 'vitest'
import { createExportHandlers, type ExportDeps } from '../../../src/main/ipc/export.js'
import { AppError } from '../../../src/shared/errors.js'
import type { JobState } from '../../../src/shared/types.js'

const DONE: JobState = {
  id: 'job-1',
  filePath: '/videos/interview.mp4',
  phase: 'done',
  progress: 1,
  segments: [{ index: 0, startMs: 0, endMs: 1_000, text: 'Hello.' }],
}

function harness(overrides: Partial<ExportDeps> = {}) {
  const revealed: string[] = []
  const writeTranscript = vi.fn(
    async (options: { sourcePath: string; as: string }) =>
      `${options.sourcePath.replace(/\.[^.]+$/, '')}.${options.as}`,
  )

  const handlers = createExportHandlers({
    lookupJob: (jobId) => (jobId === DONE.id ? DONE : undefined),
    writeTranscript,
    reveal: (path) => revealed.push(path),
    ...overrides,
  })

  return { handlers, revealed, writeTranscript }
}

describe('exportTranscript.save', () => {
  it('writes next to the source file with the same basename', async () => {
    const { handlers } = harness()

    expect(await handlers.save('job-1', 'srt')).toBe('/videos/interview.srt')
  })

  it('passes the source path from main’s own record, never from the caller', async () => {
    const { handlers, writeTranscript } = harness()
    await handlers.save('job-1', 'txt')

    expect(writeTranscript).toHaveBeenCalledWith({
      segments: DONE.segments,
      sourcePath: '/videos/interview.mp4',
      as: 'txt',
    })
  })

  it('accepts exactly the three formats', async () => {
    const { handlers } = harness()

    for (const format of ['txt', 'srt', 'vtt']) {
      await expect(handlers.save('job-1', format)).resolves.toContain(`.${format}`)
    }
  })

  it('rejects any other format', async () => {
    const { handlers, writeTranscript } = harness()

    for (const format of ['pdf', 'TXT', '', '../../x', null, { as: 'txt' }]) {
      await expect(handlers.save('job-1', format)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      })
    }
    expect(writeTranscript).not.toHaveBeenCalled()
  })

  it('rejects an unknown job id', async () => {
    const { handlers } = harness()

    await expect(handlers.save('job-999', 'txt')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('rejects a non-string job id', async () => {
    const { handlers } = harness()

    await expect(handlers.save(null, 'txt')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects a job that has not finished', async () => {
    const { handlers } = harness({
      lookupJob: () => ({ ...DONE, phase: 'transcribing', progress: 0.4 }),
    })

    await expect(handlers.save('job-1', 'txt')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('turns a raw filesystem error into a plain-language failure', async () => {
    const { handlers } = harness({
      writeTranscript: async () => {
        throw Object.assign(new Error('EACCES: permission denied, open /videos/interview.srt'), {
          code: 'EACCES',
        })
      },
    })

    const failure = await handlers.save('job-1', 'srt').catch((cause: unknown) => cause)
    expect(failure).toMatchObject({ code: 'UNEXPECTED' })
    expect((failure as Error).message).not.toContain('EACCES')
    expect((failure as { detail: string }).detail).toContain('EACCES')
  })

  it('passes an AppError through unchanged', async () => {
    const { handlers } = harness({
      writeTranscript: async () => {
        throw new AppError('INSUFFICIENT_DISK_SPACE', 'Not enough free space.')
      },
    })

    await expect(handlers.save('job-1', 'srt')).rejects.toMatchObject({
      code: 'INSUFFICIENT_DISK_SPACE',
    })
  })
})

describe('shell.reveal', () => {
  it('reveals a path this process returned from save', async () => {
    const { handlers, revealed } = harness()
    const path = await handlers.save('job-1', 'srt')
    await handlers.reveal(path)

    expect(revealed).toEqual(['/videos/interview.srt'])
  })

  it('refuses a path the renderer made up', async () => {
    const { handlers, revealed } = harness()
    await handlers.save('job-1', 'srt')

    for (const path of ['/etc/passwd', '/videos/interview.mp4', '/videos/interview.srt/../..']) {
      await expect(handlers.reveal(path)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    expect(revealed).toEqual([])
  })

  it('refuses everything before anything has been saved', async () => {
    const { handlers } = harness()

    await expect(handlers.reveal('/videos/interview.srt')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('refuses a non-string path', async () => {
    const { handlers } = harness()

    await expect(handlers.reveal(null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('remembers every saved path, not only the last', async () => {
    const { handlers, revealed } = harness()
    const txt = await handlers.save('job-1', 'txt')
    const srt = await handlers.save('job-1', 'srt')

    await handlers.reveal(txt)
    await handlers.reveal(srt)
    expect(revealed).toEqual([txt, srt])
  })

  it('does not grow without bound as more transcripts get saved', async () => {
    let counter = 0
    const { handlers } = harness({
      writeTranscript: async () => `/videos/interview-${counter++}.srt`,
    })

    for (let i = 0; i < 501; i++) await handlers.save('job-1', 'srt')

    // The oldest saved path was evicted; the most recent is still revealable.
    await expect(handlers.reveal('/videos/interview-500.srt')).resolves.toBeUndefined()
    await expect(handlers.reveal('/videos/interview-0.srt')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})
