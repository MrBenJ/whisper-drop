import type { ModelRow } from '../../shared/ipc.js'
import type { DownloadProgress, ModelBaseId, ModelId, Settings } from '../../shared/types.js'
import { MODEL_BASE_ORDER, entryFor, resolveModelId } from '../models/catalog.js'
import { requireModelBaseId } from './validate.js'

export type ModelsDeps = {
  readSettings: () => Promise<Settings>
  isInstalled: (id: ModelId) => Promise<boolean>
  install: (
    id: ModelId,
    options: { onProgress: (progress: DownloadProgress) => void; signal: AbortSignal },
  ) => Promise<void>
  remove: (id: ModelId) => Promise<void>
  emitProgress: (progress: DownloadProgress) => void
}

export type ModelHandlers = {
  list(): Promise<ModelRow[]>
  download(base: unknown): Promise<void>
  cancelDownload(base: unknown): Promise<void>
  remove(base: unknown): Promise<void>
}

type Pending = {
  controller: AbortController
  promise: Promise<void>
  latest?: DownloadProgress
}

export function createModelHandlers(deps: ModelsDeps): ModelHandlers {
  // Keyed by the *resolved* ModelId ('base' vs 'base.en'), not by the picker
  // row. The English-only toggle can flip which concrete id a row resolves
  // to while a download for the old id is still in flight; a row-keyed map
  // would then either wrongly join that stale download or (worse) silently
  // drop a click that should have started a fresh one for the newly-resolved
  // id. See the toggle-mid-download regression test in models.test.ts.
  const pending = new Map<ModelId, Pending>()
  // A short-lived, row-keyed lock covering only the gap between admitting a
  // download() call and registering it into `pending` under its resolved id.
  // Resolving that id requires reading settings, which is async, so two
  // clicks on the same row issued back to back (no await between them) would
  // otherwise both pass the empty `pending` check before either had
  // registered. Released the moment the resolved id is known — `pending`
  // itself is what dedupes for the rest of the download's lifetime.
  const admitting = new Map<ModelBaseId, Promise<void>>()

  async function list(): Promise<ModelRow[]> {
    const settings = await deps.readSettings()

    return Promise.all(
      MODEL_BASE_ORDER.map(async (base): Promise<ModelRow> => {
        const resolved = entryFor(resolveModelId(base, settings.englishOnly))
        const latest = pending.get(resolved.id)?.latest
        return {
          base,
          resolved,
          installed: await deps.isInstalled(resolved.id),
          realtimeFactor: settings.throughput[resolved.id]?.realtimeFactor,
          // `pending` is already keyed by `resolved.id`, so `latest.id` can
          // only ever equal it — this is a belt-and-suspenders check that a
          // row can never surface another row's in-flight progress.
          downloading: latest?.id === resolved.id ? latest : undefined,
        }
      }),
    )
  }

  // `async` so a validation failure arrives as a rejection like every other
  // handler's. `admitting.set` below runs before the first await, which is
  // what makes the synchronous double-click guard race-free — the same
  // guarantee the old row-keyed `pending.set` used to provide directly.
  async function download(base: unknown): Promise<void> {
    const row = requireModelBaseId(base)

    const admittingRow = admitting.get(row)
    if (admittingRow) return admittingRow

    const request = (async () => {
      try {
        const settings = await deps.readSettings()
        const id = resolveModelId(row, settings.englishOnly)

        const existing = pending.get(id)
        if (existing) return existing.promise

        const controller = new AbortController()
        const record: Pending = { controller, promise: Promise.resolve() }
        pending.set(id, record)

        record.promise = (async () => {
          try {
            await deps.install(id, {
              signal: controller.signal,
              onProgress: (progress) => {
                record.latest = progress
                deps.emitProgress(progress)
              },
            })
          } catch (cause) {
            // Cancellation is not an error. Part 2 rejects with a plain Error on
            // abort and keeps the `.part` file, so Retry resumes.
            if (!controller.signal.aborted) throw cause
          } finally {
            pending.delete(id)
          }
        })()

        return record.promise
      } finally {
        // Only the admission gap is locked — not the whole download — so a
        // later click on this row (e.g. after a toggle) re-resolves the id
        // and joins or starts fresh under `pending`, rather than being stuck
        // behind a download that can take minutes.
        admitting.delete(row)
      }
    })()

    admitting.set(row, request)
    return request
  }

  async function cancelDownload(base: unknown): Promise<void> {
    const row = requireModelBaseId(base)
    const settings = await deps.readSettings()
    pending.get(resolveModelId(row, settings.englishOnly))?.controller.abort()
  }

  async function remove(base: unknown): Promise<void> {
    const row = requireModelBaseId(base)
    const settings = await deps.readSettings()
    await deps.remove(resolveModelId(row, settings.englishOnly))
  }

  return { list, download, cancelDownload, remove }
}
