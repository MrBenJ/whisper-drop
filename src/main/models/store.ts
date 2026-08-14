import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { CATALOG, entryFor, type ModelEntry, type ModelId } from './catalog.js'
import { downloadModel, partPathFor, type DownloadOptions, type DownloadProgress } from './download.js'

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

  // One in-flight install promise per model id. Lets a second install() for
  // the same id join the first instead of starting a second download (which
  // would double-write the same .part and double the disk-fill cap), and
  // lets remove() wait for an install to finish before deleting anything —
  // rather than unlinking the file out from under a download still writing
  // to it, which used to surface as a raw fs error on the eventual rename.
  const inFlightInstalls = new Map<ModelId, Promise<void>>()

  /**
   * `id` crosses the IPC boundary in part 3 as a renderer-supplied string, so
   * it cannot be trusted to already be a real ModelId. `lookup` throws on
   * anything that isn't a real catalog id — including a path-traversal
   * string like '../../../../etc/passwd', which would otherwise let `remove`
   * delete an arbitrary file. Validating here, in the one place every path
   * is built, closes that for `remove` and for `verify`'s file read too.
   */
  function pathFor(id: ModelId): string {
    lookup(id)
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
   * download and then removing it actually reclaims the space. Waits out any
   * in-flight install for this id first, so a remove landing mid-download
   * can't unlink the file a download is still writing to. */
  async function remove(id: ModelId): Promise<void> {
    const path = pathFor(id) // validates id before anything else runs
    await inFlightInstalls.get(id)?.catch(() => {})
    await rm(path, { force: true })
    await rm(partPathFor(path), { force: true })
  }

  async function install(id: ModelId, options: InstallOptions = {}): Promise<void> {
    const existing = inFlightInstalls.get(id)
    if (existing) return existing

    const promise = (async () => {
      if (!options.force && (await isInstalled(id))) return

      await mkdir(modelsDir, { recursive: true })
      await download({
        entry: lookup(id),
        destPath: pathFor(id),
        onProgress: options.onProgress,
        signal: options.signal,
      })
    })()

    inFlightInstalls.set(id, promise)
    try {
      await promise
    } finally {
      inFlightInstalls.delete(id)
    }
  }

  return { modelsDir, pathFor, isInstalled, verify, listInstalled, remove, install }
}
