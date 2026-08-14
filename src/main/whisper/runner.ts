import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { whisperCliPath as defaultWhisperCliPath } from '../binaries.js'
import { AppError } from '../../shared/errors.js'
import type { Segment } from '../../shared/types.js'
import type { SpawnFn, SpawnedProcess } from '../process.js'
import { parseSegmentLine } from './parse.js'

export type RunnerDeps = {
  whisperCliPath?: string
  spawn?: SpawnFn
}

export type RunOptions = {
  wavPath: string
  modelPath: string
  /** ISO 639-1 code, or 'auto' to detect. */
  language: string
  threads?: number
  onSegment?: (segment: Segment) => void
  signal?: AbortSignal
}

const STDERR_TAIL_BYTES = 4_000

/**
 * Run whisper-cli over a prepared WAV, emitting segments as they decode.
 *
 * stdout is consumed through readline rather than by splitting chunks, because
 * Node delivers arbitrary chunk boundaries and a segment line is routinely
 * split across two of them.
 */
export async function runWhisper(options: RunOptions, deps: RunnerDeps = {}): Promise<Segment[]> {
  const { wavPath, modelPath, language, threads, onSegment, signal } = options

  if (signal?.aborted) throw new Error('runWhisper: aborted before starting')

  const spawn = deps.spawn ?? ((file, args) => nodeSpawn(file, args) as unknown as SpawnedProcess)
  const binary = deps.whisperCliPath ?? defaultWhisperCliPath()

  const args = ['-m', modelPath, '-f', wavPath, '-l', language]
  if (threads) args.push('-t', String(threads))

  const child = spawn(binary, args)

  const segments: Segment[] = []

  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES)
  })

  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const parsed = parseSegmentLine(line)
    if (!parsed) return

    const segment: Segment = { index: segments.length, ...parsed }
    segments.push(segment)
    onSegment?.(segment)
  })

  const onAbort = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on('close', resolve)
      child.on('error', (cause) =>
        reject(
          new AppError(
            'WHISPER_FAILED',
            'Transcription failed unexpectedly.',
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      )
    })

    if (signal?.aborted) throw new Error('runWhisper: aborted')

    if (code !== 0) {
      throw new AppError(
        'WHISPER_FAILED',
        'Transcription failed unexpectedly.',
        `whisper-cli exited with code ${code}\n${stderrTail}`,
      )
    }

    return segments
  } finally {
    signal?.removeEventListener('abort', onAbort)
    lines.close()
  }
}
