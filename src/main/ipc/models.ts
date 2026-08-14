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
  // Keyed by picker row, not by concrete id: the row is what the user clicked,
  // and it is what Cancel and the progress bar are attached to.
  const pending = new Map<ModelBaseId, Pending>()

  async function list(): Promise<ModelRow[]> {
    const settings = await deps.readSettings()

    return Promise.all(
      MODEL_BASE_ORDER.map(async (base): Promise<ModelRow> => {
        const resolved = entryFor(resolveModelId(base, settings.englishOnly))
        return {
          base,
          resolved,
          installed: await deps.isInstalled(resolved.id),
          realtimeFactor: settings.throughput[resolved.id]?.realtimeFactor,
          downloading: pending.get(base)?.latest,
        }
      }),
    )
  }

  // `async` so a validation failure arrives as a rejection like every other
  // handler's. The body still registers into `pending` before its first await,
  // which is what makes the double-click guard below race-free.
  async function download(base: unknown): Promise<void> {
    const row = requireModelBaseId(base)

    const existing = pending.get(row)
    if (existing) return existing.promise

    const controller = new AbortController()
    const record: Pending = { controller, promise: Promise.resolve() }
    // Registered before the first await, so a double-clicked button joins this
    // download rather than starting a second one with its own controller.
    pending.set(row, record)

    record.promise = (async () => {
      try {
        const settings = await deps.readSettings()
        await deps.install(resolveModelId(row, settings.englishOnly), {
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
        pending.delete(row)
      }
    })()

    return record.promise
  }

  async function cancelDownload(base: unknown): Promise<void> {
    pending.get(requireModelBaseId(base))?.controller.abort()
  }

  async function remove(base: unknown): Promise<void> {
    const row = requireModelBaseId(base)
    const settings = await deps.readSettings()
    await deps.remove(resolveModelId(row, settings.englishOnly))
  }

  return { list, download, cancelDownload, remove }
}
