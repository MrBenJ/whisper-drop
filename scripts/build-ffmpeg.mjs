#!/usr/bin/env node
// Provisions a redistributable LGPL ffmpeg + ffprobe for one target
// (`${platform}-${arch}`) into resources/<target>/, next to whisper-cli.
//
//   - macOS: compiled from FFmpeg's tagged source with an LGPL, decode-focused
//     config. The redistributability of the result is that --enable-gpl and
//     --enable-nonfree are NEVER passed (both default off in configure).
//   - Windows/Linux: BtbN's ready-made `-lgpl` static build, downloaded and
//     checksum-verified against ffmpeg.manifest.json.
//
// Every provisioned binary is byte-scanned (never executed) for the forbidden
// build flags before it is accepted, so a cross-arch binary this host cannot
// run is still gated. Stamped/cached like scripts/build-whisper.mjs.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { assertRedistributableFfmpeg } from './lib/ffmpeg-license.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'ffmpeg.manifest.json'), 'utf8'))

const targetArch = process.env.WHISPER_DROP_TARGET_ARCH ?? process.arch
if (targetArch !== 'x64' && targetArch !== 'arm64') {
  console.error(`WHISPER_DROP_TARGET_ARCH must be x64 or arm64, received ${targetArch}`)
  process.exit(1)
}
const platform = process.platform
if (targetArch !== process.arch && platform !== 'darwin') {
  console.error(
    `Cross-building ffmpeg for ${targetArch} is only supported on macOS (host is ${platform}-${process.arch})`,
  )
  process.exit(1)
}

const target = `${platform}-${targetArch}`
const exe = platform === 'win32' ? '.exe' : ''
const outDir = join(ROOT, 'resources', target)
const ffmpegOut = join(outDir, `ffmpeg${exe}`)
const ffprobeOut = join(outDir, `ffprobe${exe}`)
const stampPath = join(outDir, '.ffmpeg-tag')
// macOS builds from ffmpegTag; win/linux come from a named BtbN asset. Either
// uniquely identifies "what is currently installed", so a manifest bump busts it.
const stampValue = platform === 'darwin' ? manifest.ffmpegTag : manifest.btbn.assets[target].filename

if (
  existsSync(ffmpegOut) &&
  existsSync(ffprobeOut) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, 'utf8').trim() === stampValue
) {
  console.log(`ffmpeg/ffprobe for ${target} already provisioned (${stampValue})`)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
if (platform === 'darwin') await compileMac()
else await fetchBtbn()

// Cross-arch-safe license gate: byte-scan, never exec.
assertRedistributableFfmpeg(readFileSync(ffmpegOut), `${target}/ffmpeg`)
assertRedistributableFfmpeg(readFileSync(ffprobeOut), `${target}/ffprobe`)
writeFileSync(stampPath, `${stampValue}\n`)
console.log(`Provisioned redistributable ffmpeg + ffprobe for ${target}`)

async function compileMac() {
  const prereqs = ['git', 'make', 'clang']
  // x86 assembly needs nasm; only relevant for the x64 (cross) build.
  if (targetArch === 'x64') prereqs.push('nasm')
  const missing = prereqs.filter((cmd) => spawnSync(cmd, ['--version']).error)
  if (missing.length > 0) {
    for (const cmd of missing) {
      console.error(`Missing required command: ${cmd} (needed to build ffmpeg from source)`)
      console.error(`  Install: brew install ${cmd} (or Xcode Command Line Tools for clang/make)`)
    }
    process.exit(1)
  }

  const src = join(ROOT, '.cache', 'ffmpeg')
  if (existsSync(join(src, '.git'))) {
    run('git', ['fetch', '--depth', '1', 'origin', 'tag', manifest.ffmpegTag, '--no-tags'], src)
    run('git', ['checkout', '--force', manifest.ffmpegTag], src)
  } else {
    mkdirSync(dirname(src), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', manifest.ffmpegTag, manifest.ffmpegRepo, src])
  }

  // Out-of-tree build dir per target arch so a native arm64 cache can't leak
  // into the x64 cross-build.
  const buildDir = join(src, `build-${targetArch}`)
  rmSync(buildDir, { recursive: true, force: true })
  mkdirSync(buildDir, { recursive: true })

  // LGPL, decode-focused, self-contained. NO --enable-gpl, NO --enable-nonfree.
  const configure = [
    join(src, 'configure'),
    '--disable-shared',
    '--enable-static',
    '--disable-doc',
    '--disable-htmlpages',
    '--disable-manpages',
    '--disable-podpages',
    '--disable-txtpages',
    '--disable-ffplay',
    '--enable-ffmpeg',
    '--enable-ffprobe',
    '--disable-network',
  ]
  if (targetArch !== process.arch) {
    // arm64 host -> x64 target cross-build.
    configure.push(
      '--enable-cross-compile',
      '--arch=x86_64',
      '--cc=clang -arch x86_64',
      '--extra-cflags=-arch x86_64',
      '--extra-ldflags=-arch x86_64',
      '--target-os=darwin',
    )
  }
  run('sh', configure, buildDir)
  run('make', ['-j', String(Math.max(1, cpus().length))], buildDir)

  copyExecutable(join(buildDir, 'ffmpeg'), ffmpegOut)
  copyExecutable(join(buildDir, 'ffprobe'), ffprobeOut)
}

async function fetchBtbn() {
  const asset = manifest.btbn.assets[target]
  if (!asset) {
    console.error(`No BtbN asset pinned for ${target}`)
    process.exit(1)
  }
  const url = `${manifest.btbn.release}/${asset.filename}`
  const dlDir = join(ROOT, '.cache', 'ffmpeg-downloads')
  mkdirSync(dlDir, { recursive: true })
  const archive = join(dlDir, asset.filename)

  if (existsSync(archive)) {
    if (sha256(archive) !== asset.sha256) {
      console.error(`Cached ${asset.filename} checksum mismatch; delete .cache/ffmpeg-downloads and retry`)
      process.exit(1)
    }
  } else {
    console.log(`Downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok || !res.body) {
      console.error(`Download failed: HTTP ${res.status}`)
      process.exit(1)
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${archive}.part`))
    const digest = sha256(`${archive}.part`)
    if (digest !== asset.sha256) {
      rmSync(`${archive}.part`, { force: true })
      console.error(`Checksum mismatch for ${asset.filename}: expected ${asset.sha256}, got ${digest}`)
      process.exit(1)
    }
    copyFileSync(`${archive}.part`, archive)
    rmSync(`${archive}.part`, { force: true })
  }

  // bsdtar (`tar`) extracts both .zip and .tar.xz on macOS, Linux and modern Windows.
  const extractDir = join(dlDir, `extract-${target}`)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  run('tar', ['-xf', archive, '-C', extractDir])

  const ffmpegSrc = findUnder(extractDir, `ffmpeg${exe}`)
  const ffprobeSrc = findUnder(extractDir, `ffprobe${exe}`)
  if (!ffmpegSrc || !ffprobeSrc) {
    console.error(`Could not find ffmpeg/ffprobe inside ${asset.filename}`)
    process.exit(1)
  }
  copyExecutable(ffmpegSrc, ffmpegOut)
  copyExecutable(ffprobeSrc, ffprobeOut)
}

function copyExecutable(from, to) {
  copyFileSync(from, to)
  if (platform !== 'win32') chmodSync(to, 0o755)
}

function findUnder(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      const found = findUnder(full, name)
      if (found) return found
    } else if (entry === name) {
      return full
    }
  }
  return undefined
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function run(cmd, args, cwd = ROOT) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}
