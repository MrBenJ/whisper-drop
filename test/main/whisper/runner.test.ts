import { describe, expect, it, vi } from 'vitest'
import { runWhisper } from '../../../src/main/whisper/runner.js'
import { createFakeChild } from '../../helpers/fake-child.js'

const OPTIONS = { wavPath: '/tmp/a.wav', modelPath: '/models/ggml-tiny.bin', language: 'en' }

describe('runWhisper', () => {
  it('returns the parsed segments', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStdout('[00:00:00.000 --> 00:00:02.000]  Hello there.\n')
    fake.emitStdout('[00:00:02.000 --> 00:00:04.000]  Second one.\n')
    fake.exit(0)

    await expect(promise).resolves.toEqual([
      { index: 0, startMs: 0, endMs: 2_000, text: 'Hello there.' },
      { index: 1, startMs: 2_000, endMs: 4_000, text: 'Second one.' },
    ])
  })

  it('emits each segment as it arrives', async () => {
    const fake = createFakeChild()
    const onSegment = vi.fn()
    const promise = runWhisper({ ...OPTIONS, onSegment }, { spawn: () => fake.child })

    fake.emitStdout('[00:00:00.000 --> 00:00:02.000]  Hello there.\n')
    fake.exit(0)
    await promise

    expect(onSegment).toHaveBeenCalledTimes(1)
    expect(onSegment).toHaveBeenCalledWith({ index: 0, startMs: 0, endMs: 2_000, text: 'Hello there.' })
  })

  it('reassembles a segment split across two stdout chunks', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStdout('[00:00:00.000 --> 00:00:0')
    fake.emitStdout('2.000]  Split across chunks.\n')
    fake.exit(0)

    await expect(promise).resolves.toEqual([
      { index: 0, startMs: 0, endMs: 2_000, text: 'Split across chunks.' },
    ])
  })

  it('ignores whisper log lines', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStdout('whisper_model_load: loading model\n')
    fake.emitStdout('system_info: n_threads = 4 | METAL = 1 |\n')
    fake.exit(0)

    await expect(promise).resolves.toEqual([])
  })

  it('throws WHISPER_FAILED with the stderr tail on a non-zero exit', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.emitStderr('failed to load model\n')
    fake.exit(3)

    await expect(promise).rejects.toMatchObject({
      code: 'WHISPER_FAILED',
      detail: expect.stringContaining('failed to load model'),
    })
  })

  it('attributes a spawn error to WHISPER_FAILED, carrying the underlying message', async () => {
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, { spawn: () => fake.child })

    fake.child.emit('error', new Error('spawn whisper-cli ENOENT'))

    await expect(promise).rejects.toMatchObject({
      code: 'WHISPER_FAILED',
      detail: expect.stringContaining('spawn whisper-cli ENOENT'),
    })
  })

  it('kills the process when the signal aborts', async () => {
    const controller = new AbortController()
    const fake = createFakeChild()
    const promise = runWhisper({ ...OPTIONS, signal: controller.signal }, { spawn: () => fake.child })

    controller.abort()
    fake.exit(137)

    await expect(promise).rejects.toThrow(/abort/i)
    expect(fake.killSignals).toContain('SIGKILL')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()

    await expect(runWhisper({ ...OPTIONS, signal: controller.signal }, { spawn })).rejects.toThrow(/abort/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('passes the model, wav and language to whisper-cli', async () => {
    let captured: string[] = []
    const fake = createFakeChild()
    const promise = runWhisper(OPTIONS, {
      spawn: (_file, args) => {
        captured = args
        return fake.child
      },
    })
    fake.exit(0)
    await promise

    expect(captured).toContain('-m')
    expect(captured[captured.indexOf('-m') + 1]).toBe('/models/ggml-tiny.bin')
    expect(captured[captured.indexOf('-f') + 1]).toBe('/tmp/a.wav')
    expect(captured[captured.indexOf('-l') + 1]).toBe('en')
  })

  it('passes auto as the language when asked to detect', async () => {
    let captured: string[] = []
    const fake = createFakeChild()
    const promise = runWhisper(
      { ...OPTIONS, language: 'auto' },
      {
        spawn: (_file, args) => {
          captured = args
          return fake.child
        },
      },
    )
    fake.exit(0)
    await promise

    expect(captured[captured.indexOf('-l') + 1]).toBe('auto')
  })
})
