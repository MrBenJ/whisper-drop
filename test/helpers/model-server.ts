import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ServerBehaviour =
  /** Normal: honour Range with 206, otherwise 200. */
  | { kind: 'normal' }
  /** Ignore Range entirely and always return the full body with 200. */
  | { kind: 'ignore-range' }
  /** Return a body that does not match the advertised sha256. */
  | { kind: 'wrong-bytes' }
  /** Write some bytes then destroy the socket. */
  | { kind: 'truncate'; afterBytes: number }
  /** Respond with an HTTP error status. */
  | { kind: 'error-status'; status: number }
  /** Honour Range like 'normal', but write the body in a handful of delayed
   * chunks so a caller can abort while a download is genuinely in flight. */
  | { kind: 'slow'; chunkDelayMs: number }
  /** Send fewer bytes than the model's full size, then end the response with
   * no `content-length` set — chunked encoding terminates cleanly even
   * though the transfer was actually interrupted upstream. */
  | { kind: 'short-body'; sendBytes: number }
  /** Answer a Range request with 206 but echo a Content-Range start that
   * doesn't match what was requested. */
  | { kind: 'bad-range' }
  /** Answer a Range request with 206 but omit Content-Range entirely. */
  | { kind: 'no-content-range' }
  /** Send more bytes than the model's expected size, with an honest
   * Content-Length covering all of them — models a misbehaving server that
   * keeps writing past what the catalog trusts as the file's true size. */
  | { kind: 'overlong'; extraBytes: number }

export type ModelServer = {
  url: string
  /** Range headers received, in order. Empty string when the header was absent. */
  requests: string[]
  close: () => Promise<void>
}

/** A local HTTP server that serves `body` and can be told to misbehave. */
export async function startModelServer(
  body: Buffer,
  behaviour: ServerBehaviour = { kind: 'normal' },
): Promise<ModelServer> {
  const requests: string[] = []

  const server: Server = createServer((req, res) => {
    requests.push(req.headers.range ?? '')

    if (behaviour.kind === 'error-status') {
      res.writeHead(behaviour.status)
      res.end('nope')
      return
    }

    if (behaviour.kind === 'short-body') {
      // No content-length: the chunked encoding still terminates cleanly,
      // even though far fewer bytes than the model's real size were sent.
      res.writeHead(200)
      res.end(body.subarray(0, behaviour.sendBytes))
      return
    }

    const payload = behaviour.kind === 'wrong-bytes'
      ? Buffer.alloc(body.length, 0x00)
      : body

    if (behaviour.kind === 'truncate') {
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.write(payload.subarray(0, behaviour.afterBytes))
      // A same-tick destroy() can kill the socket before the client even
      // finishes reading the response headers, which surfaces as a fetch()
      // failure rather than a body-stream failure — the wrong branch for a
      // test about a connection dropping mid-transfer. The delay lets the
      // headers and first bytes land before the reset.
      setTimeout(() => res.destroy(), 20)
      return
    }

    if (behaviour.kind === 'bad-range') {
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
      const slice = payload.subarray(start)
      res.writeHead(206, {
        'content-length': String(slice.length),
        // Off by one from the offset actually requested/served.
        'content-range': `bytes ${start + 1}-${payload.length - 1}/${payload.length}`,
      })
      res.end(slice)
      return
    }

    if (behaviour.kind === 'no-content-range') {
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
      const slice = payload.subarray(start)
      res.writeHead(206, { 'content-length': String(slice.length) })
      res.end(slice)
      return
    }

    if (behaviour.kind === 'overlong') {
      // Written as two separate flushes, like 'truncate' and 'slow' below, so
      // the client reliably observes the expected-size payload and the
      // overflow as distinct chunks rather than one coalesced buffer — that's
      // what lets a test assert the cap truncates at exactly the expected
      // size rather than rejecting (and dropping) the whole thing.
      const overflow = Buffer.alloc(behaviour.extraBytes, 0xff)
      res.writeHead(200, { 'content-length': String(payload.length + overflow.length) })
      res.write(payload)
      setTimeout(() => res.end(overflow), 20)
      return
    }

    if (behaviour.kind === 'slow') {
      res.on('error', () => {})
      const range = req.headers.range
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
      const slice = payload.subarray(start)
      const headers: Record<string, string> = { 'content-length': String(slice.length) }
      if (range) headers['content-range'] = `bytes ${start}-${payload.length - 1}/${payload.length}`
      res.writeHead(range ? 206 : 200, headers)

      const chunkSize = Math.max(1, Math.ceil(slice.length / 4))
      let offset = 0
      const writeNext = (): void => {
        if (res.destroyed || res.writableEnded) return
        if (offset >= slice.length) {
          res.end()
          return
        }
        res.write(slice.subarray(offset, offset + chunkSize))
        offset += chunkSize
        setTimeout(writeNext, behaviour.chunkDelayMs)
      }
      writeNext()
      return
    }

    const range = behaviour.kind === 'ignore-range' ? undefined : req.headers.range
    if (range) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      const slice = payload.subarray(start)
      res.writeHead(206, {
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
      })
      res.end(slice)
      return
    }

    res.writeHead(200, { 'content-length': String(payload.length) })
    res.end(payload)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/model.bin`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
