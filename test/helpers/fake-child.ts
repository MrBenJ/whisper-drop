import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export type FakeChild = {
  /** Pass this where a ChildProcess is expected. */
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean }
  emitStdout: (chunk: string) => void
  emitStderr: (chunk: string) => void
  /** Close the streams and emit `close` with the given exit code. */
  exit: (code: number) => void
  /** Signals passed to kill(), in call order. */
  killSignals: string[]
}

export function createFakeChild(): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const killSignals: string[] = []

  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: (signal = 'SIGTERM') => {
      killSignals.push(signal)
      return true
    },
  })

  return {
    child,
    emitStdout: (chunk) => stdout.write(chunk),
    emitStderr: (chunk) => stderr.write(chunk),
    exit: (code) => {
      stdout.end()
      stderr.end()
      // Let stream consumers drain before the close handler runs.
      setImmediate(() => child.emit('close', code))
    },
    killSignals,
  }
}
