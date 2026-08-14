import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

/** The subset of ChildProcess our spawn wrappers use, so tests can supply a stand-in. */
export type SpawnedProcess = EventEmitter & {
  stdout: Readable
  stderr: Readable
  kill: (signal?: string) => boolean
}

export type SpawnFn = (file: string, args: string[]) => SpawnedProcess
