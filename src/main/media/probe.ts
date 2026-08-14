import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { ffprobePath as defaultFfprobePath } from '../binaries.js'
import { AppError } from '../../shared/errors.js'
import type { MediaInfo } from '../../shared/types.js'

const execFileAsync = promisify(execFileCb)

/** Ample headroom over execFile's 1 MB default for files with many streams or heavy metadata. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024

export type ExecFileFn = (
  file: string,
  args: string[],
  options?: { signal?: AbortSignal; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>

export type ProbeDeps = {
  ffprobePath?: string
  execFile?: ExecFileFn
  signal?: AbortSignal
}

function unreadable(path: string, detail: string): AppError {
  return new AppError(
    'UNREADABLE_MEDIA',
    "This file couldn't be read as audio or video.",
    `${path}\n${detail}`,
  )
}

/**
 * Ask ffprobe what this file is. Also serves as the file-validity check: if
 * ffprobe cannot read it, we reject it. There is deliberately no extension
 * allowlist anywhere in the codebase.
 */
export async function probe(filePath: string, deps: ProbeDeps = {}): Promise<MediaInfo> {
  const exec: ExecFileFn =
    deps.execFile ??
    ((file, args, options) =>
      execFileAsync(file, args, options) as Promise<{ stdout: string; stderr: string }>)
  const binary = deps.ffprobePath ?? defaultFfprobePath()

  let stdout: string
  try {
    ;({ stdout } = await exec(
      binary,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { signal: deps.signal, maxBuffer: MAX_BUFFER_BYTES },
    ))
  } catch (cause) {
    // promisify(execFile) attaches `stderr: ''` (not undefined) on ENOENT, so
    // `??` would keep the empty string; `||` falls through to the full error.
    const stderr = (cause as { stderr?: string }).stderr || String(cause)
    throw unreadable(filePath, stderr)
  }

  let parsed: {
    format?: { duration?: string; format_name?: string }
    streams?: { codec_type?: string }[]
  }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw unreadable(filePath, `ffprobe returned unparseable output:\n${stdout.slice(0, 500)}`)
  }

  const durationSeconds = Number(parsed.format?.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw unreadable(filePath, `ffprobe reported no usable duration: ${parsed.format?.duration}`)
  }

  return {
    path: filePath,
    durationMs: Math.round(durationSeconds * 1_000),
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio'),
    container: parsed.format?.format_name ?? 'unknown',
  }
}
