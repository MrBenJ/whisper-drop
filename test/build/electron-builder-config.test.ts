import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every assertion here guards a failure that a build cannot show you: the
 * artifact installs, launches, and only then cannot transcribe. Dropping one
 * of these entries produces exactly that, so it fails here instead.
 *
 * The config is JSON rather than the YAML the parent spec sketched so this
 * test can read it with no parser and no new dependency. electron-builder
 * discovers `electron-builder.json` natively.
 */
const CONFIG = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../electron-builder.json', import.meta.url)), 'utf8'),
) as {
  files: string[]
  asar: boolean
  asarUnpack: string[]
  extraResources: { from: string; to: string }[]
  publish: unknown
  directories: { output: string }
  mac: { target: unknown[]; identity: unknown; notarize: unknown }
  win: { target: unknown[] }
  linux: { target: unknown[]; category: string; maintainer: string }
}

describe('asar packing', () => {
  it('keeps asar on, so asarUnpack means something', () => {
    expect(CONFIG.asar).toBe(true)
  })

  // A binary inside app.asar is not a real file on disk and cannot be
  // spawned. Without these two entries the app builds, installs and launches
  // cleanly, then fails on the first transcription with an ENOENT naming a
  // path that looks like it exists.
  it('unpacks ffmpeg-static, which is spawned as a child process', () => {
    expect(CONFIG.asarUnpack).toContain('node_modules/ffmpeg-static/**')
  })

  it('unpacks ffprobe-static, which is spawned as a child process', () => {
    expect(CONFIG.asarUnpack).toContain('node_modules/ffprobe-static/**')
  })
})

describe('extraResources', () => {
  it('packs exactly one entry: the platform-matched whisper-cli directory', () => {
    expect(CONFIG.extraResources).toHaveLength(1)
  })

  // `${platform}` and `${arch}` expand to node's own names (darwin/win32/linux,
  // arm64/x64), which is the same string `binaries.ts` builds its target
  // directory from. Change one side and this pair silently stops matching.
  it('reads from resources/<platform>-<arch> in the repo', () => {
    expect(CONFIG.extraResources[0]?.from).toBe('resources/${platform}-${arch}')
  })

  it('writes to the same relative path under process.resourcesPath', () => {
    expect(CONFIG.extraResources[0]?.to).toBe('resources/${platform}-${arch}')
  })
})

describe('targets', () => {
  // `${platform}` above is the *host* platform and `${arch}` the target arch,
  // so an artifact can only be correct when the arch electron-builder is asked
  // for is the arch `npm run setup` compiled whisper-cli for. Declaring an
  // arch list here would let one invocation produce several artifacts, all but
  // one of them missing whisper-cli entirely. Arch is passed per invocation
  // instead (`--arm64`, `--x64`), which is why these stay plain strings.
  it('declares plain string targets, never per-target arch lists', () => {
    expect(CONFIG.mac.target).toEqual(['dmg'])
    expect(CONFIG.win.target).toEqual(['nsis'])
    expect(CONFIG.linux.target).toEqual(['AppImage', 'deb'])
  })
})

describe('signing and publishing', () => {
  it('never signs on macOS', () => {
    expect(CONFIG.mac.identity).toBeNull()
    expect(CONFIG.mac.notarize).toBe(false)
  })

  it('publishes nothing', () => {
    expect(CONFIG.publish).toBeNull()
  })
})

describe('what ships inside the app', () => {
  it('ships only the built output and the manifest', () => {
    expect(CONFIG.files).toEqual(['out/**', 'package.json'])
  })

  // `.cache/` holds the whisper.cpp clone, its build tree and the test model —
  // gigabytes. `resources/` ships via extraResources instead. Neither is
  // matched by the allowlist above, and this states why that matters.
  it('does not ship the build cache or a second copy of resources', () => {
    expect(CONFIG.files.some((pattern) => pattern.startsWith('.cache'))).toBe(false)
    expect(CONFIG.files.some((pattern) => pattern.startsWith('resources'))).toBe(false)
  })

  it('writes artifacts to dist/, which is not the electron-vite out/ directory', () => {
    expect(CONFIG.directories.output).toBe('dist')
  })
})

describe('linux packaging metadata', () => {
  // The deb target refuses to build without a maintainer in `Name <email>`
  // form, and package.json carries no author email.
  it('carries a maintainer the deb target will accept', () => {
    expect(CONFIG.linux.maintainer).toMatch(/^.+ <[^@\s]+@[^@\s]+>$/)
  })

  it('carries a category the deb target will accept', () => {
    expect(CONFIG.linux.category).toBe('AudioVideo')
  })
})
