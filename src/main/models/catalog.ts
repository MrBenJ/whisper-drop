/** A row in the model picker. */
export type ModelBaseId = 'tiny' | 'base' | 'small' | 'large-v3-turbo' | 'large-v3'

/** A concrete model file. */
export type ModelId = ModelBaseId | 'tiny.en' | 'base.en' | 'small.en'

export type ModelEntry = {
  id: ModelId
  base: ModelBaseId
  label: string
  bytes: number
  sha256: string
  url: string
  blurb: string
  englishOnly: boolean
}

/** Picker order: ascending by capability. */
export const MODEL_BASE_ORDER: readonly ModelBaseId[] = [
  'tiny',
  'base',
  'small',
  'large-v3-turbo',
  'large-v3',
]

/**
 * Single source of truth for the trust boundary: every catalog URL is built
 * from this prefix, and the downloader validates full URLs against it (not
 * just the host) so a catalog entry pointing at a different repo on the same
 * host is refused.
 */
export const MODEL_URL_PREFIX = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

function entry(
  id: ModelId,
  base: ModelBaseId,
  label: string,
  bytes: number,
  sha256: string,
  blurb: string,
): ModelEntry {
  return {
    id,
    base,
    label,
    bytes,
    sha256,
    url: `${MODEL_URL_PREFIX}ggml-${id}.bin`,
    blurb,
    englishOnly: id.endsWith('.en'),
  }
}

// Sizes and hashes read from the HuggingFace API on 2026-08-13. HuggingFace's
// lfs.oid is the file's sha256 — verified against a local shasum of ggml-tiny.bin.
export const CATALOG: readonly ModelEntry[] = [
  entry('tiny', 'tiny', 'Tiny', 77691713,
    'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    'Fastest. Rough. Fine for voice memos.'),
  entry('tiny.en', 'tiny', 'Tiny', 77704715,
    '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    'Fastest. Rough. Fine for voice memos.'),
  entry('base', 'base', 'Base', 147951465,
    '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    'Good default. Quick, decent accuracy.'),
  entry('base.en', 'base', 'Base', 147964211,
    'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    'Good default. Quick, decent accuracy.'),
  entry('small', 'small', 'Small', 487601967,
    '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    'Better with accents and crosstalk.'),
  entry('small.en', 'small', 'Small', 487614201,
    'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    'Better with accents and crosstalk.'),
  entry('large-v3-turbo', 'large-v3-turbo', 'Large v3 Turbo', 1624555275,
    '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    'Near-best accuracy, several times faster. Recommended for long recordings.'),
  entry('large-v3', 'large-v3', 'Large v3', 3095033483,
    '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    'Best accuracy. Slow.'),
]

/**
 * The only place a concrete ModelId is derived from a picker row. OpenAI never
 * shipped English-only weights above `small`, so the swap is partial.
 */
export function resolveModelId(base: ModelBaseId, englishOnly: boolean): ModelId {
  if (!englishOnly) return base

  const candidate = `${base}.en` as ModelId
  return CATALOG.some((e) => e.id === candidate) ? candidate : base
}

export function entryFor(id: ModelId): ModelEntry {
  const found = CATALOG.find((e) => e.id === id)
  if (!found) throw new Error(`unknown model id: ${id}`)
  return found
}

export function baseIds(): readonly ModelBaseId[] {
  return MODEL_BASE_ORDER
}
