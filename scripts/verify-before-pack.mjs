import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const VERIFY_SCRIPT = fileURLToPath(new URL('./verify-release-binaries.mjs', import.meta.url))
const ARCH_NAMES = new Map([
  [1, 'x64'],
  [3, 'arm64'],
])

/**
 * Stop electron-builder before it can package downloaded tools for a
 * different CPU. This also protects direct local packaging commands, not
 * only the carefully prepared release workflow.
 */
export default async function verifyBeforePack(context) {
  const arch = ARCH_NAMES.get(context.arch)
  if (!arch) {
    throw new Error(`whisper-drop packages only x64 and arm64; received arch id ${context.arch}`)
  }

  try {
    const result = await execFileAsync(process.execPath, [VERIFY_SCRIPT], {
      cwd: context.packager.projectDir,
      env: {
        ...process.env,
        TARGET_ARCH: arch,
        TARGET_PLATFORM: context.electronPlatformName,
      },
    })
    if (result.stdout.trim()) console.log(result.stdout.trim())
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(
      `Cannot package whisper-drop for ${context.electronPlatformName}-${arch}:\n${stderr || error.message}`,
      { cause: error },
    )
  }
}
