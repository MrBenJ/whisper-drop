import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Settings } from '../shared/types.js'
import { CATALOG, MODEL_BASE_ORDER, type ModelBaseId, type ModelId } from './models/catalog.js'

const CURRENT_VERSION = 1 as const
const VALID_MODEL_IDS: ReadonlySet<string> = new Set(CATALOG.map((entry) => entry.id))

export type { Settings }

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
  const corrupt = join(dir, 'settings.corrupt.json')
  const tmpPrefix = basename(file)

  // A read-modify-write chain: `write` and `recordThroughput` both enqueue
  // onto this so a settings toggle from IPC racing recordThroughput at job
  // completion — an ordinary interleaving part 3 introduces — applies in
  // order instead of both reading the same stale snapshot and one clobbering
  // the other's update.
  let chain: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task)
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function read(): Promise<Settings> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return defaultSettings(locale)
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isPlainObject(parsed)) {
        return defaultSettings(locale)
      }
      if (parsed.version !== CURRENT_VERSION) {
        // Structurally valid JSON, but a version this build doesn't know how
        // to read — e.g. a newer build wrote it and the user downgraded.
        // Preserved the same way a malformed file is, so the next write
        // doesn't silently destroy preferences this build just can't parse.
        await rename(file, corrupt).catch(() => {})
        return defaultSettings(locale)
      }
      return coerceSettings(parsed, defaultSettings(locale))
    } catch {
      // Keep the bad file so the failure is diagnosable rather than erased.
      await rename(file, corrupt).catch(() => {})
      return defaultSettings(locale)
    }
  }

  /** Removes any orphaned `settings.json.<id>.tmp` sibling — left behind by a
   * write that crashed between writeFile and rename, or by a stale file from
   * before this store existed. Each write gets its own temp filename (rather
   * than one fixed path reused by every write) so two writes can never
   * truncate and rename the same temp file into place; this is what keeps
   * that from accumulating garbage forever. */
  async function sweepStaleTmpFiles(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith(tmpPrefix) && name.endsWith('.tmp'))
        .map((name) => rm(join(dir, name), { force: true }).catch(() => {})),
    )
  }

  async function writeNow(patch: Partial<Settings>): Promise<Settings> {
    const current = await read()
    // Coerce the merged result through the same validation as read(), so a
    // bad value crossing the IPC boundary (e.g. via an `as` cast) can't reach
    // disk — and the caller back — unvalidated.
    const merged = coerceSettings({ ...current, ...patch, version: CURRENT_VERSION }, current)
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    await sweepStaleTmpFiles()
    return merged
  }

  function write(patch: Partial<Settings>): Promise<Settings> {
    return enqueue(() => writeNow(patch))
  }

  function recordThroughput(id: ModelId, realtimeFactor: number): Promise<Settings> {
    // The read that computes the running mean is enqueued along with the
    // write it feeds, not done ahead of time — otherwise two concurrent
    // recordThroughput calls (or one racing a plain write) could both read
    // the same pre-write throughput map and each's write would clobber the
    // other's entry when it replaced the whole map.
    return enqueue(async () => {
      const current = await read()
      const previous = current.throughput[id]
      const samples = (previous?.samples ?? 0) + 1
      const mean = previous
        ? (previous.realtimeFactor * previous.samples + realtimeFactor) / samples
        : realtimeFactor

      return writeNow({
        throughput: { ...current.throughput, [id]: { realtimeFactor: mean, samples } },
      })
    })
  }

  return { read, write, recordThroughput }
}
