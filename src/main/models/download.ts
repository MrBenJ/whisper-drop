import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../../shared/errors.js'
import type { DownloadProgress } from '../../shared/types.js'
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

export type { DownloadProgress }

export type DownloadOptions = {
  entry: ModelEntry
  destPath: string
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  freeBytesImpl?: (dir: string) => Promise<number>
  now?: () => number
  /**
   * How long to wait for a response (headers) after the request goes out
   * before treating the connection as dead. A caller that accepts the
   * request and then never replies would otherwise hang this promise
   * forever. Not a total-duration cap — see `idleTimeoutMs`.
   */
  responseTimeoutMs?: number
  /**
   * How long to wait, once the body is streaming, without receiving any
   * bytes before treating the transfer as stalled. Reset on every chunk, so
   * a slow-but-steady multi-gigabyte download is never penalized — only a
   * connection that stops delivering bytes without closing the socket is.
   */
  idleTimeoutMs?: number
  /**
   * Test seam only: when set, replaces the default trusted prefix entirely
   * (not additive) so tests can point at a local server. Production callers
   * must never set this — `createModelStore`'s `install` builds its own
   * `DownloadOptions` and does not forward it, so IPC cannot reach it even
   * by accident.
   */
  trustedUrlPrefixesForTests?: string[]
}

/** No response within this long means the connection is dead, not just slow. */
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000
/** No new bytes within this long, once streaming has started, means the
 * transfer stalled. Reset on every chunk — never a total-duration cap. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

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

/** `77691713` → `"74.1 MB"`; `3095033483` → `"2.9 GB"`. MB below a gigabyte,
 * GB above, one decimal place — `Math.ceil(bytes / 1e9)` rounded a 77 MB
 * model up to "about 1 GB", which is not a sensible size for it. */
