# LGPL ffmpeg Swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bundled nonfree `ffmpeg`/`ffprobe` (from the `ffmpeg-static` and `@derhuerst/ffprobe-static` npm packages) with a redistributable **LGPL** build sourced per-platform, so whisper-drop can publish its first release.

**Architecture:** ffmpeg/ffprobe are provisioned into `resources/<platform>-<arch>/` (next to `whisper-cli`, already shipped via electron-builder `extraResources`) by a new `scripts/build-ffmpeg.mjs` — compiled from FFmpeg source with an LGPL config on macOS, downloaded (checksum-verified) from BtbN's `-lgpl` static builds on Windows/Linux. A byte-scan license gate (no `--enable-gpl`/`--enable-nonfree`) runs on every binary, cross-arch. The npm media deps and their asar-unpack plumbing are removed.

**Tech Stack:** Node 22 ESM scripts, electron-vite + electron-builder, vitest, GitHub Actions. FFmpeg autotools build; BtbN FFmpeg-Builds; whisper.cpp-style manifest + cache pattern.

**Spec:** `docs/superpowers/specs/2026-09-11-ffmpeg-lgpl-swap-design.md`

## Global Constraints

- **Redistributable-only, always.** Every packaged ffmpeg/ffprobe binary's embedded configuration must contain **no `--enable-nonfree`** and **no `--enable-gpl`**. Verified by automated byte-scan, never by eye. A binary that fails is never packaged or uploaded.
- **Never publish a nonfree artifact** — not even a temporary CI artifact. (This session does not run CI; the upload step is restored in YAML but exercised only in the gated release follow-up.)
- **macOS unsigned/un-notarized:** keep `mac.identity: null`, `mac.notarize: false`, and `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` exactly as they are.
- **Release workflow:** keep `fail-fast: false`; the release-publishing job gets `contents: write`, no other job does.
- **Branch/PR only this session.** No `git push`, no `v*` tag, no GitHub Release. Work stays on branch `ffmpeg-lgpl-swap`.
- Node names throughout: `platform` ∈ {`darwin`,`win32`,`linux`}, `arch` ∈ {`arm64`,`x64`}. Directory naming is `${platform}-${arch}`.
- Cross-arch build is **macOS-only** (arm64 host → x64 target); every other platform builds natively.

---

### Task 1: License byte-scan helper

A pure, unit-tested module used by both the provisioning script (self-check) and the release verifier (gate). Scans an ffmpeg/ffprobe binary's bytes for forbidden configure flags without executing it, so it works on cross-arch binaries the host cannot run.

**Files:**
- Create: `scripts/lib/ffmpeg-license.mjs`
- Test: `test/build/ffmpeg-license.test.ts`

**Interfaces:**
- Produces:
  - `FORBIDDEN_FLAGS: readonly string[]` = `['--enable-nonfree', '--enable-gpl']`
  - `scanFfmpegLicense(buffer: Buffer): { hasConfig: boolean; forbidden: string[] }`
  - `assertRedistributableFfmpeg(buffer: Buffer, label: string): void` — throws `Error` if `hasConfig` is false or `forbidden` is non-empty.

- [ ] **Step 1: Write the failing test**

