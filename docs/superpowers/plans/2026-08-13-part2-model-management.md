# whisper-drop Part 2 — Model Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything needed to get Whisper models onto disk and remember what the user chose — catalog, resumable checksum-verified downloads, on-disk store, and persisted settings — with no Electron dependency.

**Architecture:** Four plain-Node modules. `catalog` is pure data plus one pure function. `settings` and `store` take their directory by injection rather than importing Electron, which both honours the project's no-Electron-outside-`ipc/` rule and makes them testable against a temp dir. `download` is the delicate one: resumable, checksum-verified, atomically renamed, and tested against a local HTTP server that can be told to misbehave.

**Tech Stack:** TypeScript 5 (ESM, `NodeNext`), Vitest 4, Node 22 built-ins only (`node:fs`, `node:crypto`, `node:stream`, global `fetch`). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-part2-model-management-design.md`
(This spec doc lands in the same branch as this plan, `part-2-model-management`; it does not exist on `main` until part 2 merges.)
**Parent spec:** `docs/superpowers/specs/2026-08-13-whisper-drop-design.md` (binding authority)

## Global Constraints

- **No module under `src/main/` other than `src/main/ipc/` may import `electron`.** This plan creates nothing in `ipc/`, so nothing here imports electron. `settings` and `store` take their base directory as a constructor argument.
- **No new runtime dependencies.** Node 22 has everything: `fs.statfs` for free space, `node:crypto` for SHA-256, global `fetch` for HTTP.
- ESM throughout; relative imports carry `.js` extensions. `strict` and `noUncheckedIndexedAccess: true`.
- **Code comments succinct and terse, only where genuinely necessary.** Comments restating the code are a defect.
- **No network access in tests.** Download tests run against a local HTTP server on an ephemeral port.
- The nine `ErrorCode` values are fixed by the parent spec and already exist in `src/shared/types.ts`. This plan uses `INSUFFICIENT_DISK_SPACE`, `DOWNLOAD_CHECKSUM_MISMATCH`, `DOWNLOAD_NETWORK_ERROR`, and `MODEL_FILE_MISSING`. Do not add new codes.
- **Nothing unverified is ever renamed into place.** The `.part` → final rename happens only after the SHA-256 matches.
- Existing interfaces from Part 1 that this plan consumes: `AppError(code, message, detail?)` from `src/shared/errors.ts`; `ErrorCode` from `src/shared/types.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `src/main/models/catalog.ts` | The 8 model entries, `resolveModelId`, lookup helpers |
| `src/main/models/download.ts` | Resumable, checksum-verified HTTP download |
| `src/main/models/store.ts` | On-disk model state: path, installed, list, remove, install |
| `src/main/settings.ts` | Persisted settings incl. the measured-throughput map |
| `test/helpers/model-server.ts` | Local HTTP server that can misbehave on demand |

---

### Task 1: Catalog and `resolveModelId`

Pure data and one pure function. The hashes below are real: they were read from the HuggingFace API and the mechanism was verified by confirming HuggingFace's `lfs.oid` is byte-identical to `shasum -a 256` of a downloaded `ggml-tiny.bin`. Use them verbatim.

**Files:**
- Create: `src/main/models/catalog.ts`
- Test: `test/main/models/catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ModelBaseId`, `ModelId`, `ModelEntry`, `CATALOG`, `resolveModelId(base, englishOnly)`, `entryFor(id)`, `baseIds()`, `MODEL_BASE_ORDER`, `MODEL_URL_PREFIX`.

- [ ] **Step 1: Write the failing tests**

Create `test/main/models/catalog.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/models/catalog.test.ts`
Expected: FAIL — cannot resolve `catalog.js`.

- [ ] **Step 3: Implement `src/main/models/catalog.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/models/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/models/catalog.ts test/main/models/catalog.test.ts
git commit -m "feat: add model catalog with verified sizes and hashes"
```

---

### Task 2: Settings store

Persisted preferences, including the measured-throughput map that Part 1's `JobState.realtimeFactor` feeds. Takes its directory by injection so it needs no Electron import.

**Files:**
- Create: `src/main/settings.ts`
- Test: `test/main/settings.test.ts`

**Interfaces:**
- Consumes: `ModelBaseId`, `ModelId` from `src/main/models/catalog.ts`.
- Produces: `Settings`, `defaultSettings(locale)`, `createSettingsStore(dir)` returning `{ read, write, recordThroughput }`.

- [ ] **Step 1: Write the failing tests**

Create `test/main/settings.test.ts`:

```ts
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

  it('leaves no .tmp file behind, so writes are atomic', async () => {
    const store = createSettingsStore(dir, 'en-US')
    await store.write({ activeModel: 'base' })
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/settings.test.ts`
Expected: FAIL — cannot resolve `settings.js`.

- [ ] **Step 3: Implement `src/main/settings.ts`**

