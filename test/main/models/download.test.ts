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
