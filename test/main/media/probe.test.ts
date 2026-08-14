import { describe, expect, it } from 'vitest'
import { probe } from '../../../src/main/media/probe.js'
import { AppError } from '../../../src/shared/errors.js'

const withAudio = JSON.stringify({
  format: { duration: '92.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
})

const videoOnly = JSON.stringify({
  format: { duration: '10.0', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [{ codec_type: 'video' }],
})

const fakeExec = (stdout: string) => async () => ({ stdout, stderr: '' })

describe('probe', () => {
  it('returns duration in milliseconds', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(withAudio) })
    expect(info.durationMs).toBe(92_500)
  })

  it('reports the presence of an audio stream', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(withAudio) })
    expect(info.hasAudio).toBe(true)
  })

  it('reports the absence of an audio stream without throwing', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(videoOnly) })
    expect(info.hasAudio).toBe(false)
  })

  it('returns the container name and the original path', async () => {
    const info = await probe('/tmp/a.mp4', { execFile: fakeExec(withAudio) })
    expect(info.container).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    expect(info.path).toBe('/tmp/a.mp4')
  })

  it('rounds fractional milliseconds', async () => {
    const stdout = JSON.stringify({
      format: { duration: '3.0007', format_name: 'wav' },
      streams: [{ codec_type: 'audio' }],
    })
    expect((await probe('/tmp/a.wav', { execFile: fakeExec(stdout) })).durationMs).toBe(3_001)
  })

  it('throws UNREADABLE_MEDIA when ffprobe exits non-zero', async () => {
    const execFile = async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Invalid data found' })
    }
    await expect(probe('/tmp/nope.txt', { execFile })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
      detail: expect.stringContaining('Invalid data found'),
    })
  })

  it('throws UNREADABLE_MEDIA when ffprobe emits unparseable output', async () => {
    await expect(probe('/tmp/a.mp4', { execFile: fakeExec('not json') })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
    })
  })

  it('throws UNREADABLE_MEDIA when the duration is missing', async () => {
    const stdout = JSON.stringify({ format: { format_name: 'wav' }, streams: [{ codec_type: 'audio' }] })
    await expect(probe('/tmp/a.wav', { execFile: fakeExec(stdout) })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
    })
  })

  it('throws UNREADABLE_MEDIA when the duration is zero', async () => {
    const stdout = JSON.stringify({ format: { duration: '0', format_name: 'wav' }, streams: [{ codec_type: 'audio' }] })
    await expect(probe('/tmp/a.wav', { execFile: fakeExec(stdout) })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
    })
  })

  it('falls back to the full error when the cause carries an empty stderr (e.g. ENOENT)', async () => {
    const execFile = async () => {
      throw Object.assign(new Error('spawn ffprobe ENOENT'), { stderr: '' })
    }
    await expect(probe('/tmp/nope.txt', { execFile })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
      detail: expect.stringContaining('spawn ffprobe ENOENT'),
    })
  })

  it('passes the abort signal through to execFile', async () => {
    const controller = new AbortController()
    let captured: { signal?: AbortSignal; maxBuffer?: number } | undefined
    const execFile = async (_file: string, _args: string[], options?: typeof captured) => {
      captured = options
      return { stdout: withAudio, stderr: '' }
    }
    await probe('/tmp/a.mp4', { execFile, signal: controller.signal })
    expect(captured?.signal).toBe(controller.signal)
  })

  it('passes a maxBuffer well above execFile default of 1 MB', async () => {
    let captured: { signal?: AbortSignal; maxBuffer?: number } | undefined
    const execFile = async (_file: string, _args: string[], options?: typeof captured) => {
      captured = options
      return { stdout: withAudio, stderr: '' }
    }
    await probe('/tmp/a.mp4', { execFile })
    expect(captured?.maxBuffer).toBeGreaterThanOrEqual(10 * 1024 * 1024)
  })

  it('respects injected ffprobePath', async () => {
    let capturedFile: string = ''
    const execFile = async (file: string) => {
      capturedFile = file
      return { stdout: withAudio, stderr: '' }
    }
    await probe('/tmp/a.mp4', { ffprobePath: '/custom/ffprobe', execFile })
    expect(capturedFile).toBe('/custom/ffprobe')
  })

  it('passes the expected arguments to ffprobe', async () => {
    let capturedFile: string = ''
    let capturedArgs: string[] = []
    const execFile = async (file: string, args: string[]) => {
      capturedFile = file
      capturedArgs = args
      return { stdout: withAudio, stderr: '' }
    }
    await probe('/tmp/a.mp4', { execFile })
    expect(capturedFile).toBeTruthy()
    expect(capturedFile).toMatch(/ffprobe$/)
    expect(capturedArgs).toEqual([
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/tmp/a.mp4',
    ])
  })
})
