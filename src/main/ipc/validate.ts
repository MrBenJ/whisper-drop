import { EXPORT_FORMATS, type ExportFormat, type ModelBaseId } from '../../shared/types.js'
import { MODEL_BASE_ORDER } from '../models/catalog.js'
import { IpcError } from './errors.js'

/** Bounded and quoted: a rejected value is attacker-controlled and ends up in a log. */
function describe(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(value.slice(0, 120))
    : Object.prototype.toString.call(value)
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IpcError(
      'INVALID_REQUEST',
      'That request was not understood.',
      `${field} must be a non-empty string, received ${describe(value)}`,
    )
  }
  return value
}

export function requireModelBaseId(value: unknown): ModelBaseId {
  if (typeof value !== 'string' || !(MODEL_BASE_ORDER as readonly string[]).includes(value)) {
    throw new IpcError(
      'INVALID_REQUEST',
      'That model is not in the catalog.',
      `base=${describe(value)}`,
    )
  }
  return value as ModelBaseId
}

export function requireExportFormat(value: unknown): ExportFormat {
  if (typeof value !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(value)) {
    throw new IpcError(
      'INVALID_REQUEST',
      'That export format is not supported.',
      `format=${describe(value)}`,
    )
  }
  return value as ExportFormat
}
