#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL_ = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
const dest = join(ROOT, '.cache', 'models', 'ggml-tiny.bin')
const EXPECTED_SHA256 = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'

if (existsSync(dest)) {
  console.log(`tiny model already present at ${dest}`)
  process.exit(0)
}

mkdirSync(dirname(dest), { recursive: true })

console.log(`Downloading ggml-tiny.bin (~75 MB) to ${dest}`)
const response = await fetch(URL_)
if (!response.ok || !response.body) {
  console.error(`Download failed: HTTP ${response.status}`)
  process.exit(1)
}

const partial = `${dest}.part`

// Hash while writing so the 74 MB file is only read once.
const hash = createHash('sha256')
const hasher = new Transform({
  transform(chunk, _enc, callback) {
    hash.update(chunk)
    callback(null, chunk)
  },
})
await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(partial))

const digest = hash.digest('hex')
if (digest !== EXPECTED_SHA256) {
  unlinkSync(partial)
  console.error(`Checksum mismatch:\n  expected ${EXPECTED_SHA256}\n  actual   ${digest}`)
  process.exit(1)
}

// Only a verified file may land at the final path.
renameSync(partial, dest)
console.log('Done.')