```ts
// test/build/ffmpeg-license.test.ts
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_FLAGS,
  scanFfmpegLicense,
  assertRedistributableFfmpeg,
} from '../../scripts/lib/ffmpeg-license.mjs'

// The copyright banner FFmpeg compiles into every ffmpeg/ffprobe binary; its
// presence is how we know we're scanning a real ffmpeg build and not some
// unrelated file that trivially lacks the forbidden flags.
const BANNER = 'the FFmpeg developers'

function fakeBinary(configLine: string): Buffer {
  return Buffer.from(`\x00\x00${BANNER}\x00configuration: ${configLine}\x00\x00`, 'latin1')
}

describe('scanFfmpegLicense', () => {
  it('flags a build with the two forbidden flags in its config', () => {
    const buf = fakeBinary('--prefix=/x --enable-gpl --enable-version3 --enable-nonfree')
    const { hasConfig, forbidden } = scanFfmpegLicense(buf)
    expect(hasConfig).toBe(true)
    expect(forbidden.sort()).toEqual([...FORBIDDEN_FLAGS].sort())
  })

  it('passes a clean LGPL build', () => {
    const buf = fakeBinary('--prefix=/x --disable-shared --enable-static')
    const { hasConfig, forbidden } = scanFfmpegLicense(buf)
    expect(hasConfig).toBe(true)
    expect(forbidden).toEqual([])
  })

  it('reports hasConfig=false for a buffer with no ffmpeg banner', () => {
    expect(scanFfmpegLicense(Buffer.from('not an ffmpeg binary')).hasConfig).toBe(false)
  })
})

describe('assertRedistributableFfmpeg', () => {
  it('throws naming each forbidden flag', () => {
    const buf = fakeBinary('--enable-gpl --enable-nonfree')
    expect(() => assertRedistributableFfmpeg(buf, 'darwin-arm64/ffmpeg')).toThrow(
      /darwin-arm64\/ffmpeg.*--enable-nonfree/,
    )
  })

  it('throws when the binary is not recognizably ffmpeg', () => {
    expect(() => assertRedistributableFfmpeg(Buffer.from('junk'), 'x/ffmpeg')).toThrow(
      /no embedded ffmpeg configuration/i,
    )
  })

  it('returns for a clean LGPL build', () => {
    expect(() =>
      assertRedistributableFfmpeg(fakeBinary('--disable-shared --enable-static'), 'x/ffmpeg'),
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/build/ffmpeg-license.test.ts`
Expected: FAIL — cannot resolve `../../scripts/lib/ffmpeg-license.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/ffmpeg-license.mjs
// FFmpeg compiles its full ./configure line into every binary (FFMPEG_CONFIGURATION),
// alongside a copyright banner. We scan those bytes directly rather than executing
// the binary, so the check works even on a cross-arch binary this host can't run.

export const FORBIDDEN_FLAGS = Object.freeze(['--enable-nonfree', '--enable-gpl'])

// Proof we're looking at a real ffmpeg/ffprobe build: absent this, a stripped or
// unrelated file would pass the forbidden-flag check simply by not containing them.
const BANNER = 'the FFmpeg developers'

export function scanFfmpegLicense(buffer) {
  const text = buffer.toString('latin1')
  return {
    hasConfig: text.includes(BANNER),
    forbidden: FORBIDDEN_FLAGS.filter((flag) => text.includes(flag)),
  }
}

export function assertRedistributableFfmpeg(buffer, label) {
  const { hasConfig, forbidden } = scanFfmpegLicense(buffer)
  if (!hasConfig) {
    throw new Error(
      `${label}: no embedded ffmpeg configuration string found — cannot confirm this is a redistributable LGPL build`,
    )
  }
  if (forbidden.length > 0) {
    throw new Error(
      `${label}: non-redistributable build flags present in the binary's configuration: ${forbidden.join(', ')}`,
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/build/ffmpeg-license.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ffmpeg-license.mjs test/build/ffmpeg-license.test.ts
git commit -m "feat: add ffmpeg license byte-scan gate"
```

---

### Task 2: ffmpeg manifest + provisioning script (compile macOS host binary)

Pin sources in `ffmpeg.manifest.json` and add `scripts/build-ffmpeg.mjs`, mirroring `whisper.manifest.json` + `build-whisper.mjs`. Then actually provision the host (darwin-arm64) binaries and self-verify them with Task 1's gate. Wire `npm run setup` to provision ffmpeg too.

This task's "test" is running the script to completion and confirming real, license-clean binaries land in `resources/darwin-arm64/`. (Provisioning scripts are integration-verified, not unit-tested.)

**Files:**
- Create: `ffmpeg.manifest.json`
- Create: `scripts/build-ffmpeg.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `assertRedistributableFfmpeg` from Task 1.
- Produces: `resources/${platform}-${arch}/{ffmpeg,ffprobe}[.exe]` and a `resources/${platform}-${arch}/.ffmpeg-tag` stamp. `npm run build-ffmpeg` (host) and `npm run setup` (whisper + ffmpeg host).

- [ ] **Step 1: Write the manifest (macOS source pinned; win/linux checksums filled in Step 4)**

```json
// ffmpeg.manifest.json
{
  "ffmpegRepo": "https://github.com/FFmpeg/FFmpeg.git",
  "ffmpegTag": "n7.1.1",
  "btbn": {
    "release": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest",
    "assets": {
      "win32-x64": {
        "filename": "ffmpeg-master-latest-win64-lgpl.zip",
        "sha256": "FILL_IN_STEP_4"
      },
      "linux-x64": {
        "filename": "ffmpeg-master-latest-linux64-lgpl.tar.xz",
        "sha256": "FILL_IN_STEP_4"
      }
    }
  }
}
```

Note for the implementer: BtbN's `latest` release is a rolling tag. Confirm the two `*-lgpl` asset filenames still exist on that release page before Step 4 and correct them here if BtbN has renamed them. (Pinning to an immutable dated `autobuild-*` tag instead is a valid hardening — do it if that tag's assets are available.)

- [ ] **Step 2: Write `scripts/build-ffmpeg.mjs`**

