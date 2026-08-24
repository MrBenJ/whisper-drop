import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import verifyBeforePack from '../../scripts/verify-before-pack.mjs'

const execFileAsync = promisify(execFile)
const SCRIPT = new URL('../../scripts/verify-release-binaries.mjs', import.meta.url)

function executableHeader(platform: NodeJS.Platform, arch: 'arm64' | 'x64'): Buffer {
  if (platform === 'darwin') {
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    return header
  }

  if (platform === 'win32') {
    const header = Buffer.alloc(128)
    header.writeUInt32LE(64, 0x3c)
    header.write('PE\0\0', 64, 'binary')
    header.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 68)
    return header
  }

  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0)
  header.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18)
  return header
}

type ReleaseFixtureOptions = {
  ffmpegArch?: 'arm64' | 'x64'
  ffprobeArch?: 'arm64' | 'x64'
  omit?: 'ffmpeg' | 'ffprobe'
}

async function releaseFixture(options: ReleaseFixtureOptions = {}) {
  const targetArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ffmpegArch = options.ffmpegArch ?? targetArch
  const ffprobeArch = options.ffprobeArch ?? targetArch
  const root = await mkdtemp(join(tmpdir(), 'whisper-drop-release-'))
  const whisperDir = join(root, 'resources', `${process.platform}-${targetArch}`)
  const ffmpegDir = join(root, 'node_modules', 'ffmpeg-static')
  const ffprobeDir = join(root, 'node_modules', '@derhuerst', 'ffprobe-static')
  await Promise.all([
    mkdir(whisperDir, { recursive: true }),
    mkdir(ffmpegDir, { recursive: true }),
    mkdir(ffprobeDir, { recursive: true }),
  ])

  const exe = process.platform === 'win32' ? '.exe' : ''
  const writes = [
    writeFile(join(whisperDir, `whisper-cli${exe}`), executableHeader(process.platform, targetArch)),
  ]
  if (options.omit !== 'ffmpeg') {
    writes.push(
      writeFile(join(ffmpegDir, `ffmpeg${exe}`), executableHeader(process.platform, ffmpegArch)),
    )
  }
  if (options.omit !== 'ffprobe') {
    writes.push(
      writeFile(join(ffprobeDir, `ffprobe${exe}`), executableHeader(process.platform, ffprobeArch)),
    )
  }
  await Promise.all(writes)

  return { root, targetArch }
}

describe('verify-release-binaries', () => {
  const supportedHost = process.arch === 'arm64' || process.arch === 'x64'

  it.skipIf(!supportedHost)('accepts a release whose three executables match the target', async () => {
    const { root, targetArch } = await releaseFixture()

    await expect(
      execFileAsync(process.execPath, [SCRIPT.pathname], {
        cwd: root,
        env: { ...process.env, TARGET_ARCH: targetArch },
      }),
    ).resolves.toMatchObject({ stderr: '' })
  })

  it.each([
    ['ffmpeg-static', 'ffmpegArch'],
    ['@derhuerst/ffprobe-static', 'ffprobeArch'],
  ] as const)(
    'rejects a release whose %s executable has the wrong architecture',
    async (packageName, optionName) => {
      const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64'
      const { root, targetArch } = await releaseFixture({ [optionName]: wrongArch })

      await expect(
        execFileAsync(process.execPath, [SCRIPT.pathname], {
          cwd: root,
          env: { ...process.env, TARGET_ARCH: targetArch },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(new RegExp(`${packageName.replace('/', '\\/')}.*is built for`)),
      })
    },
  )

  it.each([
    ['ffmpeg-static', 'ffmpeg'],
    ['@derhuerst/ffprobe-static', 'ffprobe'],
  ] as const)(
    'rejects a release whose %s executable is missing',
    async (packageName, omit) => {
      const { root, targetArch } = await releaseFixture({ omit })

      await expect(
        execFileAsync(process.execPath, [SCRIPT.pathname], {
          cwd: root,
          env: { ...process.env, TARGET_ARCH: targetArch },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(new RegExp(`missing .*${packageName.replace('/', '\\/')}`)),
      })
    },
  )
})

describe('verify-before-pack', () => {
  it.skipIf(process.arch !== 'arm64' && process.arch !== 'x64')(
    'rejects packaging when a bundled media executable targets the other architecture',
    async () => {
      const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64'
      const { root } = await releaseFixture({ ffprobeArch: wrongArch })
      const arch = process.arch === 'arm64' ? 3 : 1

      await expect(
        verifyBeforePack({
          arch,
          electronPlatformName: process.platform,
          packager: { projectDir: root },
        }),
      ).rejects.toThrow(/@derhuerst\/ffprobe-static\/ffprobe.*is built for/)
    },
  )
})