```ts
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CATALOG, MODEL_BASE_ORDER, type ModelBaseId, type ModelId } from './models/catalog.js'

const CURRENT_VERSION = 1 as const
const VALID_MODEL_IDS: ReadonlySet<string> = new Set(CATALOG.map((entry) => entry.id))

export type Settings = {
  version: typeof CURRENT_VERSION
  englishOnly: boolean
  activeModel: ModelBaseId | null
  /** ISO 639-1 code, or 'auto'. Ignored while englishOnly. */
  language: string
  throughput: Partial<Record<ModelId, { realtimeFactor: number; samples: number }>>
}

export function defaultSettings(locale: string): Settings {
  return {
    version: CURRENT_VERSION,
    englishOnly: locale.toLowerCase().startsWith('en'),
    activeModel: null,
    language: 'auto',
    throughput: {},
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceActiveModel(value: unknown): ModelBaseId | null {
  if (value === null) return null
  return typeof value === 'string' && (MODEL_BASE_ORDER as readonly string[]).includes(value)
    ? (value as ModelBaseId)
    : null
}

function isThroughputEntry(value: unknown): value is { realtimeFactor: number; samples: number } {
  return isPlainObject(value) && typeof value.realtimeFactor === 'number' && typeof value.samples === 'number'
}

function coerceThroughput(value: unknown): Settings['throughput'] {
  if (!isPlainObject(value)) return {}
  const result: Settings['throughput'] = {}
  for (const [id, entry] of Object.entries(value)) {
    if (VALID_MODEL_IDS.has(id) && isThroughputEntry(entry)) result[id as ModelId] = entry
  }
  return result
}

/**
 * Take each field from `parsed` only if it is structurally valid; an invalid
 * field falls back to the corresponding default rather than discarding the
 * whole file. Guards against a hand-edited or corrupted settings.json
 * propagating bad values (e.g. an unknown model id) into the app.
 */
function coerceSettings(parsed: Record<string, unknown>, fallback: Settings): Settings {
  return {
    version: CURRENT_VERSION,
    englishOnly: typeof parsed.englishOnly === 'boolean' ? parsed.englishOnly : fallback.englishOnly,
    activeModel: coerceActiveModel(parsed.activeModel),
    language: typeof parsed.language === 'string' ? parsed.language : fallback.language,
    throughput: coerceThroughput(parsed.throughput),
  }
}

export function createSettingsStore(dir: string, locale: string) {
  const file = join(dir, 'settings.json')
  const tmp = `${file}.tmp`
  const corrupt = join(dir, 'settings.corrupt.json')

  async function read(): Promise<Settings> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return defaultSettings(locale)
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isPlainObject(parsed) || parsed.version !== CURRENT_VERSION) {
        return defaultSettings(locale)
      }
      return coerceSettings(parsed, defaultSettings(locale))
    } catch {
      // Keep the bad file so the failure is diagnosable rather than erased.
      await rename(file, corrupt).catch(() => {})
      return defaultSettings(locale)
    }
  }

  async function write(patch: Partial<Settings>): Promise<Settings> {
    const merged = { ...(await read()), ...patch, version: CURRENT_VERSION }
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    return merged
  }

  async function recordThroughput(id: ModelId, realtimeFactor: number): Promise<Settings> {
    const current = await read()
    const previous = current.throughput[id]
    const samples = (previous?.samples ?? 0) + 1
    const mean = previous
      ? (previous.realtimeFactor * previous.samples + realtimeFactor) / samples
      : realtimeFactor

    return write({
      throughput: { ...current.throughput, [id]: { realtimeFactor: mean, samples } },
    })
  }

  return { read, write, recordThroughput }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/settings.ts test/main/settings.test.ts
git commit -m "feat: add persisted settings with throughput history"
```

---

### Task 3: Resumable, checksum-verified download

The delicate module. Read the whole task before starting.

The single most important behaviour here is **what happens when the server ignores a `Range` header**. A server that returns `200` with the full body, when we asked for `bytes=N-`, will silently produce a corrupt file if we append. It must restart instead. There is a dedicated test for it.

Two more failure modes get the same care:

- **An interrupted transfer must not be misclassified as corruption.** A server can close the connection cleanly after sending fewer bytes than the model's full size (most concretely: no `Content-Length`, chunked encoding, and the chunked terminator sent early). `pipeline` then resolves without ever throwing. If we went straight to the digest check, a short-but-otherwise-fine partial would fail its hash and get deleted as `DOWNLOAD_CHECKSUM_MISMATCH` — destroying the exact resumable partial the whole `.part` mechanism exists to keep. Byte count is checked before the digest so a short transfer is reported as `DOWNLOAD_NETWORK_ERROR` and `.part` survives; only a full-length body that still fails its hash is genuine corruption.
- **The only network requests this app makes are model downloads, and only ever to the pinned catalog URL prefix.** `downloadModel` validates `entry.url` against that full prefix — not just the hostname — before fetching anything, so a catalog entry pointed at a different repo on the same host (e.g. `huggingface.co/attacker/repo/...`) is refused just as surely as one pointed at a different host entirely. This is what makes a malicious catalog pull request ineffective, which is the whole point of the check.

**Files:**
- Create: `test/helpers/model-server.ts`
- Create: `src/main/models/download.ts`
- Test: `test/main/models/download.test.ts`

**Interfaces:**
- Consumes: `ModelEntry` from `catalog.ts`; `AppError` from `src/shared/errors.ts`.
- Produces: `DownloadProgress`, `DownloadOptions` (including the test-only `trustedUrlPrefixesForTests` seam), `downloadModel(opts)`.
- Test helper produces: `startModelServer(opts)` returning `{ url, close, requests }`.

- [ ] **Step 1: Create the misbehaving test server**

Create `test/helpers/model-server.ts`:

```ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ServerBehaviour =
  /** Normal: honour Range with 206, otherwise 200. */
  | { kind: 'normal' }
  /** Ignore Range entirely and always return the full body with 200. */
  | { kind: 'ignore-range' }
  /** Return a body that does not match the advertised sha256. */
  | { kind: 'wrong-bytes' }
  /** Write some bytes then destroy the socket. */
  | { kind: 'truncate'; afterBytes: number }
  /** Respond with an HTTP error status. */
  | { kind: 'error-status'; status: number }
  /** Honour Range like 'normal', but write the body in a handful of delayed
   * chunks so a caller can abort while a download is genuinely in flight. */
  | { kind: 'slow'; chunkDelayMs: number }
  /** Send fewer bytes than the model's full size, then end the response with
   * no `content-length` set — chunked encoding terminates cleanly even
   * though the transfer was actually interrupted upstream. */
  | { kind: 'short-body'; sendBytes: number }
  /** Answer a Range request with 206 but echo a Content-Range start that
   * doesn't match what was requested. */
  | { kind: 'bad-range' }

export type ModelServer = {
  url: string
  /** Range headers received, in order. Empty string when the header was absent. */
  requests: string[]
  close: () => Promise<void>
}

/** A local HTTP server that serves `body` and can be told to misbehave. */
export async function startModelServer(
  body: Buffer,
  behaviour: ServerBehaviour = { kind: 'normal' },
): Promise<ModelServer> {
  const requests: string[] = []

  const server: Server = createServer((req, res) => {
    requests.push(req.headers.range ?? '')

    if (behaviour.kind === 'error-status') {
      res.writeHead(behaviour.status)
      res.end('nope')
      return
    }

    if (behaviour.kind === 'short-body') {
      // No content-length: the chunked encoding still terminates cleanly,
      // even though far fewer bytes than the model's real size were sent.
      res.writeHead(200)
      res.end(body.subarray(0, behaviour.sendBytes))
      return
    }

    const payload = behaviour.kind === 'wrong-bytes'
      ? Buffer.alloc(body.length, 0x00)
      : body

    if (behaviour.kind === 'truncate') {
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.write(payload.subarray(0, behaviour.afterBytes))
      // A same-tick destroy() can kill the socket before the client even
      // finishes reading the response headers, which surfaces as a fetch()
      // failure rather than a body-stream failure — the wrong branch for a
      // test about a connection dropping mid-transfer. The delay lets the
      // headers and first bytes land before the reset.
      setTimeout(() => res.destroy(), 20)
      return
    }

    if (behaviour.kind === 'bad-range') {
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
      const slice = payload.subarray(start)
      res.writeHead(206, {
        'content-length': String(slice.length),
        // Off by one from the offset actually requested/served.
        'content-range': `bytes ${start + 1}-${payload.length - 1}/${payload.length}`,
      })
      res.end(slice)
      return
    }

    if (behaviour.kind === 'slow') {
      res.on('error', () => {})
      const range = req.headers.range
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
      const slice = payload.subarray(start)
      const headers: Record<string, string> = { 'content-length': String(slice.length) }
      if (range) headers['content-range'] = `bytes ${start}-${payload.length - 1}/${payload.length}`
      res.writeHead(range ? 206 : 200, headers)

      const chunkSize = Math.max(1, Math.ceil(slice.length / 4))
      let offset = 0
      const writeNext = (): void => {
        if (res.destroyed || res.writableEnded) return
        if (offset >= slice.length) {
          res.end()
          return
        }
        res.write(slice.subarray(offset, offset + chunkSize))
        offset += chunkSize
        setTimeout(writeNext, behaviour.chunkDelayMs)
      }
      writeNext()
      return
    }

    const range = behaviour.kind === 'ignore-range' ? undefined : req.headers.range
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      const slice = payload.subarray(start)
      res.writeHead(206, {
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
      })
      res.end(slice)
      return
    }

    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/model.bin`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/main/models/download.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadModel } from '../../../src/main/models/download.js'
import type { ModelEntry } from '../../../src/main/models/catalog.js'
import { startModelServer, type ModelServer } from '../../helpers/model-server.js'

const BODY = Buffer.from('whisper-drop test model payload, long enough to slice up')
const SHA = createHash('sha256').update(BODY).digest('hex')

let dir: string
let server: ModelServer | undefined

function entryFor(url: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'tiny',
    base: 'tiny',
    label: 'Tiny',
    bytes: BODY.length,
    sha256: SHA,
    url,
    blurb: 'test',
    englishOnly: false,
    ...overrides,
  }
}

