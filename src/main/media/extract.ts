import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ffmpegPath as defaultFfmpegPath } from '../binaries.js'
import { AppError } from '../../shared/errors.js'
import type { SpawnFn, SpawnedProcess } from '../process.js'

export type ExtractDeps = {
  ffmpegPath?: string
  spawn?: SpawnFn
}

export type ExtractOptions = {
  inputPath: string
  outputPath: string
  /** From the probe. Used to turn ffmpeg's out_time_us into a fraction. */
  durationMs: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** How much stderr to keep for the error detail. */
const STDERR_TAIL_BYTES = 4_000

/** Convert any media file into the 16 kHz mono WAV whisper.cpp requires. */
export async function extractWav(options: ExtractOptions, deps: ExtractDeps = {}): Promise<void> {
  const { inputPath, outputPath, durationMs, onProgress, signal } = options

  if (signal?.aborted) throw new Error('extractWav: aborted before starting')

  const spawn = deps.spawn ?? ((file, args) => nodeSpawn(file, args) as unknown as SpawnedProcess)
  const binary = deps.ffmpegPath ?? defaultFfmpegPath()

  const child = spawn(binary, [
    '-nostdin',
    '-loglevel', 'error',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    '-progress', 'pipe:1',
    '-y',
    outputPath,
  ])

  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES)
  })

  if (onProgress) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const match = /^out_time_us=(\d+)$/.exec(line.trim())
      if (!match) return

      const elapsedMs = Number(match[1]) / 1_000
      // A zero duration means we cannot compute a fraction; report completion
      // rather than dividing by zero.
      onProgress(durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : 1)
    })
  } else {
    child.stdout.resume()
  }

  const onAbort = () => child.kill('SIGKILL')
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on('close', resolve)
      child.on('error', reject)
    })

    if (signal?.aborted) throw new Error('extractWav: aborted')

    if (code !== 0) {
      throw new AppError(
        'FFMPEG_FAILED',
        "Couldn't prepare the audio from this file.",
        `ffmpeg exited with code ${code}\n${stderrTail}`,
      )
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
