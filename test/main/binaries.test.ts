import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ffmpegPath, ffprobePath, whisperCliPath } from '../../src/main/binaries.js'

const ORIGINAL = process.env.WHISPER_DROP_WHISPER_BIN

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WHISPER_DROP_WHISPER_BIN
  else process.env.WHISPER_DROP_WHISPER_BIN = ORIGINAL
})

describe('whisperCliPath', () => {
  it('honours the WHISPER_DROP_WHISPER_BIN override', () => {
    process.env.WHISPER_DROP_WHISPER_BIN = '/custom/whisper-cli'
    expect(whisperCliPath()).toBe('/custom/whisper-cli')
  })

  it('resolves to a file that exists once npm run setup has been run', () => {
    delete process.env.WHISPER_DROP_WHISPER_BIN
    expect(existsSync(whisperCliPath())).toBe(true)
  })

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
