import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_FLAGS,
  scanFfmpegLicense,
  assertRedistributableFfmpeg,
} from '../../scripts/lib/ffmpeg-license.mjs'

// The copyright banner FFmpeg compiles into every ffmpeg/ffprobe binary; its
// presence is how we know we're scanning a real ffmpeg build and not some
// unrelated file that trivially lacks the forbidden flags.
const BANNER = 'the FFmpeg developers'

function fakeBinary(configLine: string): Buffer {
  return Buffer.from(`\x00\x00${BANNER}\x00configuration: ${configLine}\x00\x00`, 'latin1')
}

describe('scanFfmpegLicense', () => {
  it('flags a build with the two forbidden flags in its config', () => {
    const buf = fakeBinary('--prefix=/x --enable-gpl --enable-version3 --enable-nonfree')
    const { hasConfig, forbidden } = scanFfmpegLicense(buf)
    expect(hasConfig).toBe(true)
    expect(forbidden.sort()).toEqual([...FORBIDDEN_FLAGS].sort())
  })

  it('passes a clean LGPL build', () => {
    const buf = fakeBinary('--prefix=/x --disable-shared --enable-static')
    const { hasConfig, forbidden } = scanFfmpegLicense(buf)
    expect(hasConfig).toBe(true)
    expect(forbidden).toEqual([])
  })

  it('reports hasConfig=false for a buffer with no ffmpeg banner', () => {
    expect(scanFfmpegLicense(Buffer.from('not an ffmpeg binary')).hasConfig).toBe(false)
  })
})

describe('assertRedistributableFfmpeg', () => {
  it('throws naming each forbidden flag', () => {
    const buf = fakeBinary('--enable-gpl --enable-nonfree')
    expect(() => assertRedistributableFfmpeg(buf, 'darwin-arm64/ffmpeg')).toThrow(
      /darwin-arm64\/ffmpeg.*--enable-nonfree/,
    )
  })

  it('throws when the binary is not recognizably ffmpeg', () => {
    expect(() => assertRedistributableFfmpeg(Buffer.from('junk'), 'x/ffmpeg')).toThrow(
      /no embedded ffmpeg configuration/i,
    )
  })

  it('returns for a clean LGPL build', () => {
    expect(() =>
      assertRedistributableFfmpeg(fakeBinary('--disable-shared --enable-static'), 'x/ffmpeg'),
    ).not.toThrow()
  })
})
