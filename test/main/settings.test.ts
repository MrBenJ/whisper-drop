import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSettingsStore, defaultSettings } from '../../src/main/settings.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wd-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('defaultSettings', () => {
  it('starts English-only for an English locale', () => {
    expect(defaultSettings('en-US').englishOnly).toBe(true)
    expect(defaultSettings('en').englishOnly).toBe(true)
  })

  it('starts multilingual for a non-English locale', () => {
    expect(defaultSettings('fr-FR').englishOnly).toBe(false)
    expect(defaultSettings('').englishOnly).toBe(false)
  })

  it('starts with no active model, which is what triggers the first-run picker', () => {
    expect(defaultSettings('en-US').activeModel).toBeNull()
  })

  it('starts with auto language detection and no throughput history', () => {
    const settings = defaultSettings('en-US')
    expect(settings.language).toBe('auto')
    expect(settings.throughput).toEqual({})
    expect(settings.version).toBe(1)
  })
})

describe('createSettingsStore', () => {
  it('returns defaults when no file exists yet', async () => {
    const store = createSettingsStore(dir, 'en-US')
    expect((await store.read()).activeModel).toBeNull()
  })

  it('round-trips a written value', async () => {
    const store = createSettingsStore(dir, 'en-US')
    await store.write({ activeModel: 'base' })
    expect((await store.read()).activeModel).toBe('base')
  })

  it('merges a partial patch rather than replacing the whole object', async () => {
    const store = createSettingsStore(dir, 'en-US')
    await store.write({ activeModel: 'small', language: 'de' })
    await store.write({ activeModel: 'tiny' })

    const settings = await store.read()
    expect(settings.activeModel).toBe('tiny')
    expect(settings.language).toBe('de')
  })

  it('persists across store instances', async () => {
    await createSettingsStore(dir, 'en-US').write({ englishOnly: false })
    expect((await createSettingsStore(dir, 'en-US').read()).englishOnly).toBe(false)
  })

  it('writes through a temp file and renames it into place', async () => {
    // Pre-seed a stale .tmp with junk. temp-then-rename overwrites it and
    // renames it away; a direct writeFile(file, ...) would leave it sitting
    // there untouched, so this distinguishes the two without fs mocking.
    await writeFile(join(dir, 'settings.json.tmp'), 'junk', 'utf8')
    const store = createSettingsStore(dir, 'en-US')
    await store.write({ activeModel: 'base' })

    expect((await store.read()).activeModel).toBe('base')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('falls back to defaults on a corrupt file rather than throwing', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not json at all', 'utf8')
    const store = createSettingsStore(dir, 'en-US')
    expect((await store.read()).activeModel).toBeNull()
  })

  it('preserves a corrupt file as settings.corrupt.json so the failure is diagnosable', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not json at all', 'utf8')
    await createSettingsStore(dir, 'en-US').read()

    expect(await readFile(join(dir, 'settings.corrupt.json'), 'utf8')).toBe('{ not json at all')
  })

  it('falls back to defaults for an unrecognised future version', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 99, activeModel: 'large-v3' }),
      'utf8',
    )
    expect((await createSettingsStore(dir, 'en-US').read()).activeModel).toBeNull()
  })
})

describe('reading malformed but structurally-valid JSON', () => {
  it('falls back to null for an activeModel that is not a known base id', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, activeModel: 'nope' }),
      'utf8',
    )
    expect((await createSettingsStore(dir, 'en-US').read()).activeModel).toBeNull()
  })

  it('falls back to {} when throughput is not an object', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, throughput: 'bad' }),
      'utf8',
    )
    expect((await createSettingsStore(dir, 'en-US').read()).throughput).toEqual({})
  })

  it('drops individual throughput entries that are the wrong shape', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        throughput: { base: { realtimeFactor: 12, samples: 3 }, tiny: 'bad', small: { realtimeFactor: 'x' } },
      }),
      'utf8',
    )
    const settings = await createSettingsStore(dir, 'en-US').read()
    expect(settings.throughput).toEqual({ base: { realtimeFactor: 12, samples: 3 } })
  })

  it('drops throughput entries with a non-finite realtimeFactor or samples', async () => {
    // NaN isn't representable in JSON; JSON.stringify(NaN) serialises it as
    // null, which is exactly the shape a corrupted file would produce, so
    // write it directly rather than round-tripping through JSON.stringify.
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        throughput: {
          base: { realtimeFactor: 12, samples: 3 },
          tiny: { realtimeFactor: null, samples: 1 },
        },
      }),
      'utf8',
    )
    const settings = await createSettingsStore(dir, 'en-US').read()
    expect(settings.throughput).toEqual({ base: { realtimeFactor: 12, samples: 3 } })
  })

  it('drops throughput keys that are structurally valid but not a real ModelId', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        throughput: {
          base: { realtimeFactor: 12, samples: 3 },
          'not-a-model': { realtimeFactor: 5, samples: 1 },
        },
      }),
      'utf8',
    )
    const settings = await createSettingsStore(dir, 'en-US').read()
    expect(settings.throughput).toEqual({ base: { realtimeFactor: 12, samples: 3 } })
  })

  it('falls back to the locale default when englishOnly is not a boolean', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, englishOnly: 'yes' }),
      'utf8',
    )
    expect((await createSettingsStore(dir, 'fr-FR').read()).englishOnly).toBe(false)
    expect((await createSettingsStore(dir, 'en-US').read()).englishOnly).toBe(true)
  })

  it('preserves valid fields alongside invalid ones rather than discarding the whole file', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, activeModel: 'nope', throughput: 'bad', language: 'de' }),
      'utf8',
    )
    const settings = await createSettingsStore(dir, 'en-US').read()
    expect(settings.activeModel).toBeNull()
    expect(settings.throughput).toEqual({})
    expect(settings.language).toBe('de')
  })
})

describe('recordThroughput', () => {
  it('records a first sample verbatim', async () => {
    const store = createSettingsStore(dir, 'en-US')
    const settings = await store.recordThroughput('base', 12)

    expect(settings.throughput.base).toEqual({ realtimeFactor: 12, samples: 1 })
  })

  it('keeps a running mean across samples', async () => {
    const store = createSettingsStore(dir, 'en-US')
    await store.recordThroughput('base', 10)
    await store.recordThroughput('base', 20)
    const settings = await store.recordThroughput('base', 30)

    expect(settings.throughput.base).toEqual({ realtimeFactor: 20, samples: 3 })
  })

  it('tracks models independently', async () => {
    const store = createSettingsStore(dir, 'en-US')
    await store.recordThroughput('base', 10)
    await store.recordThroughput('tiny', 40)

    const settings = await store.read()
    expect(settings.throughput.base?.realtimeFactor).toBe(10)
    expect(settings.throughput.tiny?.realtimeFactor).toBe(40)
  })

  it('persists the throughput map', async () => {
    await createSettingsStore(dir, 'en-US').recordThroughput('small', 5)
    expect((await createSettingsStore(dir, 'en-US').read()).throughput.small?.samples).toBe(1)
  })
})
