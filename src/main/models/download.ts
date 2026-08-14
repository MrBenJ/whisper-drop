import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../../shared/errors.js'
import { MODEL_URL_PREFIX, type ModelEntry } from './catalog.js'

/** Refuse a download that would leave the disk this close to full. */
export const HEADROOM_BYTES = 64 * 1024 * 1024

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
   * Test seam only: when set, replaces the default trusted prefix entirely
   * (not additive) so tests can point at a local server. Production callers
   * must never set this — `createModelStore`'s `install` builds its own
   * `DownloadOptions` and does not forward it, so IPC cannot reach it even
   * by accident.
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

/** Checked in full, not just by hostname — see DEFAULT_TRUSTED_PREFIXES above for why. */
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
    await response.body?.cancel().catch(() => {})
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
    const match = contentRange ? /bytes (\d+)-\d+\/(\d+)/.exec(contentRange) : null
    const start = match ? Number(match[1]) : undefined
    const total = match ? Number(match[2]) : undefined
    if (start !== resumeFrom || total !== entry.bytes) {
      // Missing, mismatched, or claiming a different total than the catalog
      // trusts — any of these means we can't trust which bytes this response
      // actually holds. Discard the partial rather than risk splicing bytes
      // in at the wrong position — the next attempt starts clean.
      await response.body?.cancel().catch(() => {})
      await rm(partPath, { force: true })
      throw new AppError(
        'DOWNLOAD_NETWORK_ERROR',
        'The model server returned an unexpected byte range.',
        `requested ${resumeFrom}, got ${contentRange ?? '(missing)'}`,
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
      received += chunk.length
      // entry.bytes is the trusted quantity; the response stream is not. A
      // server or intermediary that keeps sending past it would otherwise
      // write unbounded data to disk after the space precheck already
      // passed — so this is rejected rather than written through.
      if (received > entry.bytes) {
        callback(new Error(`received more bytes than expected (${received} > ${entry.bytes})`))
        return
      }

      hash.update(chunk)

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