// downloadModel's default trust boundary only allows the pinned HuggingFace
// URL prefix; every test that actually needs to talk to the local test
// server opts in explicitly via trustedUrlPrefixesForTests, scoped to that
// server's own URL, rather than relying on the real default.
function download(opts: Parameters<typeof downloadModel>[0]) {
  return downloadModel({ trustedUrlPrefixesForTests: [opts.entry.url], ...opts })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wd-download-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('downloadModel', () => {
  it('downloads a file whose hash matches', async () => {
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')

    await download({ entry: entryFor(server.url), destPath: dest })

    expect(await readFile(dest)).toEqual(BODY)
  })

  it('leaves no .part file behind on success', async () => {
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')

    await download({ entry: entryFor(server.url), destPath: dest })

    await expect(stat(`${dest}.part`)).rejects.toThrow()
  })

  it('reports progress that ends at the full size', async () => {
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')
    const onProgress = vi.fn()

    await download({ entry: entryFor(server.url), destPath: dest, onProgress })

    expect(onProgress).toHaveBeenCalled()
    const last = onProgress.mock.calls.at(-1)?.[0]
    expect(last.receivedBytes).toBe(BODY.length)
    expect(last.totalBytes).toBe(BODY.length)
  })

  it('resumes from an existing partial file', async () => {
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')
    await writeFile(`${dest}.part`, BODY.subarray(0, 10))

    await download({ entry: entryFor(server.url), destPath: dest })

    expect(await readFile(dest)).toEqual(BODY)
    expect(server.requests.at(-1)).toBe('bytes=10-')
  })

  it('restarts instead of appending when the server ignores the Range header', async () => {
    server = await startModelServer(BODY, { kind: 'ignore-range' })
    const dest = join(dir, 'model.bin')
    await writeFile(`${dest}.part`, BODY.subarray(0, 10))

    await download({ entry: entryFor(server.url), destPath: dest })

    // Appending a full body to a 10-byte partial would give a longer, corrupt file.
    expect(await readFile(dest)).toEqual(BODY)
  })

  it('discards a partial larger than the expected size', async () => {
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')
    await writeFile(`${dest}.part`, Buffer.concat([BODY, BODY]))

    await download({ entry: entryFor(server.url), destPath: dest })

    expect(await readFile(dest)).toEqual(BODY)
  })

  it('promotes an already-complete, correctly-hashed .part file with zero HTTP requests', async () => {
    // Simulates every byte having landed before a crash on the last run,
    // before the final rename happened. Resuming with Range: bytes=<size>-
    // against a real server would 416 here, so this must short-circuit
    // before any fetch at all — the request list is the only proof of that.
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')
    await writeFile(`${dest}.part`, BODY)

    await download({ entry: entryFor(server.url), destPath: dest })

    expect(await readFile(dest)).toEqual(BODY)
    expect(server.requests).toEqual([])
  })

  it('discards an already-complete but corrupt .part file and re-downloads to a correct result', async () => {
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')
    await writeFile(`${dest}.part`, Buffer.alloc(BODY.length, 0xff))

    await download({ entry: entryFor(server.url), destPath: dest })

    expect(await readFile(dest)).toEqual(BODY)
    // One plain GET with no Range header: proof it restarted from zero
    // rather than trying to resume a file it just decided was untrustworthy.
    expect(server.requests).toEqual([''])
  })

  it('restarts from zero when the server echoes a Content-Range start that does not match the request', async () => {
    server = await startModelServer(BODY, { kind: 'bad-range' })
    const dest = join(dir, 'model.bin')
    await writeFile(`${dest}.part`, BODY.subarray(0, 10))

    // The response can't be trusted, so this attempt fails rather than
    // risking bytes spliced in at the wrong offset...
    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

    // ...but the partial is discarded, so the next attempt starts clean and succeeds.
    await expect(stat(`${dest}.part`)).rejects.toThrow()
    await download({ entry: entryFor(server.url), destPath: dest })
    expect(await readFile(dest)).toEqual(BODY)
  })

  it('throws DOWNLOAD_CHECKSUM_MISMATCH when the bytes are wrong', async () => {
    server = await startModelServer(BODY, { kind: 'wrong-bytes' })
    const dest = join(dir, 'model.bin')

    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_CHECKSUM_MISMATCH' })
  })

  it('deletes the .part file after a checksum mismatch, so a retry starts clean', async () => {
    server = await startModelServer(BODY, { kind: 'wrong-bytes' })
    const dest = join(dir, 'model.bin')

    await download({ entry: entryFor(server.url), destPath: dest }).catch(() => {})

    await expect(stat(`${dest}.part`)).rejects.toThrow()
  })

  it('never renames an unverified file into place', async () => {
    server = await startModelServer(BODY, { kind: 'wrong-bytes' })
    const dest = join(dir, 'model.bin')

    await download({ entry: entryFor(server.url), destPath: dest }).catch(() => {})

    await expect(stat(dest)).rejects.toThrow()
  })

  it('throws DOWNLOAD_NETWORK_ERROR, not DOWNLOAD_CHECKSUM_MISMATCH, when a clean response is short', async () => {
    // No content-length; the server ends the chunked response cleanly after
    // only 10 bytes. pipeline() resolves without throwing, so this only stays
    // out of the checksum-mismatch path because byte count is checked first.
    server = await startModelServer(BODY, { kind: 'short-body', sendBytes: 10 })
    const dest = join(dir, 'model.bin')

    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })
  })

  it('keeps .part after a clean short response, since it is resumable', async () => {
    server = await startModelServer(BODY, { kind: 'short-body', sendBytes: 10 })
    const dest = join(dir, 'model.bin')

    await download({ entry: entryFor(server.url), destPath: dest }).catch(() => {})

    expect((await stat(`${dest}.part`)).size).toBeGreaterThan(0)
  })

  it('throws DOWNLOAD_NETWORK_ERROR on an HTTP error status', async () => {
    server = await startModelServer(BODY, { kind: 'error-status', status: 503 })
    const dest = join(dir, 'model.bin')

    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })
  })

  it('refuses before fetching when there is not enough free space', async () => {
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')

    await expect(
      download({
        entry: entryFor(server.url),
        destPath: dest,
        freeBytesImpl: async () => 1,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_DISK_SPACE' })

    expect(server.requests).toEqual([])
  })

  it('rejects immediately when the signal is already aborted', async () => {
    server = await startModelServer(BODY)
    const controller = new AbortController()
    controller.abort()

    await expect(
      download({
        entry: entryFor(server.url),
        destPath: join(dir, 'model.bin'),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i)

    expect(server.requests).toEqual([])
  })

  it('keeps the .part file when the connection drops, so a later attempt resumes', async () => {
    server = await startModelServer(BODY, { kind: 'truncate', afterBytes: 12 })
    const dest = join(dir, 'model.bin')

    await download({ entry: entryFor(server.url), destPath: dest }).catch(() => {})

    expect((await stat(`${dest}.part`)).size).toBeGreaterThan(0)
  })

  describe('aborting mid-stream', () => {
    // The only cancellation test above aborts before any fetch happens at
    // all — it never exercises cancellation of a download actually in
    // flight. Part 1 made exactly this mistake once already. 'slow' writes
    // the body in delayed chunks so these tests can abort mid-transfer for real.

    // Aborting on the very first progress event races the write of that
    // first chunk to disk; waiting for a second one gives the write time to
    // land, so `.part` reliably has real bytes in it when we check.
    function abortOnSecondProgress(controller: AbortController): () => void {
      let count = 0
      return () => {
        count += 1
        if (count === 2) controller.abort()
      }
    }

    it('rejects with a plain Error distinguishable from a network failure', async () => {
      server = await startModelServer(BODY, { kind: 'slow', chunkDelayMs: 25 })
      const dest = join(dir, 'model.bin')
      const controller = new AbortController()

      const promise = download({
        entry: entryFor(server.url),
        destPath: dest,
        signal: controller.signal,
        onProgress: abortOnSecondProgress(controller),
      })

      let error: unknown
      try {
        await promise
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/abort/i)
      // AppError always carries a `code`; cancellation must not look like one.
      expect((error as { code?: unknown }).code).toBeUndefined()
    })

    it('leaves a non-empty .part file behind', async () => {
      server = await startModelServer(BODY, { kind: 'slow', chunkDelayMs: 25 })
      const dest = join(dir, 'model.bin')
      const controller = new AbortController()

      await download({
        entry: entryFor(server.url),
        destPath: dest,
        signal: controller.signal,
        onProgress: abortOnSecondProgress(controller),
      }).catch(() => {})

      const size = (await stat(`${dest}.part`)).size
      expect(size).toBeGreaterThan(0)
      expect(size).toBeLessThan(BODY.length)
    })

    it('resumes and completes successfully on a later attempt', async () => {
      server = await startModelServer(BODY, { kind: 'slow', chunkDelayMs: 25 })
      const dest = join(dir, 'model.bin')
      const controller = new AbortController()

      await download({
        entry: entryFor(server.url),
        destPath: dest,
        signal: controller.signal,
        onProgress: abortOnSecondProgress(controller),
      }).catch(() => {})

      await download({ entry: entryFor(server.url), destPath: dest })

      expect(await readFile(dest)).toEqual(BODY)
      expect(server.requests.at(-1)).toMatch(/^bytes=\d+-$/)
    })
  })

  describe('the download URL trust boundary', () => {
    // entry.url is the app's only network request, and the catalog is the
    // only place it comes from — but in a public repo, a catalog entry
    // pointed somewhere else, or even at a different path on the trusted
    // host, is a plausible malicious pull request. These checks must fire
    // before any fetch happens.

    it('rejects a plain http URL before any fetch', async () => {
      const fetchImpl = vi.fn()

      await expect(
        downloadModel({
          entry: entryFor('http://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'),
          destPath: join(dir, 'model.bin'),
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('rejects a URL on a host other than huggingface.co before any fetch', async () => {
      const fetchImpl = vi.fn()

      await expect(
        downloadModel({
          entry: entryFor('https://evil.example.com/ggml-tiny.bin'),
          destPath: join(dir, 'model.bin'),
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('rejects a URL on the trusted host but a different repo path, which hostname-only checking would miss', async () => {
      const fetchImpl = vi.fn()

      await expect(
        downloadModel({
          entry: entryFor('https://huggingface.co/attacker/repo/resolve/main/ggml-tiny.bin'),
          destPath: join(dir, 'model.bin'),
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('defaults to trusting only the pinned HuggingFace URL prefix, so the test seam cannot silently widen it', async () => {
      server = await startModelServer(BODY)
      const dest = join(dir, 'model.bin')

      // No trustedUrlPrefixesForTests override: exercises the real default
      // against the local server's non-HuggingFace URL.
      await expect(
        downloadModel({ entry: entryFor(server.url), destPath: dest }),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

      expect(server.requests).toEqual([])
    })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/main/models/download.test.ts`
Expected: FAIL — cannot resolve `download.js`.

- [ ] **Step 4: Implement `src/main/models/download.ts`**

```ts
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../../shared/errors.js'
import { MODEL_URL_PREFIX, type ModelEntry } from './catalog.js'

/** Refuse a download that would leave the disk this close to full. */
const HEADROOM_BYTES = 64 * 1024 * 1024

/**
 * Trust boundary: the app's only network requests are model downloads, and
 * those only ever go to the pinned HuggingFace catalog prefix — not just the
 * host, since a catalog entry pointed at a different repo on the same host
 * would pass a hostname-only check while still serving arbitrary bytes. A
 * catalog entry pointing anywhere else — plausible as a malicious pull
 * request in a public repo — is refused before a single byte is fetched.
 */
const DEFAULT_TRUSTED_PREFIXES: readonly string[] = [MODEL_URL_PREFIX]

export type DownloadProgress = {
  id: ModelEntry['id']
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
}

export type DownloadOptions = {
  entry: ModelEntry
  destPath: string
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  freeBytesImpl?: (dir: string) => Promise<number>
  now?: () => number
  /**
   * Test seam only: additional URL prefixes trusted as a download source,
   * checked in place of the default pinned HuggingFace prefix. Production
   * callers must never set this — `createModelStore`'s `install` builds its
   * own `DownloadOptions` and does not forward it, so IPC cannot reach it
   * even by accident. Exists so tests can point at a local server.
   */
  trustedUrlPrefixesForTests?: string[]
}

async function freeBytesOn(dir: string): Promise<number> {
  const fs = await statfs(dir)
  return fs.bavail * fs.bsize
}

/** Size of an existing partial, or 0 when there isn't one. */
async function partialSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * The URL must start with one of the trusted prefixes in full — not just
 * share a hostname — so `https://huggingface.co/attacker/repo/resolve/main/…`
 * is refused exactly like a URL on a different host entirely. Hostname-only
 * checking would let a malicious catalog entry pass this check while still
 * serving arbitrary bytes, which defeats the entire purpose of having it.
 */
function assertTrustedSource(url: string, trustedPrefixes: readonly string[]): void {
  if (trustedPrefixes.some((prefix) => url.startsWith(prefix))) return
  throw new AppError(
    'DOWNLOAD_NETWORK_ERROR',
    'Refused to download from an untrusted source.',
    `url=${url} trustedPrefixes=${trustedPrefixes.join(', ')}`,
  )
}

export async function downloadModel(options: DownloadOptions): Promise<void> {
  const {
    entry,
    destPath,
    onProgress,
    signal,
    fetchImpl = fetch,
    freeBytesImpl = freeBytesOn,
    now = Date.now,
    trustedUrlPrefixesForTests,
  } = options

  if (signal?.aborted) throw new Error('downloadModel: aborted before starting')
  assertTrustedSource(entry.url, trustedUrlPrefixesForTests ?? DEFAULT_TRUSTED_PREFIXES)

  const partPath = `${destPath}.part`

  let resumeFrom = await partialSize(partPath)
  if (resumeFrom > entry.bytes) {
    await rm(partPath, { force: true })
    resumeFrom = 0
  }

  // Every byte may already have landed on a previous run that crashed before
  // the final rename. Resuming that with Range: bytes=<size>- would ask a
  // real server for zero remaining bytes, which commonly comes back as 416
  // or an empty body — so this is handled explicitly, before any fetch.
  if (resumeFrom > 0 && resumeFrom === entry.bytes) {
    const existingHash = createHash('sha256')
    await pipeline(createReadStream(partPath), async function* (source) {
      for await (const chunk of source) existingHash.update(chunk as Buffer)
    })
    if (existingHash.digest('hex') === entry.sha256) {
      await rename(partPath, destPath)
      return
    }
    // Complete but corrupt: not resumable, so start over from zero.
    await rm(partPath, { force: true })
    resumeFrom = 0
  }

  const free = await freeBytesImpl(dirname(destPath))
  if (free < entry.bytes - resumeFrom + HEADROOM_BYTES) {
    throw new AppError(
      'INSUFFICIENT_DISK_SPACE',
      `Not enough free space. ${entry.label} needs about ${Math.ceil(entry.bytes / 1e9)} GB.`,
      `free=${free} required=${entry.bytes - resumeFrom + HEADROOM_BYTES}`,
    )
  }

  let response: Response
  try {
    response = await fetchImpl(entry.url, {
      headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {},
      signal,
    })
  } catch (cause) {
    if (signal?.aborted) throw new Error('downloadModel: aborted')
    throw new AppError(
      'DOWNLOAD_NETWORK_ERROR',
      "Couldn't reach the model server.",
      String(cause),
    )
  }

  if (!response.ok || !response.body) {
    throw new AppError(
      'DOWNLOAD_NETWORK_ERROR',
      "Couldn't reach the model server.",
      `HTTP ${response.status}`,
    )
  }

  // A 200 to a ranged request means the server ignored the header and is
  // sending the whole body. Appending it to the partial would silently produce
  // a corrupt file of the wrong length, so start over instead.
  let append = resumeFrom > 0 && response.status === 206
  if (resumeFrom > 0 && !append) {
    await rm(partPath, { force: true })
    resumeFrom = 0
  }

  if (append) {
    const contentRange = response.headers.get('content-range')
    const start = contentRange ? Number(/bytes (\d+)-/.exec(contentRange)?.[1]) : undefined
    if (contentRange && start !== resumeFrom) {
      // The header doesn't match what we asked for, so we can't trust which
      // bytes this response actually holds. Discard the partial rather than
      // risk splicing bytes in at the wrong position — the next attempt
      // starts clean.
      await rm(partPath, { force: true })
      throw new AppError(
        'DOWNLOAD_NETWORK_ERROR',
        'The model server returned an unexpected byte range.',
        `requested ${resumeFrom}, got ${contentRange}`,
      )
    }
  }

  const hash = createHash('sha256')
  if (append) {
    await pipeline(createReadStream(partPath), async function* (source) {
      for await (const chunk of source) hash.update(chunk as Buffer)
    })
  }

  let received = resumeFrom
  const startedAt = now()

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length

      const elapsed = Math.max(1, now() - startedAt)
      onProgress?.({
        id: entry.id,
        receivedBytes: received,
        totalBytes: entry.bytes,
        bytesPerSecond: ((received - resumeFrom) / elapsed) * 1000,
      })

      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(partPath, { flags: append ? 'a' : 'w' }),
    )
  } catch (cause) {
    if (signal?.aborted) throw new Error('downloadModel: aborted')
    // Keep the .part file: a later attempt resumes from it.
    throw new AppError(
      'DOWNLOAD_NETWORK_ERROR',
      'The download was interrupted.',
      String(cause),
    )
  }

  // A clean end short of the expected length is an interrupted transfer, not
  // corruption — keep the partial so a later attempt can resume it. Only a
  // full-length body that still fails the digest is genuine corruption, which
  // is why byte count is checked before the digest, not after.
  if (received < entry.bytes) {
    throw new AppError(
      'DOWNLOAD_NETWORK_ERROR',
      'The download was interrupted.',
      `received ${received} of ${entry.bytes} bytes`,
    )
  }

  if (hash.digest('hex') !== entry.sha256) {
    await rm(partPath, { force: true })
    throw new AppError(
      'DOWNLOAD_CHECKSUM_MISMATCH',
      'The download was corrupted.',
      `expected ${entry.sha256}`,
    )
  }

  await rename(partPath, destPath)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/main/models/download.test.ts`
Expected: PASS. The destroyed socket in the truncation test may surface either as a `pipeline` error (caught directly) or as a clean-but-short stream that fails the byte-count check — both land on `DOWNLOAD_NETWORK_ERROR` with `.part` intact, never on a checksum mismatch, since byte count is checked before the digest. The test asserts only that `.part` survives, which holds either way.

- [ ] **Step 6: Commit**

```bash
git add src/main/models/download.ts test/main/models/download.test.ts test/helpers/model-server.ts
git commit -m "feat: add resumable checksum-verified model download"
```

---

### Task 4: Model store

The thin layer over the models directory that the rest of the app talks to.

**Files:**
- Create: `src/main/models/store.ts`
- Test: `test/main/models/store.test.ts`

**Interfaces:**
- Consumes: `catalog.ts`, `download.ts`, `AppError`.
- Produces: `createModelStore(dir)` returning `{ modelsDir, pathFor, isInstalled, verify, listInstalled, remove, install }`; `InstallOptions.force`.

`isInstalled` stays a cheap size-only check — the plan does not change that trade-off. `verify` is the full-hash repair path: it exists for a user who hits an opaque whisper failure and wants to rule out a corrupt model, and is never called automatically (re-hashing up to 3.1 GB on every launch is not acceptable). `InstallOptions.force` lets a bad model be re-downloaded without hunting for the file on disk.

- [ ] **Step 1: Write the failing tests**

Create `test/main/models/store.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModelStore } from '../../../src/main/models/store.js'
import { entryFor, type ModelEntry, type ModelId } from '../../../src/main/models/catalog.js'

/** A small, real-hashable stand-in for a catalog entry, so verify() tests
 * don't need an actual multi-hundred-megabyte model file. */
function fakeEntry(id: ModelId, bytes: number, sha256: string): ModelEntry {
  return { id, base: 'tiny', label: 'Test', bytes, sha256, url: 'http://example.test/model.bin', blurb: 'test', englishOnly: false }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wd-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createModelStore', () => {
  it('puts models in a models subdirectory named by id', () => {
    const store = createModelStore(dir)
    expect(store.pathFor('base.en')).toBe(join(dir, 'models', 'base.en.bin'))
  })

  it('reports a missing model as not installed', async () => {
    expect(await createModelStore(dir).isInstalled('tiny')).toBe(false)
  })

  it('reports a correctly sized model as installed', async () => {
    const store = createModelStore(dir)
    await mkdir(join(dir, 'models'), { recursive: true })
    await writeFile(store.pathFor('tiny'), Buffer.alloc(entryFor('tiny').bytes))

    expect(await store.isInstalled('tiny')).toBe(true)
  })

  it('reports a truncated model as NOT installed, catching a half-written file', async () => {
    const store = createModelStore(dir)
    await mkdir(join(dir, 'models'), { recursive: true })
    await writeFile(store.pathFor('tiny'), Buffer.alloc(1024))

    expect(await store.isInstalled('tiny')).toBe(false)
  })

  it('lists only correctly sized installed models', async () => {
    const store = createModelStore(dir)
    await mkdir(join(dir, 'models'), { recursive: true })
    await writeFile(store.pathFor('tiny'), Buffer.alloc(entryFor('tiny').bytes))
    await writeFile(store.pathFor('base'), Buffer.alloc(99))

    expect(await store.listInstalled()).toEqual(['tiny'])
  })

  it('returns an empty list when the models directory does not exist yet', async () => {
    expect(await createModelStore(dir).listInstalled()).toEqual([])
  })

  it('removes an installed model', async () => {
    const store = createModelStore(dir)
    await mkdir(join(dir, 'models'), { recursive: true })
    await writeFile(store.pathFor('tiny'), Buffer.alloc(entryFor('tiny').bytes))

    await store.remove('tiny')

    expect(await store.isInstalled('tiny')).toBe(false)
  })

  it('succeeds when removing a model that is not there', async () => {
    await expect(createModelStore(dir).remove('large-v3')).resolves.toBeUndefined()
  })

  it('removes both the final file and a leftover .part, so cancelling then removing reclaims the space', async () => {
    const store = createModelStore(dir)
    await mkdir(join(dir, 'models'), { recursive: true })
    await writeFile(store.pathFor('tiny'), Buffer.alloc(entryFor('tiny').bytes))
    await writeFile(`${store.pathFor('tiny')}.part`, Buffer.alloc(10))

    await store.remove('tiny')

    await expect(stat(store.pathFor('tiny'))).rejects.toThrow()
    await expect(stat(`${store.pathFor('tiny')}.part`)).rejects.toThrow()
  })

  it('never forwards a test-only trust seam to the downloader, since it builds DownloadOptions itself', async () => {
    const download = vi.fn(async (_options: unknown) => {})
    const store = createModelStore(dir, download)

    await store.install('tiny')

    const options = download.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(options).sort()).toEqual(['destPath', 'entry', 'onProgress', 'signal'])
  })

  it('creates the models directory and delegates to the downloader on install', async () => {
    const download = vi.fn(async (_options: unknown) => {})
    const store = createModelStore(dir, download)

    await store.install('tiny')

    expect(download).toHaveBeenCalledTimes(1)
    const options = download.mock.calls[0]![0] as { entry: { id: string }; destPath: string }
    expect(options.entry.id).toBe('tiny')
    expect(options.destPath).toBe(store.pathFor('tiny'))
  })

  it('passes progress and abort through to the downloader', async () => {
    const download = vi.fn(async (_options: unknown) => {})
    const store = createModelStore(dir, download)
    const controller = new AbortController()
    const onProgress = vi.fn()

    await store.install('tiny', { onProgress, signal: controller.signal })

    const options = download.mock.calls[0]![0] as Record<string, unknown>
    expect(options.onProgress).toBe(onProgress)
    expect(options.signal).toBe(controller.signal)
  })

  it('skips the download when the model is already installed', async () => {
    const download = vi.fn(async () => {})
    const store = createModelStore(dir, download)
    await mkdir(join(dir, 'models'), { recursive: true })
    await writeFile(store.pathFor('tiny'), Buffer.alloc(entryFor('tiny').bytes))

    await store.install('tiny')

    expect(download).not.toHaveBeenCalled()
  })

  it('re-downloads with force even when already installed', async () => {
    const download = vi.fn(async () => {})
    const store = createModelStore(dir, download)
    await mkdir(join(dir, 'models'), { recursive: true })
    await writeFile(store.pathFor('tiny'), Buffer.alloc(entryFor('tiny').bytes))

    await store.install('tiny', { force: true })

    expect(download).toHaveBeenCalledTimes(1)
  })

  describe('verify', () => {
    it('returns true for a file whose contents actually hash correctly', async () => {
      const content = Buffer.from('deterministic test content for hashing')
      const sha256 = createHash('sha256').update(content).digest('hex')
      const store = createModelStore(dir, vi.fn(), () => fakeEntry('tiny', content.length, sha256))
      await mkdir(join(dir, 'models'), { recursive: true })
      await writeFile(store.pathFor('tiny'), content)

      expect(await store.verify('tiny')).toBe(true)
    })

    it('returns false for a same-size file with wrong contents, which isInstalled cannot catch', async () => {
      const content = Buffer.from('deterministic test content for hashing')
      const sha256 = createHash('sha256').update(content).digest('hex')
      const store = createModelStore(dir, vi.fn(), () => fakeEntry('tiny', content.length, sha256))
      await mkdir(join(dir, 'models'), { recursive: true })
      await writeFile(store.pathFor('tiny'), Buffer.alloc(content.length, 0x00))

      expect(await store.isInstalled('tiny')).toBe(true)
      expect(await store.verify('tiny')).toBe(false)
    })

    it('returns false for a missing file', async () => {
      const store = createModelStore(dir, vi.fn(), () => fakeEntry('tiny', 10, 'a'.repeat(64)))

      expect(await store.verify('tiny')).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/models/store.test.ts`
Expected: FAIL — cannot resolve `store.js`.

- [ ] **Step 3: Implement `src/main/models/store.ts`**

```ts
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { CATALOG, entryFor, type ModelEntry, type ModelId } from './catalog.js'
import { downloadModel, type DownloadOptions, type DownloadProgress } from './download.js'

export type InstallOptions = {
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
  /** Re-download even if the model already looks installed. */
  force?: boolean
}

type Downloader = (options: DownloadOptions) => Promise<void>

/**
 * On-disk model state. `isInstalled` is a cheap size-only check — fast enough
 * to run on every launch, but a same-size file with corrupted contents still
 * reads as installed. `verify` is the authoritative check: a full streaming
 * SHA-256 against the catalog. It is not called on startup; it exists so a
 * user hitting an opaque whisper failure can re-check a model, and `force`
 * lets a bad one be re-downloaded without hunting for the file on disk.
 */
export function createModelStore(
  dir: string,
  download: Downloader = downloadModel,
  lookup: (id: ModelId) => ModelEntry = entryFor,
) {
  const modelsDir = join(dir, 'models')

  function pathFor(id: ModelId): string {
    return join(modelsDir, `${id}.bin`)
  }

  async function isInstalled(id: ModelId): Promise<boolean> {
    try {
      return (await stat(pathFor(id))).size === lookup(id).bytes
    } catch {
      return false
    }
  }

  async function verify(id: ModelId): Promise<boolean> {
    const hash = createHash('sha256')
    try {
      await pipeline(createReadStream(pathFor(id)), async function* (source) {
        for await (const chunk of source) hash.update(chunk as Buffer)
      })
    } catch {
      return false
    }
    return hash.digest('hex') === lookup(id).sha256
  }

  async function listInstalled(): Promise<ModelId[]> {
    let names: string[]
    try {
      names = await readdir(modelsDir)
    } catch {
      return []
    }

    const present = CATALOG.filter((entry) => names.includes(`${entry.id}.bin`))
    const checked = await Promise.all(
      present.map(async (entry) => ((await isInstalled(entry.id)) ? entry.id : null)),
    )

    return checked.filter((id): id is ModelId => id !== null)
  }

  /** Deletes the model file and any leftover `.part`, so cancelling a
   * download and then removing it actually reclaims the space. */
  async function remove(id: ModelId): Promise<void> {
    await rm(pathFor(id), { force: true })
    await rm(`${pathFor(id)}.part`, { force: true })
  }

  async function install(id: ModelId, options: InstallOptions = {}): Promise<void> {
    if (!options.force && (await isInstalled(id))) return

    await mkdir(modelsDir, { recursive: true })
    await download({
      entry: lookup(id),
      destPath: pathFor(id),
      onProgress: options.onProgress,
      signal: options.signal,
    })
  }

  return { modelsDir, pathFor, isInstalled, verify, listInstalled, remove, install }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/main/models/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/models/store.ts test/main/models/store.test.ts
git commit -m "feat: add on-disk model store"
```

---

## Done when

- `npm test` passes with no network access.
- `npm run typecheck` is clean.
- No module under `src/main/` imports `electron`. Verify with:
  ```
  grep -rn "from 'electron'" src/main --include='*.ts' | grep -v '^src/main/ipc/' || echo "clean"
  ```
- A download interrupted mid-flight resumes; one that returns wrong bytes is rejected and cleaned up; one whose server ignores `Range` restarts rather than corrupting.
- A clean-but-short transfer (server closes without sending the full declared size) is reported as `DOWNLOAD_NETWORK_ERROR` with `.part` kept, never as `DOWNLOAD_CHECKSUM_MISMATCH` — an interrupted download must stay resumable, not get treated as corrupt.
- Aborting a download genuinely in flight (not just before the first byte) rejects with a plain `Error` whose message contains "aborted", distinguishable from `AppError('DOWNLOAD_NETWORK_ERROR')`, and a later attempt resumes from the surviving `.part` to a correct file.
- `downloadModel` refuses any `entry.url` that doesn't start with the pinned `MODEL_URL_PREFIX` before fetching anything — a same-host, different-path URL included, not just a different host — and the default `trustedUrlPrefixesForTests` is unset, so only that pinned prefix is ever trusted in production.
- A `.part` file already equal to the catalog's `bytes` is hashed and promoted with zero HTTP requests when it matches, and discarded and re-downloaded from zero when it doesn't.
- `remove(id)` deletes both the final file and any leftover `.part`, so cancelling a download and removing it actually reclaims the space.
- `store.verify` gives a full-hash answer `isInstalled`'s size check cannot, and `install({ force: true })` re-downloads a model that already looks installed.
- Corrupt settings do not prevent startup, and malformed fields in an otherwise-valid `settings.json` (e.g. an unknown `activeModel`) fall back to defaults field-by-field rather than propagating bad values or discarding the whole file.

## What Part 3 picks up

The Electron main process, preload and IPC surface, and the React UI — including the model picker that composes `baseIds()`, `resolveModelId`, `isInstalled`, and the recorded `realtimeFactor` into one row per picker entry.
