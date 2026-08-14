import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/shared/errors.js'

describe('AppError', () => {
  it('is an Error', () => {
    expect(new AppError('WHISPER_FAILED', 'boom')).toBeInstanceOf(Error)
  })

  it('carries a code, a message and optional detail', () => {
    const error = new AppError('FFMPEG_FAILED', "Couldn't prepare the audio.", 'exit 1')
    expect(error.code).toBe('FFMPEG_FAILED')
    expect(error.message).toBe("Couldn't prepare the audio.")
    expect(error.detail).toBe('exit 1')
  })

  it('omits detail when not supplied', () => {
    expect(new AppError('NO_AUDIO_STREAM', 'no audio').detail).toBeUndefined()
  })

  it('serialises to the JobState error shape', () => {
    const error = new AppError('UNREADABLE_MEDIA', 'unreadable', 'stderr tail')
    expect(error.toJSON()).toEqual({
      code: 'UNREADABLE_MEDIA',
      message: 'unreadable',
      detail: 'stderr tail',
    })
  })

  it('sets name to AppError so stack traces are legible', () => {
    expect(new AppError('WHISPER_FAILED', 'boom').name).toBe('AppError')
  })
})
