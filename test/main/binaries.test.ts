import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type BinaryEnv,
  ffmpegPath,
  ffprobePath,
  isPackaged,
  resolveResourcesDir,
  resolveWhisperCliPath,
  unpackedPath,
  whisperCliPath,
} from '../../src/main/binaries.js'

const ORIGINAL = process.env.WHISPER_DROP_WHISPER_BIN

// `npm test` is the first thing a stranger runs on a fresh clone, before they've
// necessarily run `npm run setup` to build whisper.cpp. Skip (rather than fail)
// the assertions that need that built binary, with a reason naming the fix.
delete process.env.WHISPER_DROP_WHISPER_BIN
const whisperCliBuilt = existsSync(whisperCliPath())
if (ORIGINAL === undefined) delete process.env.WHISPER_DROP_WHISPER_BIN
else process.env.WHISPER_DROP_WHISPER_BIN = ORIGINAL

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WHISPER_DROP_WHISPER_BIN
  else process.env.WHISPER_DROP_WHISPER_BIN = ORIGINAL
})

/** A packaged macOS app: main is inside app.asar, resources sit beside it. */
const PACKAGED: BinaryEnv = {
  platform: 'darwin',
  arch: 'arm64',
  resourcesPath: '/Applications/whisper-drop.app/Contents/Resources',
  moduleDir: '/Applications/whisper-drop.app/Contents/Resources/app.asar/out/main',
}

/** `electron-vite dev` and the Playwright e2e launch both look like this. */
const DEV_UNDER_ELECTRON: BinaryEnv = {
  platform: 'darwin',
  arch: 'arm64',
  // Electron's own Resources directory, not ours — which is exactly why
  // `resourcesPath` alone cannot be the packaged signal.
  resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources',
  defaultApp: true,
  moduleDir: '/repo/out/main',
}

/** Plain Node: vitest, or any script importing the module directly. */
const DEV_UNDER_NODE: BinaryEnv = {
  platform: 'linux',
  arch: 'x64',
  moduleDir: '/repo/src/main',
}

describe('isPackaged', () => {
  it('is true when resourcesPath is set and defaultApp is not', () => {
    expect(isPackaged(PACKAGED)).toBe(true)
  })

  it('is false in development under Electron, where resourcesPath is also set', () => {
    expect(isPackaged(DEV_UNDER_ELECTRON)).toBe(false)
  })

  it('is false outside Electron entirely', () => {
    expect(isPackaged(DEV_UNDER_NODE)).toBe(false)
  })
})

describe('resolveResourcesDir — packaged', () => {
  it('resolves under process.resourcesPath, not relative to the module', () => {
    expect(resolveResourcesDir(PACKAGED)).toBe(
      '/Applications/whisper-drop.app/Contents/Resources/resources/darwin-arm64',
    )
  })

  it('never resolves inside the asar, which holds no real files', () => {
    expect(resolveResourcesDir(PACKAGED)).not.toContain('app.asar')
  })

  it('uses the platform and arch of the running app', () => {
    expect(
      resolveResourcesDir({ ...PACKAGED, platform: 'win32', arch: 'x64' }),
    ).toBe(join('/Applications/whisper-drop.app/Contents/Resources', 'resources', 'win32-x64'))
  })
})

describe('resolveResourcesDir — development', () => {
  it('resolves two levels above the built module, which is the repo root', () => {
    expect(resolveResourcesDir(DEV_UNDER_ELECTRON)).toBe(
      join('/repo', 'resources', 'darwin-arm64'),
    )
  })

  it('resolves two levels above the source module too, which is why vitest works', () => {
    expect(resolveResourcesDir(DEV_UNDER_NODE)).toBe(join('/repo', 'resources', 'linux-x64'))
  })

  it('ignores Electron own resourcesPath in development', () => {
    expect(resolveResourcesDir(DEV_UNDER_ELECTRON)).not.toContain('node_modules')
  })
})

describe('resolveWhisperCliPath', () => {
  it('names the binary whisper-cli off Windows', () => {
    expect(resolveWhisperCliPath(PACKAGED).endsWith('whisper-cli')).toBe(true)
  })

  it('names it whisper-cli.exe on Windows', () => {
    expect(
      resolveWhisperCliPath({ ...PACKAGED, platform: 'win32', arch: 'x64' }).endsWith(
        'whisper-cli.exe',
      ),
    ).toBe(true)
  })

  it('honours the override in a packaged app', () => {
    expect(
      resolveWhisperCliPath({ ...PACKAGED, whisperBinOverride: '/custom/whisper-cli' }),
    ).toBe('/custom/whisper-cli')
  })

  it('honours the override in development', () => {
    expect(
      resolveWhisperCliPath({ ...DEV_UNDER_NODE, whisperBinOverride: '/custom/whisper-cli' }),
    ).toBe('/custom/whisper-cli')
  })
})

describe('unpackedPath', () => {
  it('rewrites a posix path inside the asar', () => {
    expect(unpackedPath('/App/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg')).toBe(
      '/App/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg',
    )
  })

  it('rewrites a Windows path inside the asar', () => {
    expect(unpackedPath('C:\\Program Files\\whisper-drop\\resources\\app.asar\\node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe.exe')).toBe(
      'C:\\Program Files\\whisper-drop\\resources\\app.asar.unpacked\\node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe.exe',
    )
  })

  it('leaves a development path alone', () => {
    expect(unpackedPath('/repo/node_modules/ffmpeg-static/ffmpeg')).toBe(
      '/repo/node_modules/ffmpeg-static/ffmpeg',
    )
  })

  it('does not rewrite an already unpacked path twice', () => {
    const unpacked = '/App/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg'
    expect(unpackedPath(unpacked)).toBe(unpacked)
  })

  it('does not rewrite a directory that merely ends in app.asar', () => {
    expect(unpackedPath('/repo/my-app.asar/bin/ffmpeg')).toBe('/repo/my-app.asar/bin/ffmpeg')
  })
})

describe('whisperCliPath', () => {
  it('honours the WHISPER_DROP_WHISPER_BIN override', () => {
    process.env.WHISPER_DROP_WHISPER_BIN = '/custom/whisper-cli'
    expect(whisperCliPath()).toBe('/custom/whisper-cli')
  })

  it.skipIf(!whisperCliBuilt)(
    whisperCliBuilt
      ? 'resolves to a file that exists once npm run setup has been run'
      : 'resolves to a file that exists once npm run setup has been run (skipped: run `npm run setup` to build whisper.cpp first)',
    () => {
      delete process.env.WHISPER_DROP_WHISPER_BIN
      expect(existsSync(whisperCliPath())).toBe(true)
    },
  )

  it('includes the platform and architecture in the resolved path', () => {
    delete process.env.WHISPER_DROP_WHISPER_BIN
    expect(whisperCliPath()).toContain(`${process.platform}-${process.arch}`)
  })
})

describe('media binaries', () => {
  it('resolves ffmpeg to a file that exists', () => {
    expect(existsSync(ffmpegPath())).toBe(true)
  })

  it('resolves ffprobe to a file that exists', () => {
    expect(existsSync(ffprobePath())).toBe(true)
  })
})
