import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import verifyBeforePack from '../../scripts/verify-before-pack.mjs'

const execFileAsync = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../../scripts/verify-release-binaries.mjs', import.meta.url))

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

// The copyright banner FFmpeg compiles into every binary; the license gate
// treats a media binary lacking it as unverifiable.
const FFMPEG_BANNER = 'the FFmpeg developers'

// The arch header the detector reads, followed by the strings the license
// byte-scan looks for — a realistic stand-in for a provisioned ffmpeg/ffprobe.
function mediaBinary(platform: NodeJS.Platform, arch: 'arm64' | 'x64', configLine: string): Buffer {
  return Buffer.concat([
    executableHeader(platform, arch),
    Buffer.from(`\x00${FFMPEG_BANNER}\x00configuration: ${configLine}\x00`, 'latin1'),
  ])
}

type ReleaseFixtureOptions = {
  ffmpegArch?: 'arm64' | 'x64'
  ffprobeArch?: 'arm64' | 'x64'
  omit?: 'ffmpeg' | 'ffprobe'
  ffmpegConfig?: string
}

async function releaseFixture(options: ReleaseFixtureOptions = {}) {
  const targetArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ffmpegArch = options.ffmpegArch ?? targetArch
  const ffprobeArch = options.ffprobeArch ?? targetArch
  const cleanConfig = '--prefix=/x --disable-shared --enable-static'
  const root = await mkdtemp(join(tmpdir(), 'whisper-drop-release-'))
  const resDir = join(root, 'resources', `${process.platform}-${targetArch}`)
  await mkdir(resDir, { recursive: true })

  const exe = process.platform === 'win32' ? '.exe' : ''
  const writes = [
    writeFile(join(resDir, `whisper-cli${exe}`), executableHeader(process.platform, targetArch)),
  ]
  if (options.omit !== 'ffmpeg') {
    writes.push(
      writeFile(
        join(resDir, `ffmpeg${exe}`),
        mediaBinary(process.platform, ffmpegArch, options.ffmpegConfig ?? cleanConfig),
      ),
    )
  }
  if (options.omit !== 'ffprobe') {
    writes.push(
      writeFile(join(resDir, `ffprobe${exe}`), mediaBinary(process.platform, ffprobeArch, cleanConfig)),
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
      execFileAsync(process.execPath, [SCRIPT], {
        cwd: root,
        env: { ...process.env, TARGET_ARCH: targetArch },
      }),
    ).resolves.toMatchObject({ stderr: '' })
  })

  it.each([
    ['ffmpeg', 'ffmpegArch'],
    ['ffprobe', 'ffprobeArch'],
  ] as const)(
    'rejects a release whose %s executable has the wrong architecture',
    async (name, optionName) => {
      const wrongArch = process.arch === 'arm64' ? 'x64' : 'arm64'
      const { root, targetArch } = await releaseFixture({ [optionName]: wrongArch })

      await expect(
        execFileAsync(process.execPath, [SCRIPT], {
          cwd: root,
          env: { ...process.env, TARGET_ARCH: targetArch },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(new RegExp(`resources/.*${name}.*is built for`)),
      })
    },
  )

  it.each(['ffmpeg', 'ffprobe'] as const)(
    'rejects a release whose %s executable is missing',
    async (omit) => {
      const { root, targetArch } = await releaseFixture({ omit })

      await expect(
        execFileAsync(process.execPath, [SCRIPT], {
          cwd: root,
          env: { ...process.env, TARGET_ARCH: targetArch },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(new RegExp(`missing .*resources/.*${omit}`)),
      })
    },
  )

  it.skipIf(!supportedHost)('rejects a release whose ffmpeg is a nonfree build', async () => {
    const { root, targetArch } = await releaseFixture({
      ffmpegConfig: '--prefix=/x --enable-gpl --enable-nonfree',
    })

    await expect(
      execFileAsync(process.execPath, [SCRIPT], {
        cwd: root,
        env: { ...process.env, TARGET_ARCH: targetArch },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/--enable-nonfree/),
    })
  })
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
      ).rejects.toThrow(/resources\/.*ffprobe.*is built for/)
    },
  )
})