```js
#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
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
  console.error(`Cross-building ffmpeg for ${targetArch} is only supported on macOS (host is ${platform}-${process.arch})`)
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

if (existsSync(ffmpegOut) && existsSync(ffprobeOut) && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stampValue) {
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
  for (const cmd of ['cmake' === 'cmake' ? 'make' : 'make', 'git']) {
    if (spawnSync(cmd, ['--version']).error) {
      console.error(`Missing required command: ${cmd} (needed to build ffmpeg from source)`) // brew install make/git; Xcode CLT provides clang+make
      process.exit(1)
    }
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

  // LGPL, decode-focused, self-contained. The redistributability of the result
  // is that --enable-gpl and --enable-nonfree are NEVER added (both default off).
  const configure = [
    '--disable-shared', '--enable-static',
    '--disable-doc', '--disable-htmlpages', '--disable-manpages', '--disable-podpages', '--disable-txtpages',
    '--disable-ffplay', '--enable-ffmpeg', '--enable-ffprobe',
    '--disable-network',
    '--enable-audiotoolbox', // system-framework decoders on macOS; still LGPL
  ]
  const env = { ...process.env }
  if (targetArch !== process.arch) {
    // arm64 host → x64 target cross-build.
    configure.push('--enable-cross-compile', '--arch=x86_64', '--cc=clang -arch x86_64', '--extra-cflags=-arch x86_64', '--extra-ldflags=-arch x86_64', '--target-os=darwin')
  }
  run(join(src, 'configure'), configure, buildDir, env)
  run('make', ['-j', String(cpuCount())], buildDir, env)

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

  if (!existsSync(archive)) {
    console.log(`Downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok || !res.body) {
      console.error(`Download failed: HTTP ${res.status}`)
      process.exit(1)
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${archive}.part`))
    const digest = createHash('sha256').update(readFileSync(`${archive}.part`)).digest('hex')
    if (digest !== asset.sha256) {
      rmSync(`${archive}.part`, { force: true })
      console.error(`Checksum mismatch for ${asset.filename}: expected ${asset.sha256}, got ${digest}`)
      process.exit(1)
    }
    copyFileSync(`${archive}.part`, archive)
    rmSync(`${archive}.part`, { force: true })
  } else {
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
    if (digest !== asset.sha256) {
      console.error(`Cached ${asset.filename} checksum mismatch; delete .cache/ffmpeg-downloads and retry`)
      process.exit(1)
    }
  }

  // bsdtar (`tar`) extracts both .zip and .tar.xz on macOS, Linux and modern Windows.
  const extractDir = join(dlDir, `extract-${target}`)
  rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })
  run('tar', ['-xf', archive, '-C', extractDir])

  copyExecutable(findUnder(extractDir, `ffmpeg${exe}`), ffmpegOut)
  copyExecutable(findUnder(extractDir, `ffprobe${exe}`), ffprobeOut)
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

function cpuCount() {
  return Math.max(1, Number(process.env.NUMBER_OF_PROCESSORS) || require('node:os').cpus().length || 2)
}

function run(cmd, args, cwd = ROOT, env = process.env) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env })
}
```

Implementer notes:
- `cpuCount()` uses `require`; in an ESM file replace with `import { cpus } from 'node:os'` at top and `cpus().length`. Fix that during implementation (kept explicit here so the parallelism intent is visible).
- The `for (const cmd of [...])` prereq loop is written awkwardly above; simplify to `for (const cmd of ['make', 'git'])`.

- [ ] **Step 3: Wire `package.json` scripts**

Modify the `scripts` block:
```json
    "setup": "node scripts/build-whisper.mjs && node scripts/build-ffmpeg.mjs",
    "build-ffmpeg": "node scripts/build-ffmpeg.mjs",
```

- [ ] **Step 4: Provision + fill checksums (real run on this Mac)**

```bash
# Compile the host (arm64) ffmpeg/ffprobe — several minutes:
node scripts/build-ffmpeg.mjs
# Confirm they exist and are license-clean by executing the REAL host binary:
resources/darwin-arm64/ffmpeg -version | head -3
# The "configuration:" line must contain neither --enable-gpl nor --enable-nonfree.

# Fill the two BtbN checksums WITHOUT executing those binaries (safe on macOS):
for f in ffmpeg-master-latest-win64-lgpl.zip ffmpeg-master-latest-linux64-lgpl.tar.xz; do
  curl -fsSL -o "/tmp/$f" "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$f"
  shasum -a 256 "/tmp/$f"
done
# Paste each hash into ffmpeg.manifest.json's matching sha256 field.
# Then sanity-check the win/linux binaries are LGPL by byte-scan (no exec):
node -e "import('./scripts/lib/ffmpeg-license.mjs').then(async m=>{const {execFileSync}=await import('node:child_process');const {mkdtempSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');for(const [f,inner] of [['/tmp/ffmpeg-master-latest-win64-lgpl.zip','ffmpeg.exe'],['/tmp/ffmpeg-master-latest-linux64-lgpl.tar.xz','ffmpeg']]){const d=mkdtempSync(join(tmpdir(),'ff-'));execFileSync('tar',['-xf',f,'-C',d]);const {execSync}=await import('node:child_process');const p=execSync(\`find \${d} -name \${inner} -type f | head -1\`).toString().trim();m.assertRedistributableFfmpeg(readFileSync(p),f);console.log('OK',f)}})"
```
Expected: the local ffmpeg prints a configuration line free of `--enable-gpl`/`--enable-nonfree`; both BtbN archives byte-scan clean; manifest checksums filled.

- [ ] **Step 5: Commit**

```bash
git add ffmpeg.manifest.json scripts/build-ffmpeg.mjs package.json
git commit -m "feat: provision LGPL ffmpeg/ffprobe per platform"
```

---

### Task 3: Cutover — resources-based path resolution, drop npm media deps

Atomic cutover: `binaries.ts` resolves ffmpeg/ffprobe from `resources/`, the npm deps and their asar-unpack plumbing are removed, and every test that touched the old plumbing is updated in the same task (removing the deps breaks `app-icon.test.ts`'s `import … from 'ffmpeg-static'`, so it can't be split out).

**Files:**
- Modify: `src/main/binaries.ts`
- Delete: `src/types/ffmpeg-static.d.ts`
- Modify: `electron-builder.json` (remove `asarUnpack`)
- Modify: `package.json` (remove two dependencies)
- Modify: `test/main/binaries.test.ts`
- Modify: `test/build/electron-builder-config.test.ts`
- Modify: `test/build/app-icon.test.ts`

**Interfaces:**
- Consumes: `resolveResourcesDir` (unchanged).
- Produces: `ffmpegPath()` / `ffprobePath()` resolving to `resolveResourcesDir(currentEnv())/{ffmpeg,ffprobe}[.exe]`. `unpackedPath` and `ASAR_SEGMENT` no longer exported/exist.

- [ ] **Step 1: Update the failing tests first**

In `test/main/binaries.test.ts`:
- Remove `unpackedPath` from the import list (line ~11) and delete the entire `describe('unpackedPath', …)` block (lines ~130–157).
- Replace the `describe('media binaries', …)` block so ffmpeg/ffprobe are treated like whisper-cli — present only after `npm run setup`, and checked for the process arch. Use the existing `whisperCliBuilt`-style skip:

```ts
const ffmpegBuilt = existsSync(ffmpegPath())

describe('media binaries', () => {
  it('resolves ffmpeg and ffprobe under resources/<platform>-<arch>', () => {
    expect(ffmpegPath()).toContain(join('resources', `${process.platform}-${process.arch}`))
    expect(ffprobePath()).toContain(join('resources', `${process.platform}-${process.arch}`))
  })

  it.skipIf(!ffmpegBuilt)(
    ffmpegBuilt
      ? 'resolves ffmpeg/ffprobe to files that exist once npm run setup has run'
      : 'resolves ffmpeg/ffprobe to files that exist once npm run setup has run (skipped: run `npm run setup`)',
    () => {
      expect(existsSync(ffmpegPath())).toBe(true)
      expect(existsSync(ffprobePath())).toBe(true)
    },
  )

  it.skipIf(!ffmpegBuilt || (process.arch !== 'arm64' && process.arch !== 'x64'))(
    'resolves ffprobe to a binary built for the current process architecture',
    () => {
      const binary = readFileSync(ffprobePath())
      let detected: 'arm64' | 'x64' | undefined
      if (process.platform === 'darwin') {
        const cpuType = binary.readUInt32LE(4)
        if (cpuType === 0x0100000c) detected = 'arm64'
        if (cpuType === 0x01000007) detected = 'x64'
      } else if (process.platform === 'win32') {
        const peOffset = binary.readUInt32LE(0x3c)
        const machine = binary.readUInt16LE(peOffset + 4)
        if (machine === 0xaa64) detected = 'arm64'
        if (machine === 0x8664) detected = 'x64'
      } else if (process.platform === 'linux') {
        const machine = binary.readUInt16LE(18)
        if (machine === 0xb7) detected = 'arm64'
        if (machine === 0x3e) detected = 'x64'
      }
      expect(detected).toBe(process.arch)
    },
  )
})
```
(Add `import { join } from 'node:path'` if not already present — it is, at line 2.)

In `test/build/electron-builder-config.test.ts`:
- In the CONFIG type, change `asarUnpack: string[]` to `asarUnpack?: string[]`.
- Delete the two `it('unpacks …')` tests (lines ~42–48). Replace with one asserting the media packages are no longer referenced:
```ts
  it('no longer asar-unpacks npm media binaries (they ship via extraResources)', () => {
    expect(CONFIG.asarUnpack ?? []).toEqual([])
  })
```
- Keep the `'keeps asar on'` test.

In `test/build/app-icon.test.ts`:
- Replace `import ffmpegPath from 'ffmpeg-static'` with `import { ffmpegPath } from '../../src/main/binaries.js'` and `import { existsSync } from 'node:fs'` (already imported).
- The monogram test execs ffmpeg. Guard it so it skips when the binary isn't provisioned yet (the unit-test CI job doesn't run setup):
```ts
  it.skipIf(!existsSync(ffmpegPath()))('keeps the monogram legible at Dock scale', () => {
    const rgba = execFileSync(ffmpegPath(), [
      '-v', 'error',
      '-i', `${ROOT}/build/icons/32x32.png`,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
    ])
    // …existing assertion body unchanged…
  })
```
(`ffmpegPath()` is a function now; drop the old `if (!ffmpegPath) throw` guard.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/main/binaries.test.ts test/build/electron-builder-config.test.ts test/build/app-icon.test.ts`
Expected: FAIL — `binaries.ts` still exports `unpackedPath` (import removed) / still imports `ffmpeg-static`; config still has `asarUnpack`.

- [ ] **Step 3: Rewrite `src/main/binaries.ts`**

- Delete the top imports of `ffprobeStatic` and `ffmpegStatic` (lines 3–4).
- Delete `ASAR_SEGMENT` (line ~84) and the `unpackedPath` function (lines ~86–95).
- Replace `ffmpegPath()` and `ffprobePath()` (lines ~105–125) with resources-based resolvers, and add pure `resolveFfmpegPath`/`resolveFfprobePath(env)` mirroring `resolveWhisperCliPath`:

```ts
export function resolveFfmpegPath(env: BinaryEnv): string {
  const exe = env.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  return join(resolveResourcesDir(env), exe)
}

export function resolveFfprobePath(env: BinaryEnv): string {
  const exe = env.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return join(resolveResourcesDir(env), exe)
}

export function ffmpegPath(): string {
  return resolveFfmpegPath(currentEnv())
}

export function ffprobePath(): string {
  return resolveFfprobePath(currentEnv())
}
```
(`AppError` import becomes unused — remove it. The old "did not resolve a binary" errors are gone: an absent binary now surfaces as spawn ENOENT at the call site, exactly as `whisper-cli` already does.)

- [ ] **Step 4: Delete the shim + update config + deps**

```bash
git rm src/types/ffmpeg-static.d.ts
npm uninstall ffmpeg-static @derhuerst/ffprobe-static
```
In `electron-builder.json`, delete the `"asarUnpack": [ … ]` line entirely.

- [ ] **Step 5: Run the tests + typecheck to verify they pass**

Run: `npm run typecheck && npx vitest run test/main/binaries.test.ts test/build/electron-builder-config.test.ts test/build/app-icon.test.ts`
Expected: PASS (media-binary existence tests run since Task 2 provisioned them; typecheck clean with no `ffmpeg-static` module).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: resolve ffmpeg/ffprobe from resources, drop npm media deps"
```

---

### Task 4: Release verifier — new paths + license gate

Point `verify-release-binaries.mjs` at `resources/<target>/` and add the byte-scan license gate, so packaging fails on a wrong-arch OR non-redistributable binary. Update its test in lockstep.

**Files:**
- Modify: `scripts/verify-release-binaries.mjs`
- Modify: `test/build/verify-release-binaries.test.ts`

**Interfaces:**
- Consumes: `assertRedistributableFfmpeg` (Task 1); `TARGET_PLATFORM`/`TARGET_ARCH` env (unchanged).

- [ ] **Step 1: Update the test first**

In `test/build/verify-release-binaries.test.ts`, rework `releaseFixture` so ffmpeg/ffprobe live beside whisper-cli in `resources/<platform>-<arch>/`, and their fixture bytes carry the ffmpeg banner (so the license gate sees a real-looking binary) plus an optional forbidden flag:

```ts
const FFMPEG_BANNER = 'the FFmpeg developers'

// Reuse the arch header, then append the strings the license byte-scan looks for.
function mediaBinary(platform: NodeJS.Platform, arch: 'arm64' | 'x64', configLine: string): Buffer {
  return Buffer.concat([
    executableHeader(platform, arch),
    Buffer.from(`\x00${FFMPEG_BANNER}\x00configuration: ${configLine}\x00`, 'latin1'),
  ])
}

type ReleaseFixtureOptions = {
  ffmpegArch?: 'arm64' | 'x64'
  ffprobeArch?: 'arm64' | 'x64'
  omit?: 'ffmpeg' | 'ffprobe'
  ffmpegConfig?: string // default a clean LGPL line
}

async function releaseFixture(options: ReleaseFixtureOptions = {}) {
  const targetArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ffmpegArch = options.ffmpegArch ?? targetArch
  const ffprobeArch = options.ffprobeArch ?? targetArch
  const cleanConfig = '--prefix=/x --disable-shared --enable-static'
  const root = await mkdtemp(join(tmpdir(), 'whisper-drop-release-'))
  const resDir = join(root, 'resources', `${process.platform}-${targetArch}`)
  await mkdir(resDir, { recursive: true })
  const exe = process.platform === 'win32' ? '.exe' : ''
  const writes = [
    writeFile(join(resDir, `whisper-cli${exe}`), executableHeader(process.platform, targetArch)),
  ]
  if (options.omit !== 'ffmpeg') {
    writes.push(writeFile(join(resDir, `ffmpeg${exe}`), mediaBinary(process.platform, ffmpegArch, options.ffmpegConfig ?? cleanConfig)))
  }
  if (options.omit !== 'ffprobe') {
    writes.push(writeFile(join(resDir, `ffprobe${exe}`), mediaBinary(process.platform, ffprobeArch, cleanConfig)))
  }
  await Promise.all(writes)
  return { root, targetArch }
}
```

Update the existing describe cases' regexes to the new `resources/...` paths, and add a license case:
- "accepts a release whose three executables match the target" — unchanged call, still resolves.
- wrong-arch cases: change the expected `stderr` regex from `${packageName}.*is built for` to match the new path, e.g. `new RegExp(\`resources/.*ffmpeg${exe ? '\\\\.exe' : ''}.*is built for\`)` for ffmpeg and the ffprobe equivalent. (Keep the `.each` but key it on `'ffmpeg'`/`'ffprobe'` filenames instead of package names.)
- missing cases: expect `missing .*resources/.*(ffmpeg|ffprobe)`.
- **New case:** a release whose ffmpeg was built nonfree is rejected:
```ts
  it.skipIf(!supportedHost)('rejects a release whose ffmpeg is a nonfree build', async () => {
    const { root, targetArch } = await releaseFixture({ ffmpegConfig: '--enable-gpl --enable-nonfree' })
    await expect(
      execFileAsync(process.execPath, [SCRIPT], { cwd: root, env: { ...process.env, TARGET_ARCH: targetArch } }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/--enable-nonfree/) })
  })
```
Also update the `verify-before-pack` describe's fixture use (it calls `releaseFixture({ ffprobeArch: wrongArch })`) — its expected regex becomes `/resources\/.*ffprobe.*is built for/`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/build/verify-release-binaries.test.ts`
Expected: FAIL — script still reads `node_modules/...` and does no license scan.

- [ ] **Step 3: Update `scripts/verify-release-binaries.mjs`**

- Add at top: `import { assertRedistributableFfmpeg } from './lib/ffmpeg-license.mjs'`.
- Replace the media-binary path block (lines ~51–59) so both come from `resources/${platform}-${arch}/`:
```js
const dir = `resources/${platform}-${arch}`
const ffmpegExe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const ffprobeExe = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
verifyMediaBinary(`${dir}/${ffmpegExe}`, 'transcode')
verifyMediaBinary(`${dir}/${ffprobeExe}`, 'media probe')
```
- Rename `verifyDownloadedBinary` → `verifyMediaBinary(path, operation)` and, after the existing arch check, add the license gate:
```js
function verifyMediaBinary(path, operation) {
  if (!existsSync(path)) {
    fail(`missing ${path} — ffmpeg/ffprobe were not provisioned; run scripts/build-ffmpeg.mjs`)
    return
  }
  const buf = readFileSync(path)
  try {
    const detected = detectArch(platform, buf)
    if (detected !== arch) {
      fail(`${path} is built for ${detected}, expected ${arch} — every ${operation} in this build would fail`)
      return
    }
    console.log(`confirmed ${path} is ${detected}`)
  } catch (err) {
    fail(`could not determine ${path}'s architecture: ${err.message}`)
    return
  }
  try {
    assertRedistributableFfmpeg(buf, path)
    console.log(`confirmed ${path} is a redistributable LGPL build`)
  } catch (err) {
    fail(err.message)
  }
}
```
- Update the header comment block (lines 1–20) to describe the two `resources/`-based media binaries and the license gate instead of the npm-download story.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/build/verify-release-binaries.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-release-binaries.mjs test/build/verify-release-binaries.test.ts
git commit -m "feat: verify ffmpeg from resources and gate its license at pack time"
```

