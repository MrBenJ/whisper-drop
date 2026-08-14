#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PREREQS = [
  {
    cmd: 'cmake',
    purpose: 'building whisper.cpp',
    install: {
      darwin: 'brew install cmake',
      linux: "apt install cmake (or your distro's package manager)",
      win32: 'install from https://cmake.org/download/ or `winget install Kitware.CMake`',
    },
  },
  {
    cmd: 'git',
    purpose: 'cloning whisper.cpp',
    install: {
      darwin: 'brew install git',
      linux: "apt install git (or your distro's package manager)",
      win32: 'install from https://git-scm.com/download/win or `winget install Git.Git`',
    },
  },
]

// spawnSync(never a shell) sets .error to ENOENT instead of throwing when the binary is missing.
const missing = PREREQS.filter((p) => spawnSync(p.cmd, ['--version']).error)
if (missing.length > 0) {
  for (const p of missing) {
    console.error(`Missing required command: ${p.cmd} (needed for ${p.purpose})`)
    console.error(`  Install: ${p.install[process.platform] ?? p.install.linux}`)
  }
  process.exit(1)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { whisperCppRepo, whisperCppTag } = JSON.parse(
  readFileSync(join(ROOT, 'whisper.manifest.json'), 'utf8'),
)

const target = `${process.platform}-${process.arch}`
const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
const outDir = join(ROOT, 'resources', target)
const outBin = join(outDir, exe)
const stamp = join(outDir, '.tag')

if (existsSync(outBin) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === whisperCppTag) {
  console.log(`whisper-cli ${whisperCppTag} already built for ${target}`)
  process.exit(0)
}

const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

const src = join(ROOT, '.cache', 'whisper.cpp')
if (existsSync(join(src, '.git'))) {
  run('git', ['fetch', '--depth', '1', 'origin', 'tag', whisperCppTag, '--no-tags'], src)
  run('git', ['checkout', '--force', whisperCppTag], src)
} else {
  mkdirSync(dirname(src), { recursive: true })
  run('git', ['clone', '--depth', '1', '--branch', whisperCppTag, whisperCppRepo, src])
}

const cmakeArgs = [
  '-B', 'build',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=OFF',
]
if (process.platform === 'darwin') cmakeArgs.push('-DGGML_METAL_EMBED_LIBRARY=ON')

run('cmake', cmakeArgs, src)
run('cmake', ['--build', 'build', '--config', 'Release', '-j'], src)

const candidates = [
  join(src, 'build', 'bin', exe),
  join(src, 'build', 'bin', 'Release', exe),
]
const built = candidates.find((p) => existsSync(p))
if (!built) {
  console.error(`Could not find a built whisper-cli. Looked in:\n  ${candidates.join('\n  ')}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
copyFileSync(built, outBin)
writeFileSync(stamp, `${whisperCppTag}\n`)
console.log(`Built whisper-cli ${whisperCppTag} -> ${outBin}`)
