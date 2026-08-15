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

// The arch to build *for*, which is the host arch unless a release build asks
// otherwise. macOS is the only platform we cross-build on: the release
// workflow produces both an arm64 and an x64 DMG from one arm64 runner, and
// `extraResources` picks the directory by name, so the name has to say which
// arch the binary inside is.
//
// electron-builder.json's `extraResources.from`/`.to` (`resources/${platform}-${arch}`)
// use electron-builder's own macros: `${arch}` is the arch electron-builder is packaging
// for (`--arm64`/`--x64`), but `${platform}` always expands to the *host's*
// `process.platform` — there is no target-platform macro, because electron-builder
// (like this script) never cross-builds across platforms, only across arch on macOS.
// That's why this only works: every matrix job in release.yml runs natively for its
// platform. A future cross-platform build would silently write to/read from the wrong
// `resources/<platform>-<arch>` directory. electron-builder.json can't carry this note
// itself — it's parsed with strict `JSON.parse` by `test/build/electron-builder-config.test.ts`
// (comments aren't valid JSON) and validated against a schema that rejects any unrecognized
// key, so this is the closest place it can live without breaking either.
const targetArch = process.env.WHISPER_DROP_TARGET_ARCH ?? process.arch
if (targetArch !== 'x64' && targetArch !== 'arm64') {
  console.error(`WHISPER_DROP_TARGET_ARCH must be x64 or arm64, received ${targetArch}`)
  process.exit(1)
}
if (targetArch !== process.arch && process.platform !== 'darwin') {
  console.error(
    `Cross-building whisper.cpp for ${targetArch} is only supported on macOS (host is ${process.platform}-${process.arch})`,
  )
  process.exit(1)
}

const target = `${process.platform}-${targetArch}`
// A separate tree per cross-build so a stale CMake cache from the host arch
// cannot leak in. The native case keeps using `build`, unchanged.
const buildDir = targetArch === process.arch ? 'build' : `build-${targetArch}`
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
  '-B', buildDir,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=OFF',
]
if (process.platform === 'darwin') {
  cmakeArgs.push('-DGGML_METAL_EMBED_LIBRARY=ON')
  cmakeArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${targetArch === 'x64' ? 'x86_64' : 'arm64'}`)
}

run('cmake', cmakeArgs, src)
run('cmake', ['--build', buildDir, '--config', 'Release', '-j'], src)

const candidates = [
  join(src, buildDir, 'bin', exe),
  join(src, buildDir, 'bin', 'Release', exe),
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
