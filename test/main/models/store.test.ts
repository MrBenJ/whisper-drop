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
