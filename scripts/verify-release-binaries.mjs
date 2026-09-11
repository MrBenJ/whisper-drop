#!/usr/bin/env node
// Guards the release workflow against packaging a wrong or non-redistributable
// media binary. Three binaries, all in resources/<platform>-<arch>/, are checked:
//
//   - whisper-cli, which `npm run setup` cross-compiles for the arch the
//     release job asks for (existence only).
//   - ffmpeg and ffprobe, provisioned by `scripts/build-ffmpeg.mjs` (compiled
//     from source on macOS, downloaded from BtbN on Windows/Linux). Two failure
//     modes are gated here:
//       * wrong architecture — a macOS x64 leg cross-built on an arm64 runner
//         installs and launches fine, then fails every transcode silently
//         (`spawn … EBADARCH`). The arch is read from the binary's own header.
//       * non-redistributable build — an ffmpeg built --enable-gpl/--enable-nonfree
//         must never be packaged or published. The binary's embedded configuration
//         is byte-scanned (never executed, so this works cross-arch too).
//
// Existence alone isn't enough for any binary — all three must match
// TARGET_ARCH, and the media ones must be LGPL-clean, or this fails loudly in
// CI instead of quietly in a client's hands.
import { existsSync, readFileSync } from 'node:fs'
import { assertRedistributableFfmpeg } from './lib/ffmpeg-license.mjs'

const platform = process.env.TARGET_PLATFORM ?? process.platform
if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
  console.error(`TARGET_PLATFORM must be darwin, win32 or linux, received ${platform}`)
  process.exit(1)
}
const arch = process.env.TARGET_ARCH
if (arch !== 'x64' && arch !== 'arm64') {
  console.error(`TARGET_ARCH must be x64 or arm64, received ${arch}`)
  process.exit(1)
}

let failed = false
const fail = (msg) => {
  console.error(msg)
  failed = true
}

// --- whisper-cli: electron-builder only warns when an extraResources source
// is missing, which would ship an installer that cannot transcribe. Fail
// here instead. ---
const cliExe = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
const cliPath = `resources/${platform}-${arch}/${cliExe}`
if (!existsSync(cliPath)) {
  fail(`missing ${cliPath} — electron-builder would package an app that cannot transcribe`)
} else {
  console.log(`found ${cliPath}`)
}

// --- Provisioned media binaries: same "missing file" failure mode, plus the
// silent wrong-arch failure mode and the non-redistributable-build failure
// mode described above. ---
const ffmpegExe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const ffprobeExe = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'

verifyMediaBinary(`resources/${platform}-${arch}/${ffmpegExe}`, 'transcode')
verifyMediaBinary(`resources/${platform}-${arch}/${ffprobeExe}`, 'media probe')

if (failed) process.exit(1)

function verifyMediaBinary(path, operation) {
  if (!existsSync(path)) {
    fail(`missing ${path} — ffmpeg/ffprobe were not provisioned; run scripts/build-ffmpeg.mjs`)
    return
  }

  const buf = readFileSync(path)
  try {
    const detected = detectArch(platform, buf)
    if (detected !== arch) {
      fail(
        `${path} is built for ${detected}, expected ${arch} — every ${operation} in this build would fail`,
      )
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

// Reads the executable header directly rather than shelling out to `file`/
// `lipo`, so this works identically on macOS, Windows and Linux runners
// without depending on which inspection tools happen to be preinstalled.
function detectArch(platform, buf) {
  if (platform === 'darwin') {
    // Mach-O 64-bit thin binary: magic 0xfeedfacf, then a 32-bit CPU type.
    const magic = buf.readUInt32LE(0)
    if (magic !== 0xfeedfacf) throw new Error(`not a 64-bit Mach-O binary (magic 0x${magic.toString(16)})`)
    const cputype = buf.readUInt32LE(4)
    if (cputype === 0x01000007) return 'x64' // CPU_TYPE_X86_64
    if (cputype === 0x0100000c) return 'arm64' // CPU_TYPE_ARM64
    throw new Error(`unrecognized Mach-O cputype 0x${cputype.toString(16)}`)
  }
  if (platform === 'win32') {
    // PE: the DOS header's e_lfanew (at 0x3c) points to "PE\0\0" followed by
    // the COFF header, whose first field is the Machine type.
    const peOffset = buf.readUInt32LE(0x3c)
    const machine = buf.readUInt16LE(peOffset + 4)
    if (machine === 0x8664) return 'x64' // IMAGE_FILE_MACHINE_AMD64
    if (machine === 0xaa64) return 'arm64' // IMAGE_FILE_MACHINE_ARM64
    throw new Error(`unrecognized PE machine type 0x${machine.toString(16)}`)
  }
  // Linux: ELF e_machine is a 2-byte little-endian field at offset 18 (all
  // binaries we ship are little-endian).
  const machine = buf.readUInt16LE(18)
  if (machine === 0x3e) return 'x64' // EM_X86_64
  if (machine === 0xb7) return 'arm64' // EM_AARCH64
  throw new Error(`unrecognized ELF e_machine ${machine}`)
}
