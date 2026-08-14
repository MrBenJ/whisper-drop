import { describe, expect, it } from 'vitest'
import { IpcError, toFailure, toResult } from '../../../src/main/ipc/errors.js'
import { AppError } from '../../../src/shared/errors.js'

describe('toFailure', () => {
  it('keeps an AppError’s code, message and detail', () => {
    expect(toFailure(new AppError('NO_AUDIO_STREAM', 'No audio.', 'stderr'))).toEqual({
      code: 'NO_AUDIO_STREAM',
      message: 'No audio.',
      detail: 'stderr',
    })
  })

  it('keeps an IpcError’s code, message and detail', () => {
    expect(toFailure(new IpcError('INVALID_REQUEST', 'Nope.', 'jobId=x'))).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Nope.',
      detail: 'jobId=x',
    })
  })

  it('replaces the message of an unrecognised error, keeping the original as detail', () => {
    const failure = toFailure(new Error('ENOENT: no such file or directory'))

    expect(failure.code).toBe('UNEXPECTED')
    expect(failure.message).toBe('Something went wrong.')
    expect(failure.detail).toContain('ENOENT')
  })

  it('handles a thrown non-error', () => {
    expect(toFailure('boom')).toMatchObject({ code: 'UNEXPECTED', detail: 'boom' })
  })

  it('produces a structured-clone-safe object', () => {
    expect(() => structuredClone(toFailure(new Error('x')))).not.toThrow()
    expect(() => structuredClone(toFailure(new AppError('WHISPER_FAILED', 'x')))).not.toThrow()
  })
})

describe('toResult', () => {
  it('wraps a value', async () => {
    expect(await toResult(() => 'job-1')).toEqual({ ok: true, value: 'job-1' })
  })

  it('wraps an awaited value', async () => {
    expect(await toResult(async () => 7)).toEqual({ ok: true, value: 7 })
  })

  it('wraps a rejection as data rather than letting it throw', async () => {
    const result = await toResult(async () => {
      throw new AppError('FFMPEG_FAILED', "Couldn't prepare the audio.")
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'FFMPEG_FAILED', message: "Couldn't prepare the audio.", detail: undefined },
    })
  })

  it('wraps a synchronous throw too', async () => {
    const result = await toResult(() => {
      throw new IpcError('INVALID_REQUEST', 'Nope.')
    })

    expect(result.ok).toBe(false)
  })

  it('never rejects', async () => {
    await expect(
      toResult(() => {
        throw new Error('boom')
      }),
    ).resolves.toBeDefined()
  })
})
