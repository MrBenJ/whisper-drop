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
  return isPlainObject(value) && Number.isFinite(value.realtimeFactor) && Number.isFinite(value.samples)
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
    const current = await read()
    // Coerce the merged result through the same validation as read(), so a
    // bad value crossing the IPC boundary (e.g. via an `as` cast) can't reach
    // disk — and the caller back — unvalidated.
    const merged = coerceSettings({ ...current, ...patch, version: CURRENT_VERSION }, current)
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
