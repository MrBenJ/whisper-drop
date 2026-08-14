import type { ModelBaseId, Settings } from '../../shared/types.js'
import { MODEL_BASE_ORDER } from '../models/catalog.js'
import { IpcError } from './errors.js'

export type SettingsDeps = {
  read: () => Promise<Settings>
  write: (patch: Partial<Settings>) => Promise<Settings>
}

export type SettingsHandlers = {
  get(): Promise<Settings>
  set(patch: unknown): Promise<Settings>
}

/** 'auto', or an ISO 639-1 code. Reaches whisper-cli as an argv element. */
const LANGUAGE = /^([a-z]{2}|auto)$/

const WRITABLE_KEYS = new Set(['englishOnly', 'activeModel', 'language'])

function reject(detail: string): never {
  throw new IpcError('INVALID_REQUEST', 'That settings change was not understood.', detail)
}

/**
 * The store re-validates everything it writes, but `throughput` and `version`
 * are not the renderer's to set at all — throughput is measured, not asserted —
 * so unknown and read-only keys are refused here rather than silently dropped.
 */
export function createSettingsHandlers(deps: SettingsDeps): SettingsHandlers {
  async function set(patch: unknown): Promise<Settings> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      reject(`patch must be an object, received ${Object.prototype.toString.call(patch)}`)
    }

    const entries = Object.entries(patch as Record<string, unknown>)
    const clean: Partial<Settings> = {}

    for (const [key, value] of entries) {
      if (!WRITABLE_KEYS.has(key)) reject(`unknown or read-only key ${JSON.stringify(key)}`)

      if (key === 'englishOnly') {
        if (typeof value !== 'boolean') reject('englishOnly must be a boolean')
        clean.englishOnly = value
      }

      if (key === 'activeModel') {
        if (value !== null && !(MODEL_BASE_ORDER as readonly unknown[]).includes(value)) {
          reject(`activeModel must be null or a catalog row, received ${JSON.stringify(value)}`)
        }
        clean.activeModel = value as ModelBaseId | null
      }

      if (key === 'language') {
        if (typeof value !== 'string' || !LANGUAGE.test(value)) {
          reject(`language must be 'auto' or an ISO 639-1 code, received ${JSON.stringify(value)}`)
        }
        clean.language = value
      }
    }

    return deps.write(clean)
  }

  return { get: () => deps.read(), set }
}
