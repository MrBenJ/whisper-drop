#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL_ = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
const dest = join(ROOT, '.cache', 'models', 'ggml-tiny.bin')

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
await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
renameSync(partial, dest)
console.log('Done.')
