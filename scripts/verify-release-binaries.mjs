#!/usr/bin/env node
// Guards the release workflow against packaging a binary built for the wrong
// architecture. Three binaries are checked:
//
//   - whisper-cli, which `npm run setup` cross-compiles into
//     resources/<platform>-<arch>/ for the arch the release job asks for.
//   - the ffmpeg-static binary, which is downloaded (not compiled) by
//     ffmpeg-static's own install script, picking exactly one arch based on
//     npm_config_arch/npm_config_platform at install time. A bare `npm ci` on
//     an arm64 GitHub runner fetches an arm64 ffmpeg even for the "macOS x64"
//     matrix leg — the app installs and launches fine, and every transcode
//     fails silently (`spawn … EBADARCH`). See the "Install the ${arch}
//     ffmpeg-static binary" step in release.yml for the fix; this step is
//     what proves that fix actually worked, instead of trusting it.
//   - the @derhuerst/ffprobe-static binary, which follows the same one-binary
//     install model and must be rebuilt for cross-architecture release legs.
//
// Existence alone isn't enough for any binary — all three must match
// TARGET_ARCH specifically, or this fails loudly in CI instead of quietly in
// a client's hands.
import { existsSync, readFileSync } from 'node:fs'

const platform = process.platform
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

// --- Downloaded media binaries: same "missing file" failure mode, plus the
// silent wrong-arch failure mode described above. ---
const ffmpegExe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const ffmpegPath = `node_modules/ffmpeg-static/${ffmpegExe}`
const ffprobeExe = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
const ffprobePath = `node_modules/@derhuerst/ffprobe-static/${ffprobeExe}`

verifyDownloadedBinary(ffmpegPath, 'ffmpeg-static', 'transcode')
verifyDownloadedBinary(ffprobePath, '@derhuerst/ffprobe-static', 'media probe')

if (failed) process.exit(1)

function verifyDownloadedBinary(path, packageName, operation) {
  if (!existsSync(path)) {
    fail(`missing ${path} — ${packageName} did not install a binary`)
    return
  }

  try {
    const detected = detectArch(platform, readFileSync(path))
    if (detected !== arch) {
      fail(
        `${path} is built for ${detected}, expected ${arch} — the wrong ` +
          `${packageName} binary was installed and every ${operation} in this build would fail`,
      )
    } else {
      console.log(`confirmed ${path} is ${detected}`)
    }
  } catch (err) {
    fail(`could not determine ${path}'s architecture: ${err.message}`)
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
