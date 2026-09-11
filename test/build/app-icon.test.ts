import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ffmpegPath } from '../../src/main/binaries.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CONFIG = JSON.parse(readFileSync(`${ROOT}/electron-builder.json`, 'utf8')) as {
  mac: { icon?: string }
  win: { icon?: string }
  linux: { icon?: string }
}

const expectedFiles = [
  'build/icon.svg',
  'build/icon.icns',
  'build/icon.ico',
  'build/icons/16x16.png',
  'build/icons/32x32.png',
  'build/icons/48x48.png',
  'build/icons/64x64.png',
  'build/icons/128x128.png',
  'build/icons/256x256.png',
  'build/icons/512x512.png',
  'build/icons/1024x1024.png',
] as const

describe('app icon packaging', () => {
  it('declares an explicit icon for every packaged platform', () => {
    expect(CONFIG.mac.icon).toBe('build/icon.icns')
    expect(CONFIG.win.icon).toBe('build/icon.ico')
    expect(CONFIG.linux.icon).toBe('build/icons')
  })

  it.each(expectedFiles)('ships a non-empty %s source asset', (relativePath) => {
    const path = `${ROOT}/${relativePath}`
    expect(existsSync(path), `${relativePath} is missing`).toBe(true)
    expect(statSync(path).size, `${relativePath} is empty`).toBeGreaterThan(100)
  })

  it('keeps the largest Linux raster at 1024 × 1024', () => {
    const png = readFileSync(`${ROOT}/build/icons/1024x1024.png`)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.readUInt32BE(16)).toBe(1024)
    expect(png.readUInt32BE(20)).toBe(1024)
  })

  // Skips when ffmpeg isn't provisioned yet (the unit-test CI job runs no
  // setup); the integration/e2e jobs and local `npm run setup` exercise it.
  it.skipIf(!existsSync(ffmpegPath()))('keeps the monogram legible at Dock scale', () => {
    const rgba = execFileSync(ffmpegPath(), [
      '-v', 'error',
      '-i', `${ROOT}/build/icons/32x32.png`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1',
    ])
    expect(rgba.length).toBe(32 * 32 * 4)
    let brightMonogramPixels = 0

    for (let y = 13; y <= 19; y += 1) {
      for (let x = 8; x <= 23; x += 1) {
        const offset = (y * 32 + x) * 4
        const luminance =
          rgba.readUInt8(offset) * 0.2126 +
          rgba.readUInt8(offset + 1) * 0.7152 +
          rgba.readUInt8(offset + 2) * 0.0722
        if (luminance > 160) brightMonogramPixels += 1
      }
    }

    expect(brightMonogramPixels).toBeGreaterThanOrEqual(10)
  })

  it('ships valid native icon containers for macOS and Windows', () => {
    const icns = readFileSync(`${ROOT}/build/icon.icns`)
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)

    const ico = readFileSync(`${ROOT}/build/icon.ico`)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(6)
  })
})
