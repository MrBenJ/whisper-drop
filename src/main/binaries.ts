import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where the platform-matched whisper-cli lives.
 *
 * In a packaged Electron app (plan 4) `process.resourcesPath` is set and the
 * binary is unpacked beside the app. In development it sits under the repo's
 * `resources/` directory, built by `npm run setup`.
 */
export function resourcesDir(): string {
  const target = `${process.platform}-${process.arch}`

  // `resourcesPath` is added by Electron at runtime and is absent from
  // @types/node, so it is read defensively rather than declared.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resourcesPath ? join(resourcesPath, 'resources', target) : undefined

  if (packaged && existsSync(packaged)) return packaged

  return join(HERE, '..', '..', 'resources', target)
}

export function whisperCliPath(): string {
  const override = process.env.WHISPER_DROP_WHISPER_BIN
  if (override) return override

  return join(resourcesDir(), process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
}

export function ffmpegPath(): string {
  if (!ffmpegStatic) throw new Error('ffmpeg-static did not resolve a binary for this platform')
  return ffmpegStatic
}

export function ffprobePath(): string {
  return ffprobeStatic.path
}
