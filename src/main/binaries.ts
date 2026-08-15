import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { AppError } from '../shared/errors.js'

/**
 * Everything path resolution depends on, in one place, so both branches are
 * testable without an Electron app or a packaged bundle.
 */
export type BinaryEnv = {
  platform: NodeJS.Platform
  arch: string
  /** Electron's `process.resourcesPath`. Undefined outside Electron. */
  resourcesPath?: string
  /** Electron's `process.defaultApp`: true when started as `electron <dir>`. */
  defaultApp?: boolean
  /** Directory of this module: `out/main` when built, `src/main` from source. */
  moduleDir: string
  whisperBinOverride?: string
}

const HERE = dirname(fileURLToPath(import.meta.url))

export function currentEnv(): BinaryEnv {
  // `resourcesPath` and `defaultApp` are Electron additions, absent from
  // @types/node, so they are read defensively rather than declared.
  const electronProcess = process as NodeJS.Process & {
    resourcesPath?: string
    defaultApp?: boolean
  }

  return {
    platform: process.platform,
    arch: process.arch,
    resourcesPath: electronProcess.resourcesPath,
    defaultApp: electronProcess.defaultApp,
    moduleDir: HERE,
    whisperBinOverride: process.env.WHISPER_DROP_WHISPER_BIN,
  }
}

/**
 * Packaged means: inside Electron (`resourcesPath` is set) and *not* started
 * as `electron <dir>` (`defaultApp`). Both development runs — `electron-vite
 * dev` and the Playwright e2e launch — set `defaultApp`, and their
 * `resourcesPath` points at Electron's own Resources directory, not ours.
 */
export function isPackaged(env: BinaryEnv): boolean {
  return typeof env.resourcesPath === 'string' && env.defaultApp !== true
}

export function targetTriple(env: BinaryEnv): string {
  return `${env.platform}-${env.arch}`
}

/**
 * Packaged: `<resourcesPath>/resources/<platform>-<arch>`, where
 * electron-builder's `extraResources` entry puts it.
 * Development: `<repo>/resources/<platform>-<arch>`, written by `npm run setup`.
 *
 * The repo root is exactly two levels above this module in both places it
 * runs from — `out/main/` when built, `src/main/` under vitest. That is the
 * whole rule; it is stated here rather than relied on by accident.
 */
export function resolveResourcesDir(env: BinaryEnv): string {
  if (isPackaged(env)) {
    return join(env.resourcesPath as string, 'resources', targetTriple(env))
  }
  return join(env.moduleDir, '..', '..', 'resources', targetTriple(env))
}

export function resolveWhisperCliPath(env: BinaryEnv): string {
  if (env.whisperBinOverride) return env.whisperBinOverride

  const exe = env.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  return join(resolveResourcesDir(env), exe)
}

// Matched with both separators so the rule is the same on every host, which
// is what lets the Windows case be tested from macOS or Linux. Anchored on
// separators either side: `my-app.asar/` is not an archive, and an already
// rewritten `app.asar.unpacked/` must not be rewritten twice.
const ASAR_SEGMENT = /([\\/])app\.asar([\\/])/

/**
 * `ffmpeg-static` and `ffprobe-static` compute their paths from their own
 * `__dirname`, which in a packaged app is inside `app.asar`. A file in an asar
 * archive is not a real file on disk and cannot be spawned, so both packages
 * are unpacked (`asarUnpack` in `electron-builder.json`) and the path has to
 * point at the unpacked copy. A no-op everywhere else.
 */
export function unpackedPath(path: string): string {
  return path.replace(ASAR_SEGMENT, '$1app.asar.unpacked$2')
}

export function resourcesDir(): string {
  return resolveResourcesDir(currentEnv())
}

export function whisperCliPath(): string {
  return resolveWhisperCliPath(currentEnv())
}

export function ffmpegPath(): string {
  if (!ffmpegStatic) {
    throw new AppError(
      'FFMPEG_FAILED',
      "Couldn't prepare the audio from this file.",
      `ffmpeg-static did not resolve a binary for ${process.platform}-${process.arch}`,
    )
  }
  return unpackedPath(ffmpegStatic)
}

export function ffprobePath(): string {
  return unpackedPath(ffprobeStatic.path)
}