function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024
  const MB = 1024 * 1024
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${(bytes / MB).toFixed(1)} MB`
}

/** Path of the temporary file a download writes to before the final rename
 * into place. Exported so the store can compute the same path without
 * re-deriving the suffix independently — see store.ts's `remove`. */
export function partPathFor(destPath: string): string {
  return `${destPath}.part`
}

/**
 * Checked in full, not just by hostname — see DEFAULT_TRUSTED_PREFIXES above
 * for why. Compared against the *normalized* URL, not the raw string: `fetch`
 * resolves `..` segments before requesting, so a raw `startsWith` check would
 * let `<trusted-prefix>../../../attacker/repo/...` pass the string check
 * while actually fetching from `attacker/repo` — exactly the malicious-
 * catalog-entry threat this check exists to stop. A URL that fails to parse
 * is rejected, not passed through.
 */
function assertTrustedSource(url: string, trustedPrefixes: readonly string[]): void {
  let normalized: string
  try {
    normalized = new URL(url).href
  } catch (cause) {
    throw new AppError(
      'DOWNLOAD_NETWORK_ERROR',
      'Refused to download from an untrusted source.',
      `url=${url} unparsable: ${String(cause)}`,
    )
  }

  if (trustedPrefixes.some((prefix) => normalized.startsWith(prefix))) return
  throw new AppError(
    'DOWNLOAD_NETWORK_ERROR',
    'Refused to download from an untrusted source.',
    `url=${normalized} trustedPrefixes=${trustedPrefixes.join(', ')}`,
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
    responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    trustedUrlPrefixesForTests,
  } = options

  if (signal?.aborted) throw new Error('downloadModel: aborted before starting')
  assertTrustedSource(entry.url, trustedUrlPrefixesForTests ?? DEFAULT_TRUSTED_PREFIXES)

  const partPath = partPathFor(destPath)

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
      `Not enough free space. ${entry.label} needs about ${formatBytes(entry.bytes)}.`,
      `free=${free} required=${entry.bytes - resumeFrom + HEADROOM_BYTES}`,
    )
  }

  // Compose an internal watchdog controller with the caller's signal: caller
  // cancellation still aborts exactly as before, but a response that never
  // arrives or a body that stops delivering bytes without closing the socket
  // also gets aborted here, rather than hanging this promise forever (see
  // the finding this is fixing — an in-flight install map joins every later
  // install to a hung promise, and remove() awaits it before deleting).
  //
  // `timeoutKind` records *why* the internal controller tripped, so a
  // timeout can be told apart from a caller cancellation after the fact:
  // cancellation must keep throwing the plain "aborted" Error the rest of
  // the app matches on, while a timeout is a network failure and must throw
  // an AppError instead — surfacing a stall as a plain cancellation would
  // make it look to the UI exactly like the user pressed Cancel.
  const internalController = new AbortController()
  let timeoutKind: 'response' | 'idle' | undefined
  const forwardCallerAbort = () => internalController.abort()
  signal?.addEventListener('abort', forwardCallerAbort)

  let responseTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const clearResponseTimer = () => {
    if (responseTimer !== undefined) clearTimeout(responseTimer)
    responseTimer = undefined
  }
  const clearIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  const armIdleTimer = () => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      timeoutKind = 'idle'
      internalController.abort()
    }, idleTimeoutMs)
  }

  /** Picks the right error for a fetch/pipeline failure: caller cancellation
   * keeps today's plain, code-less Error; a watchdog timeout is a network
   * failure and gets a coded AppError naming which timeout tripped; anything
   * else falls back to the generic network-error message it always had. */
  function toDownloadError(genericMessage: string, genericDetail: string): Error {
    if (signal?.aborted) return new Error('downloadModel: aborted')
    if (timeoutKind) {
      const timeoutMs = timeoutKind === 'response' ? responseTimeoutMs : idleTimeoutMs
      return new AppError(
        'DOWNLOAD_NETWORK_ERROR',
        'The download stalled and was cancelled automatically.',
        `${timeoutKind} timeout: no ${timeoutKind === 'response' ? 'response' : 'data'} received for ${timeoutMs}ms`,
      )
    }
    return new AppError('DOWNLOAD_NETWORK_ERROR', genericMessage, genericDetail)
  }

  let response: Response
  // Placeholder until `resumeFrom` reaches its final value below — a 200 to
  // a ranged request resets `resumeFrom` to 0 after this point, and
  // `received` must track that reset, not the pre-request guess.
  let received = 0
  const hash = createHash('sha256')
  try {
    try {
      responseTimer = setTimeout(() => {
        timeoutKind = 'response'
        internalController.abort()
      }, responseTimeoutMs)

      try {
        response = await fetchImpl(entry.url, {
          headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {},
          signal: internalController.signal,
        })
      } catch (cause) {
        throw toDownloadError("Couldn't reach the model server.", String(cause))
      } finally {
        clearResponseTimer()
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

      if (append) {
        await pipeline(createReadStream(partPath), async function* (source) {
          for await (const chunk of source) hash.update(chunk as Buffer)
        })
      }

      received = resumeFrom
      const startedAt = now()

      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          // Streaming bytes proves the connection is alive, so every chunk
          // resets the idle watchdog — a slow-but-steady multi-gigabyte
          // download never trips it, only a transfer that goes quiet does.
          armIdleTimer()
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
        armIdleTimer()
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          meter,
          createWriteStream(partPath, { flags: append ? 'a' : 'w' }),
          { signal: internalController.signal },
        )
      } catch (cause) {
        // Keep the .part file either way: a later attempt resumes from it,
        // and a stall is exactly when resume matters most.
        throw toDownloadError('The download was interrupted.', String(cause))
      } finally {
        clearIdleTimer()
      }
    } finally {
      clearResponseTimer()
      clearIdleTimer()
    }
  } finally {
    signal?.removeEventListener('abort', forwardCallerAbort)
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

  try {
    await rename(partPath, destPath)
  } catch (cause) {
    // Most likely: the .part file was deleted out from under this download
    // (e.g. a concurrent remove that isn't serialized against this install —
    // the store's install/remove serialization is meant to prevent that, but
    // this is the last line of defense) rather than a raw fs error with no
    // code a caller can show the user.
    throw new AppError(
      'MODEL_FILE_MISSING',
      `${entry.label} finished downloading, but the file went missing before it could be installed.`,
      String(cause),
    )
  }
}
