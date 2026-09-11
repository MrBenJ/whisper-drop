import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * ffmpeg and ffprobe live beside whisper-cli in `resources/<platform>-<arch>/`,
 * provisioned by `scripts/build-ffmpeg.mjs` and shipped via electron-builder's
 * `extraResources`. Same resolution rule as the whisper binary.
 */
export function resolveFfmpegPath(env: BinaryEnv): string {
  const exe = env.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return join(resolveResourcesDir(env), exe)
}

export function resolveFfprobePath(env: BinaryEnv): string {
  const exe = env.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return join(resolveResourcesDir(env), exe)
}

export function resourcesDir(): string {
  return resolveResourcesDir(currentEnv())
}

export function whisperCliPath(): string {
  return resolveWhisperCliPath(currentEnv())
}

export function ffmpegPath(): string {
  return resolveFfmpegPath(currentEnv())
}

export function ffprobePath(): string {
  return resolveFfprobePath(currentEnv())
}