---

### Task 5: Licenses screen — LGPL rewrite

Rewrite the FFmpeg entry in the in-app Licenses data to state the LGPL build and where its corresponding source + build configuration are obtained (LGPL's offer requirement), and update its test.

**Files:**
- Modify: `src/renderer/licenses.ts`
- Modify: `test/renderer/licenses.test.ts`

- [ ] **Step 1: Update the test first**

The existing name assertion (`'FFmpeg (ffmpeg and ffprobe)'`) and the `separate executable` note assertion both still hold — keep them. Add assertions locking in the LGPL swap:
```ts
  it('describes ffmpeg as an LGPL build, not a nonfree one', () => {
    const ffmpeg = LICENSES.find((entry) => entry.name.startsWith('FFmpeg'))
    expect(ffmpeg?.license).toMatch(/LGPL/)
    expect(ffmpeg?.license).not.toMatch(/nonfree/i)
    expect(ffmpeg?.note).not.toMatch(/nonfree/i)
  })

  it('offers where the corresponding ffmpeg source and build config can be obtained', () => {
    const ffmpeg = LICENSES.find((entry) => entry.name.startsWith('FFmpeg'))
    expect(ffmpeg?.note).toMatch(/source/i)
    expect(ffmpeg?.note).toMatch(/BtbN|configure|configuration/)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/renderer/licenses.test.ts`
Expected: FAIL — current license says nonfree.

- [ ] **Step 3: Rewrite the FFmpeg entry in `src/renderer/licenses.ts`**

Replace the entry (lines ~32–40) with:
```ts
  {
    name: 'FFmpeg (ffmpeg and ffprobe)',
    license: 'LGPL-2.1-or-later',
    url: 'https://ffmpeg.org/legal.html',
    note: "Reads your file and converts its audio to the format the transcriber needs. whisper-drop bundles a redistributable LGPL build — configured without --enable-gpl or --enable-nonfree — and invokes it as a separate executable, linking against no part of it. The corresponding source and the exact build configuration are available: on macOS it is compiled from FFmpeg's tagged source (see ffmpeg.manifest.json and scripts/build-ffmpeg.mjs in the repository); on Windows and Linux it is BtbN's published LGPL static build (github.com/BtbN/FFmpeg-Builds).",
  },
```
(Verify against Step 4 of Task 2 that `LGPL-2.1-or-later` matches the actual banner; adjust the SPDX string if the compiled/BtbN build reports a different LGPL version.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/renderer/licenses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/licenses.ts test/renderer/licenses.test.ts
git commit -m "docs: state LGPL ffmpeg build in the Licenses screen"
```

---

### Task 6: Workflows — release.yml and ci.yml

Wire the new provisioning into both workflows, restore the release upload, and add release publication. Not runnable this session; validate by YAML-parsing and careful review. **Do not run either workflow.**

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Edit `release.yml`**

1. Delete the entire `Install the ${{ matrix.arch }} ffmpeg and ffprobe binaries` step (lines ~71–92) — the npm packages are gone.
2. Add an ffmpeg manifest read + a per-target ffmpeg cache, then a provision step, before the `Verify` step. After the whisper cache block:
```yaml
      - name: Read ffmpeg build id
        id: ffmpeg
        shell: bash
        run: echo "id=$(node -p "const m=require('./ffmpeg.manifest.json'); process.env.WD==='darwin'?m.ffmpegTag:m.btbn.assets[process.env.SLUG].filename" )" >> "$GITHUB_OUTPUT"
        env:
          WD: ${{ matrix.platform }}
          SLUG: ${{ matrix.platform }}-${{ matrix.arch }}

      - name: Cache provisioned ffmpeg
        uses: actions/cache@v4
        with:
          path: resources/${{ matrix.platform }}-${{ matrix.arch }}
          key: ${{ runner.os }}-ffmpeg-${{ matrix.arch }}-${{ steps.ffmpeg.outputs.id }}

      - name: Provision the ${{ matrix.arch }} ffmpeg and ffprobe
        run: node scripts/build-ffmpeg.mjs
        env:
          WHISPER_DROP_TARGET_ARCH: ${{ matrix.arch }}
```
   Note: the whisper cache already caches `resources/`; that's fine — this adds an ffmpeg-keyed layer, and `build-ffmpeg.mjs` is a no-op when the stamp matches.
3. Leave the `Verify …` step as-is (it now also license-gates via Task 4).
4. **Restore the upload step verbatim** from the comment block (lines ~164–169), un-commented, as the last step of the `package` job:
```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: whisper-drop-${{ matrix.slug }}
          path: ${{ matrix.artifacts }}
          if-no-files-found: error
          retention-days: 14
```
5. Update the top-of-file comment block (lines ~10–15) to say artifacts are now retained and releases are published, since ffmpeg is LGPL.
6. Add a second job that publishes a GitHub Release on tags only:
```yaml
  release:
    name: Publish GitHub Release
    needs: package
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts
          merge-multiple: true
      - name: Create the release with all platform assets
        uses: softprops/action-gh-release@v2
        with:
          files: artifacts/*
          fail_on_unmatched_files: true
          draft: true
```
   (Draft-first is a deliberate safety margin: a human flips it to published after the manual smoke check. Note this choice in the PR description.)

- [ ] **Step 2: Edit `ci.yml` so integration + e2e provision ffmpeg**

Both the `integration` and `e2e` jobs run `npm run setup`, which now also provisions ffmpeg (Linux → fast BtbN download). Extend their `resources/` cache key so a stale ffmpeg can't survive a manifest bump. In each job, change the whisper cache key line to also include the ffmpeg asset id:
```yaml
      - name: Read ffmpeg build id
        id: ffmpeg
        run: echo "id=$(node -p "require('./ffmpeg.manifest.json').btbn.assets['linux-x64'].filename")" >> "$GITHUB_OUTPUT"
      # …then in the "Cache compiled whisper binary" step, append to the key:
          key: ${{ runner.os }}-whisper-${{ steps.manifest.outputs.tag }}-x64-ffmpeg-${{ steps.ffmpeg.outputs.id }}
```
The `test` (unit) job runs no setup and needs no change — the unit tests skip media-binary assertions when the binary is absent (Tasks 3 & 5).

- [ ] **Step 3: Validate YAML parses**

Run:
```bash
node -e "for (const f of ['.github/workflows/release.yml','.github/workflows/ci.yml']) { const {execFileSync}=require('node:child_process'); execFileSync('node',['-e',\`require('node:fs').readFileSync('\${f}','utf8')\`]); } console.log('read ok')"
npx --yes js-yaml .github/workflows/release.yml >/dev/null && npx --yes js-yaml .github/workflows/ci.yml >/dev/null && echo "yaml ok"
```
Expected: `yaml ok` (both files parse).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/ci.yml
git commit -m "ci: provision LGPL ffmpeg, restore upload, publish release on tags"
```

---

### Task 7: README

Resolve the blocker sections and align install instructions with the real release assets.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the affected sections**

- **Releases** (lines ~143–161): state that releases are now published on `v*` tags with artifacts for all four targets; drop the "retains no artifacts" / ffmpeg-static reinstall paragraph. Keep the manual smoke-check subsection.
- **Licenses → ffmpeg bullet** (lines ~196–203): replace the nonfree paragraph with the LGPL story — a redistributable LGPL build (no `--enable-gpl`/`--enable-nonfree`), invoked as a separate executable, corresponding source/config available (compiled from source on macOS per `ffmpeg.manifest.json`/`scripts/build-ffmpeg.mjs`; BtbN LGPL static build on Windows/Linux).
- **Before publishing releases** (lines ~205–225): replace with a short resolved note: the blocker is resolved by **option 1 (bundle an LGPL build)**; summarize how (per-platform sourcing + the automated no-nonfree/no-gpl gate in `scripts/verify-release-binaries.mjs`).
- **Building from source** (~121–131): `npm run setup` now also provisions ffmpeg; the "Prerequisites" already list cmake/git — add a one-liner that `make` + a C toolchain (Xcode Command Line Tools on macOS) are needed for the ffmpeg compile on macOS.
- Confirm the install sections already match the real assets: macOS `.dmg` (arm64 + x64), Windows NSIS `.exe`, Linux `.AppImage` + `.deb`. They do — no change unless a mismatch is found.

- [ ] **Step 2: Sanity-check no stale nonfree claims remain**

Run: `grep -n "nonfree\|ffmpeg-static\|retains no\|not legally redistributable" README.md`
Expected: no matches (or only historical context deliberately kept).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: resolve ffmpeg release blocker in README"
```

---

### Task 8: Full local verification

Prove the swap end to end on this arm64 Mac.

**Files:** none (verification only).

- [ ] **Step 1: Static + unit**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all unit tests pass (media-binary + app-icon ffmpeg tests run, not skipped, because Task 2 provisioned the binaries).

- [ ] **Step 2: Integration + e2e**

Run: `npm run test:integration && npm run test:e2e`
Expected: both pass, exercising the real compiled LGPL ffmpeg/ffprobe.

- [ ] **Step 3: Real transcodes through the packaged app**

```bash
npm run build
npx electron-builder --mac --arm64 --publish never
```
Then install the produced `dist/*.dmg`, launch it, and transcribe **one `.m4a`** and **one `.mp4`** end to end. Confirm each yields a transcript (the point is to catch a failure that only appears once ffmpeg actually runs from the packaged app). The `beforePack` hook (`verify-before-pack.mjs`) must pass, including the new license gate.

- [ ] **Step 4: Record results, do not release**

Note the outcomes for the PR description. **Stop here** — no `git push`, no tag, no GitHub Release (out of session scope).

---

## Self-Review

**Spec coverage:**
- Manifest + per-platform sourcing (compile macOS / BtbN win-linux) → Task 2. ✓
- Drop npm deps, delete `ffmpeg-static.d.ts`, remove asarUnpack, resources-based `binaries.ts` → Task 3. ✓
- Verify scripts new paths + automated license gate → Tasks 1 (gate) + 4 (wiring). ✓
- `licenses.ts` LGPL + source offer → Task 5. ✓
- `release.yml` (remove reinstall, provision, restore upload, release job, keep fail-fast/unsigned) + `ci.yml` provisioning → Task 6. ✓
- README (Releases, Licenses, Before-publishing, build prereqs) → Task 7. ✓
- Local test/transcode verification → Task 8. ✓
- Hard constraints (no nonfree artifact, unsigned, branch/PR only) → Global Constraints + Task 6 (draft release, upload gated behind the license check) + session scope. ✓

**Placeholder scan:** The manifest's two `sha256` values are `FILL_IN_STEP_4` — resolved by an explicit command in Task 2 Step 4 that downloads the assets and computes the hashes. This is a data-collection step with exact commands, not an unresolved design decision. The two `build-ffmpeg.mjs` implementer notes (ESM `cpus()` and the prereq-loop tidy) are flagged inline with the fix. No vague "add error handling"/"write tests" placeholders remain.

**Type consistency:** `assertRedistributableFfmpeg(buffer, label)` / `scanFfmpegLicense(buffer)` / `FORBIDDEN_FLAGS` are defined in Task 1 and consumed with those exact signatures in Tasks 2 and 4. `resolveFfmpegPath`/`resolveFfprobePath`/`ffmpegPath`/`ffprobePath` (Task 3) are used by the tests in Task 3 and the app code unchanged. `resources/${platform}-${arch}` naming is identical across Tasks 2, 3, 4, 6.

**Honest limit (carried from spec):** only darwin-arm64 is compiled and fully run this session. The macOS-x64 cross-build, the Windows/Linux BtbN fetch+package, and the four-leg CI matrix are implemented but exercised only in the gated release follow-up.
