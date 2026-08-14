import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ffmpegPath, ffprobePath, whisperCliPath } from '../../src/main/binaries.js'

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
