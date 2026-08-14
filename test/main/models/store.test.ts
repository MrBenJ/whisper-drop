import { createHash } from 'node:crypto'
import { mkdtemp, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
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

  describe('the id trust boundary', () => {
    // id crosses the IPC boundary in part 3 as a renderer-supplied string, so
    // it can't be trusted to be a real ModelId. pathFor is the one place
    // every on-disk path is built, so validating there closes remove's
    // arbitrary-file-delete and verify's arbitrary-file-read in one place.
    const traversalId = '../../../../../../etc/some' as ModelId

    it('pathFor rejects a path-traversal id', () => {
      expect(() => createModelStore(dir).pathFor(traversalId)).toThrow()
    })

    it('pathFor rejects an id that is not a real catalog id', () => {
      expect(() => createModelStore(dir).pathFor('not-a-real-model' as ModelId)).toThrow()
    })

    it('remove rejects a path-traversal id rather than deleting an arbitrary path', async () => {
      await expect(createModelStore(dir).remove(traversalId)).rejects.toThrow()
    })

    it('remove rejects an id that is not a real catalog id', async () => {
      await expect(createModelStore(dir).remove('not-a-real-model' as ModelId)).rejects.toThrow()
    })
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

  describe('concurrent install and remove', () => {
    it('serializes concurrent installs for the same id, downloading only once', async () => {
      const download = vi.fn(async () => {})
      const store = createModelStore(dir, download)

      await Promise.all([store.install('tiny'), store.install('tiny')])

      expect(download).toHaveBeenCalledTimes(1)
    })

    it('lets a later install proceed independently once an earlier one has finished', async () => {
      const download = vi.fn(async () => {})
      const store = createModelStore(dir, download)

      await store.install('tiny')
      await store.install('tiny', { force: true })

      expect(download).toHaveBeenCalledTimes(2)
    })

    it('clears the in-flight entry after a failed install, so a later install starts a fresh attempt instead of rejoining the stale rejection', async () => {
      // install()'s cleanup runs in a try/finally, which structurally
      // guarantees the map entry is deleted whether the awaited promise
      // resolves or rejects — but that guarantee was previously untested. If
      // the finally were ever lost, this would fail closed: the second
      // install() would return the same already-rejected promise from the
      // map (rejecting again with 'first attempt failed' and never calling
      // download a second time) rather than starting over — exactly the
      // "can't be retried" half of the bug this store.ts change exists to
      // prevent.
      const download = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error('first attempt failed'))
      const store = createModelStore(dir, download)

      await expect(store.install('tiny')).rejects.toThrow('first attempt failed')
      await expect(store.install('tiny')).resolves.toBeUndefined()

      expect(download).toHaveBeenCalledTimes(2)
    })

    it('waits for an in-flight install before removing, so remove never races the final rename and never surfaces a raw fs error', async () => {
      // A fake downloader that writes a .part file and then, once released,
      // renames it into place — modelling the real downloadModel's shape
      // closely enough to exercise the race the old code had: remove()
      // unlinking mid-download and the eventual rename failing with a raw,
      // uncoded fs error.
      let downloaderReady: () => void = () => {}
      const downloaderIsWaiting = new Promise<void>((resolve) => {
        downloaderReady = resolve
      })
      let releaseDownloader: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        releaseDownloader = resolve
      })

      const store = createModelStore(dir, async ({ destPath }) => {
        await mkdir(join(dir, 'models'), { recursive: true })
        await writeFile(`${destPath}.part`, 'partial')
        downloaderReady()
        await gate
        await rename(`${destPath}.part`, destPath)
      })

      const installPromise = store.install('tiny')
      await downloaderIsWaiting

      const removePromise = store.remove('tiny')
      releaseDownloader()

      await expect(installPromise).resolves.toBeUndefined()
      await expect(removePromise).resolves.toBeUndefined()

      expect(await store.isInstalled('tiny')).toBe(false)
      await expect(stat(store.pathFor('tiny'))).rejects.toThrow()
    })
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
