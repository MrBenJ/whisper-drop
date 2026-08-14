import { describe, expect, it } from 'vitest'
import { IPC_BOUNDARY_CODES, type IpcErrorCode } from '../../src/shared/ipc.js'
import { ERROR_CODES } from '../../src/shared/types.js'
import { asIpcFailure, detailBlock, presentError } from '../../src/renderer/errors.js'

const ALL_CODES: IpcErrorCode[] = [...ERROR_CODES, ...IPC_BOUNDARY_CODES]

describe('presentError', () => {
  it('has an entry for every code that can reach the renderer', () => {
    for (const code of ALL_CODES) {
      const presented = presentError({ code, message: '' })
      expect(presented.title, code).not.toBe('')
      expect(presented.suggestion, code).not.toBe('')
    }
  })

  it('prefers the message main sent, which carries the numbers only main knows', () => {
    expect(
      presentError({
        code: 'INSUFFICIENT_DISK_SPACE',
        message: 'Not enough free space. Large v3 needs about 3.1 GB.',
      }).title,
    ).toBe('Not enough free space. Large v3 needs about 3.1 GB.')
  })

  it('falls back to the table when the message is empty', () => {
    expect(presentError({ code: 'NO_AUDIO_STREAM', message: '   ' }).title).toBe(
      "This file doesn't contain any audio.",
    )
  })

  it('sends the missing-model codes to the picker', () => {
    expect(presentError({ code: 'NO_MODEL_INSTALLED', message: '' }).action).toBe('open-picker')
    expect(presentError({ code: 'MODEL_FILE_MISSING', message: '' }).action).toBe('open-picker')
    expect(presentError({ code: 'INSUFFICIENT_DISK_SPACE', message: '' }).action).toBe(
      'open-picker',
    )
  })

  it('offers a download retry for the two download failures', () => {
    expect(presentError({ code: 'DOWNLOAD_NETWORK_ERROR', message: '' }).action).toBe(
      'retry-download',
    )
    expect(presentError({ code: 'DOWNLOAD_CHECKSUM_MISMATCH', message: '' }).action).toBe(
      'retry-download',
    )
  })

  it('offers a transcription retry for the two pipeline failures', () => {
    expect(presentError({ code: 'WHISPER_FAILED', message: '' }).action).toBe('retry-transcription')
    expect(presentError({ code: 'FFMPEG_FAILED', message: '' }).action).toBe('retry-transcription')
  })

  it('never suggests retrying a file that simply has no audio', () => {
    expect(presentError({ code: 'NO_AUDIO_STREAM', message: '' }).action).toBe('dismiss')
    expect(presentError({ code: 'UNREADABLE_MEDIA', message: '' }).action).toBe('dismiss')
  })
})

describe('asIpcFailure', () => {
  it('passes a well-formed failure through', () => {
    const failure = { code: 'WHISPER_FAILED', message: 'boom', detail: 'exit 1' }

    expect(asIpcFailure(failure)).toBe(failure)
  })

  it('normalises an Error to UNEXPECTED', () => {
    expect(asIpcFailure(new Error('kaboom'))).toEqual({
      code: 'UNEXPECTED',
      message: 'Something went wrong.',
      detail: 'kaboom',
    })
  })

  it('normalises an unrecognised code rather than trusting it', () => {
    expect(asIpcFailure({ code: 'MADE_UP', message: 'trust me' }).code).toBe('UNEXPECTED')
  })

  it('normalises anything else', () => {
    expect(asIpcFailure(undefined).code).toBe('UNEXPECTED')
    expect(asIpcFailure('boom').detail).toBe('boom')
    expect(asIpcFailure(null).code).toBe('UNEXPECTED')
  })
})

describe('detailBlock', () => {
  it('formats code, message and detail for pasting into an issue', () => {
    expect(detailBlock({ code: 'FFMPEG_FAILED', message: 'Nope.', detail: 'exit 1' })).toBe(
      'code: FFMPEG_FAILED\nmessage: Nope.\nexit 1',
    )
  })

  it('omits an absent detail', () => {
    expect(detailBlock({ code: 'FFMPEG_FAILED', message: 'Nope.' })).toBe(
      'code: FFMPEG_FAILED\nmessage: Nope.',
    )
  })
})
