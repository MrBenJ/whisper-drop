import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadModel, HEADROOM_BYTES } from '../../../src/main/models/download.js'
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

  it('restarts from zero when a 206 response omits Content-Range entirely, rather than trusting an unvalidated append', async () => {
    server = await startModelServer(BODY, { kind: 'no-content-range' })
    const dest = join(dir, 'model.bin')
    await writeFile(`${dest}.part`, BODY.subarray(0, 10))

    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

    await expect(stat(`${dest}.part`)).rejects.toThrow()
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

  it('succeeds when free space covers only the remainder needed to resume, not the full size', async () => {
    // freeBytesImpl: async () => 1 (used above) fails against any formula,
    // including a buggy one that checks entry.bytes + HEADROOM and ignores
    // the existing partial entirely. This free value is chosen to be enough
    // for (remainder + headroom) but short of (full size + headroom), which
    // is exactly what discriminates the correct formula from that bug.
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')
    const partial = BODY.subarray(0, 10)
    await writeFile(`${dest}.part`, partial)

    const remaining = BODY.length - partial.length
    const free = remaining + HEADROOM_BYTES
    expect(free).toBeLessThan(BODY.length + HEADROOM_BYTES)

    await download({
      entry: entryFor(server.url),
      destPath: dest,
      freeBytesImpl: async () => free,
    })

    expect(await readFile(dest)).toEqual(BODY)
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

    // Both possible paths here (a stream error, or a clean-but-short end)
    // land on DOWNLOAD_NETWORK_ERROR, so this is strictly stronger than
    // just checking the .part file survives.
    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

    expect((await stat(`${dest}.part`)).size).toBeGreaterThan(0)
  })

  it('caps bytes written when the server sends more than entry.bytes, so a disk-filling stream cannot fill the disk', async () => {
    // Old assertion (size <= BODY.length) passed under both a real cap and a
    // no-op cap, since an uncapped download reaches the checksum branch,
    // which deletes .part on mismatch — so 0 <= BODY.length passed too, and
    // only the error code discriminated, incidentally. extraBytes an order
    // of magnitude past the body, plus an exact-size assertion, proves the
    // cap actually truncated the stream rather than the file being deleted.
    server = await startModelServer(BODY, { kind: 'overlong', extraBytes: BODY.length * 10 })
    const dest = join(dir, 'model.bin')

    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

    expect((await stat(`${dest}.part`)).size).toBe(BODY.length)
  })

  it('wraps a failed final rename as MODEL_FILE_MISSING rather than a raw fs error', async () => {
    // Simulates the destination having gone missing/unusable out from under
    // a completing download (e.g. an unserialized concurrent remove) — a
    // real fs error with no project error code, which would otherwise reach
    // a non-technical user as raw "ENOENT: ... rename ..." text.
    server = await startModelServer(BODY)
    const dest = join(dir, 'model.bin')
    await mkdir(dest) // destPath already exists as a directory, so rename(partFile, dest) fails

    await expect(
      download({ entry: entryFor(server.url), destPath: dest }),
    ).rejects.toMatchObject({ code: 'MODEL_FILE_MISSING' })
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

  describe('watchdog timeouts', () => {
    // These are the "timeout" side of the caller-cancellation-vs-timeout
    // distinction: a timeout is a network failure, not a user cancellation,
    // so it must throw a coded AppError — never the plain "aborted" Error
    // the 'aborting mid-stream' tests above assert for real cancellation.
    // Both timeouts are given short, injected values so nothing here sleeps
    // for tens of real seconds.

    it('rejects with DOWNLOAD_NETWORK_ERROR, not a plain aborted Error, when the body goes quiet without closing the socket', async () => {
      server = await startModelServer(BODY, { kind: 'stall', afterBytes: 12 })
      const dest = join(dir, 'model.bin')

      let error: unknown
      try {
        await download({ entry: entryFor(server.url), destPath: dest, idleTimeoutMs: 40 })
      } catch (caught) {
        error = caught
      }

      expect(error).toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })
      // The whole point: this must NOT look like the plain, code-less Error
      // that caller cancellation throws — a stall is a network failure, and
      // reporting it as a cancellation would tell the user the wrong thing.
      expect((error as { code?: unknown }).code).toBe('DOWNLOAD_NETWORK_ERROR')
    })

    it('leaves the .part file behind after a stall, and a later attempt resumes to a byte-correct result', async () => {
      server = await startModelServer(BODY, { kind: 'stall', afterBytes: 12 })
      const dest = join(dir, 'model.bin')

      await download({ entry: entryFor(server.url), destPath: dest, idleTimeoutMs: 40 }).catch(() => {})

      const partSize = (await stat(`${dest}.part`)).size
      expect(partSize).toBeGreaterThan(0)
      expect(partSize).toBeLessThan(BODY.length)

      // The stalled server never answers again, so resume against a fresh,
      // healthy server — proving the .part file itself is intact and
      // resumable, not just present.
      await server.close()
      server = await startModelServer(BODY)

      await download({ entry: entryFor(server.url), destPath: dest })

      expect(await readFile(dest)).toEqual(BODY)
      expect(server.requests.at(-1)).toBe(`bytes=${partSize}-`)
    })

    it('rejects with DOWNLOAD_NETWORK_ERROR when no response arrives at all', async () => {
      // A response that never arrives is a different failure point than a
      // body that stalls mid-stream (covered above) — this exercises the
      // response-timeout watchdog specifically, via a fetchImpl that only
      // ever settles when its signal is aborted, exactly like a real fetch
      // against a connection that accepted the request and went silent
      // before sending headers.
      const neverResponds: typeof fetch = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })) as typeof fetch

      const dest = join(dir, 'model.bin')

      await expect(
        downloadModel({
          entry: entryFor('https://huggingface.co/never/responds/model.bin'),
          trustedUrlPrefixesForTests: ['https://huggingface.co/never/responds/'],
          destPath: dest,
          fetchImpl: neverResponds,
          responseTimeoutMs: 30,
        }),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })
    })

    it('still throws the plain, code-less Error for real caller cancellation, proving the two paths stay distinguishable', async () => {
      // Same scenario as the 'aborting mid-stream' tests above, just with
      // short watchdog timeouts also configured — proving caller
      // cancellation wins over the watchdogs rather than racing them into
      // the wrong error shape.
      server = await startModelServer(BODY, { kind: 'slow', chunkDelayMs: 25 })
      const dest = join(dir, 'model.bin')
      const controller = new AbortController()
      let progressCount = 0

      let error: unknown
      try {
        await download({
          entry: entryFor(server.url),
          destPath: dest,
          signal: controller.signal,
          idleTimeoutMs: 5_000,
          responseTimeoutMs: 5_000,
          onProgress: () => {
            progressCount += 1
            if (progressCount === 2) controller.abort()
          },
        })
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/abort/i)
      expect((error as { code?: unknown }).code).toBeUndefined()
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

    it('rejects a path-traversal URL that string-startsWith the trusted prefix but resolves outside it, before any fetch', async () => {
      // fetch() normalizes '..' segments before requesting; a raw
      // url.startsWith(prefix) check does not, so this string passes a naive
      // check while actually requesting attacker/repo. The server's own
      // request list (not just the fetchImpl mock) proves nothing was ever
      // requested, including no request to the resolved attacker URL.
      const fetchImpl = vi.fn()
      const traversalUrl =
        'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' +
        '../../../../attacker/repo/resolve/main/ggml-tiny.bin'
      expect(traversalUrl.startsWith('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/')).toBe(true)
      expect(new URL(traversalUrl).href).toBe('https://huggingface.co/attacker/repo/resolve/main/ggml-tiny.bin')

      await expect(
        downloadModel({
          entry: entryFor(traversalUrl),
          destPath: join(dir, 'model.bin'),
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_NETWORK_ERROR' })

      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('rejects a URL that fails to parse, rather than passing it through', async () => {
      const fetchImpl = vi.fn()

      await expect(
        downloadModel({
          entry: entryFor('not a url at all'),
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
