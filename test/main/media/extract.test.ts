import { describe, expect, it, vi } from 'vitest'
import { extractWav } from '../../../src/main/media/extract.js'
import { createFakeChild } from '../../helpers/fake-child.js'

const OPTIONS = { inputPath: '/tmp/in.mp4', outputPath: '/tmp/out.wav', durationMs: 10_000 }

describe('extractWav', () => {
  it('resolves when ffmpeg exits zero', async () => {
    const fake = createFakeChild()
    const promise = extractWav(OPTIONS, { spawn: () => fake.child })
    fake.exit(0)
    await expect(promise).resolves.toBeUndefined()
  })

  it('reports progress from ffmpeg out_time_us lines', async () => {
    const fake = createFakeChild()
    const onProgress = vi.fn()
    const promise = extractWav({ ...OPTIONS, onProgress }, { spawn: () => fake.child })

    fake.emitStdout('frame=1\nout_time_us=2500000\nprogress=continue\n')
    fake.emitStdout('out_time_us=5000000\nprogress=continue\n')
    fake.exit(0)
    await promise

    expect(onProgress).toHaveBeenCalledWith(0.25)
    expect(onProgress).toHaveBeenCalledWith(0.5)
  })

  it('reassembles an out_time_us line split across two stdout writes', async () => {
    const fake = createFakeChild()
    const onProgress = vi.fn()
    const promise = extractWav({ ...OPTIONS, onProgress }, { spawn: () => fake.child })

    fake.emitStdout('out_time_us=25')
    fake.emitStdout('00000\nprogress=continue\n')
    fake.exit(0)
    await promise

    expect(onProgress).toHaveBeenCalledWith(0.25)
  })

  it('clamps progress to 1 when ffmpeg overshoots the probed duration', async () => {
    const fake = createFakeChild()
    const onProgress = vi.fn()
    const promise = extractWav({ ...OPTIONS, onProgress }, { spawn: () => fake.child })

    fake.emitStdout('out_time_us=99000000\n')
    fake.exit(0)
    await promise

    expect(onProgress).toHaveBeenLastCalledWith(1)
  })

  it('does not divide by zero when the duration is zero', async () => {
    const fake = createFakeChild()
    const onProgress = vi.fn()
    const promise = extractWav({ ...OPTIONS, durationMs: 0, onProgress }, { spawn: () => fake.child })

    fake.emitStdout('out_time_us=1000000\n')
    fake.exit(0)
    await promise

    expect(onProgress).toHaveBeenLastCalledWith(1)
  })

  it('throws FFMPEG_FAILED with the stderr tail on a non-zero exit', async () => {
    const fake = createFakeChild()
    const promise = extractWav(OPTIONS, { spawn: () => fake.child })

    fake.emitStderr('Invalid data found when processing input\n')
    fake.exit(1)

    await expect(promise).rejects.toMatchObject({
      code: 'FFMPEG_FAILED',
      detail: expect.stringContaining('Invalid data found'),
    })
  })

  it('kills the process when the signal aborts', async () => {
    const controller = new AbortController()
    const fake = createFakeChild()
    const promise = extractWav({ ...OPTIONS, signal: controller.signal }, { spawn: () => fake.child })

    controller.abort()
    fake.exit(143)

    await expect(promise).rejects.toThrow(/abort/i)
    expect(fake.killSignals).toContain('SIGKILL')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()

    await expect(
      extractWav({ ...OPTIONS, signal: controller.signal }, { spawn }),
    ).rejects.toThrow(/abort/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('asks ffmpeg for 16 kHz mono pcm_s16le with machine-readable progress', async () => {
    let captured: string[] = []
    const fake = createFakeChild()
    const promise = extractWav(OPTIONS, {
      spawn: (_file, args) => {
        captured = args
        return fake.child
      },
    })
    fake.exit(0)
    await promise

    expect(captured).toEqual([
      '-nostdin',
      '-loglevel', 'error',
      '-i', '/tmp/in.mp4',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      '-progress', 'pipe:1',
      '-y',
      '/tmp/out.wav',
    ])
  })
})
