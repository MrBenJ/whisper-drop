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
    await expect(probe('/tmp/a.mp4', { execFile: fakeExec('not json') })).rejects.toBeInstanceOf(AppError)
  })

  it('throws UNREADABLE_MEDIA when the duration is missing', async () => {
    const stdout = JSON.stringify({ format: { format_name: 'wav' }, streams: [{ codec_type: 'audio' }] })
    await expect(probe('/tmp/a.wav', { execFile: fakeExec(stdout) })).rejects.toMatchObject({
      code: 'UNREADABLE_MEDIA',
    })
  })

  it('passes the expected arguments to ffprobe', async () => {
    let captured: string[] = []
    const execFile = async (_file: string, args: string[]) => {
      captured = args
      return { stdout: withAudio, stderr: '' }
    }
    await probe('/tmp/a.mp4', { execFile })
    expect(captured).toEqual([
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/tmp/a.mp4',
    ])
  })
})
