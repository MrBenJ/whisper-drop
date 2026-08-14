import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { ffprobePath as defaultFfprobePath } from '../binaries.js'
import { AppError } from '../../shared/errors.js'
import type { MediaInfo } from '../../shared/types.js'

const execFileAsync = promisify(execFileCb)

export type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

export type ProbeDeps = {
  ffprobePath?: string
  execFile?: ExecFileFn
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
  const exec = deps.execFile ?? ((file, args) => execFileAsync(file, args))
  const binary = deps.ffprobePath ?? defaultFfprobePath()

  let stdout: string
  try {
    ;({ stdout } = await exec(binary, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]))
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? String(cause)
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
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw unreadable(filePath, `ffprobe reported no usable duration: ${parsed.format?.duration}`)
  }

  return {
    path: filePath,
    durationMs: Math.round(durationSeconds * 1_000),
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio'),
    container: parsed.format?.format_name ?? 'unknown',
  }
}
