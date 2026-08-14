import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  MODEL_BASE_ORDER,
  MODEL_URL_PREFIX,
  baseIds,
  entryFor,
  resolveModelId,
} from '../../../src/main/models/catalog.js'

describe('resolveModelId', () => {
  it('returns the .en variant for tiny, base and small when English-only is on', () => {
    expect(resolveModelId('tiny', true)).toBe('tiny.en')
    expect(resolveModelId('base', true)).toBe('base.en')
    expect(resolveModelId('small', true)).toBe('small.en')
  })

  it('returns multilingual weights for those same rows when English-only is off', () => {
    expect(resolveModelId('tiny', false)).toBe('tiny')
    expect(resolveModelId('base', false)).toBe('base')
    expect(resolveModelId('small', false)).toBe('small')
  })

  it('leaves the large rows unchanged in both modes, since no .en variant exists above small', () => {
    expect(resolveModelId('large-v3-turbo', true)).toBe('large-v3-turbo')
    expect(resolveModelId('large-v3-turbo', false)).toBe('large-v3-turbo')
    expect(resolveModelId('large-v3', true)).toBe('large-v3')
    expect(resolveModelId('large-v3', false)).toBe('large-v3')
  })

  it('always resolves to an id that exists in the catalog', () => {
    for (const base of MODEL_BASE_ORDER) {
      for (const englishOnly of [true, false]) {
        expect(() => entryFor(resolveModelId(base, englishOnly))).not.toThrow()
      }
    }
  })
})

describe('CATALOG integrity', () => {
  it('has a multilingual entry for every base id', () => {
    for (const base of MODEL_BASE_ORDER) {
      expect(CATALOG.find((e) => e.base === base && !e.englishOnly)).toBeDefined()
    }
  })

  it('has no duplicate ids', () => {
    const ids = CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every entry a 64-character lowercase hex sha256', () => {
    for (const entry of CATALOG) {
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('gives every entry a positive byte count', () => {
    for (const entry of CATALOG) {
      expect(entry.bytes, entry.id).toBeGreaterThan(0)
    }
  })

  it('points every url at the pinned HuggingFace repo and matches the id', () => {
    for (const entry of CATALOG) {
      expect(entry.url).toBe(
        `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${entry.id}.bin`,
      )
    }
  })

  it('builds every url from the exported MODEL_URL_PREFIX, the downloader\'s trust boundary', () => {
    expect(MODEL_URL_PREFIX).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/')
    for (const entry of CATALOG) {
      expect(entry.url.startsWith(MODEL_URL_PREFIX)).toBe(true)
    }
  })

  it('marks englishOnly exactly when the id carries the .en suffix', () => {
    for (const entry of CATALOG) {
      expect(entry.englishOnly, entry.id).toBe(entry.id.endsWith('.en'))
    }
  })

  it('has no .en variant above small, which is what forces the partial toggle swap', () => {
    expect(CATALOG.find((e) => (e.id as string) === 'large-v3.en')).toBeUndefined()
    expect(CATALOG.find((e) => (e.id as string) === 'large-v3-turbo.en')).toBeUndefined()
  })

  it('orders picker rows ascending by capability', () => {
    expect(baseIds()).toEqual(['tiny', 'base', 'small', 'large-v3-turbo', 'large-v3'])
  })

  it('gives every entry a non-empty label and blurb', () => {
    for (const entry of CATALOG) {
      expect(entry.label.length, entry.id).toBeGreaterThan(0)
      expect(entry.blurb.length, entry.id).toBeGreaterThan(0)
    }
  })
})

describe('entryFor', () => {
  it('returns the entry for a known id', () => {
    expect(entryFor('base.en').bytes).toBe(147964211)
  })

  it('throws on an unknown id', () => {
    expect(() => entryFor('nope' as never)).toThrow(/unknown model/i)
  })
})
