import type { JobPhase } from '../shared/types.js'

/** Filename only. Reads a path main supplied; never builds one. */
export function basenameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? filePath
}

/** Whole percent, clamped. Non-finite input reads as 0 rather than NaN%. */
export function formatPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.round(Math.min(1, Math.max(0, progress)) * 100)
}

/** Null when there is nothing honest to show, so the caller renders nothing. */
export function formatEta(etaMs: number | undefined): string | null {
  if (etaMs === undefined || !Number.isFinite(etaMs) || etaMs < 0) return null

  const total = Math.round(etaMs / 1000)
  if (total < 1) return 'less than a second'
  if (total < 60) return `${total} sec`

  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} sec`

  const hours = Math.floor(minutes / 60)
  return `${hours} hr ${minutes % 60} min`
}

/** `4:07`, or `1:02:03` once past an hour. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0:00'

  const total = Math.floor(durationMs / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Measured, never a shipped benchmark. Null when this model has never run. */
export function formatRealtimeFactor(factor: number | undefined): string | null {
  if (factor === undefined || !Number.isFinite(factor) || factor <= 0) return null
  return factor >= 10 ? `${Math.round(factor)}×` : `${factor.toFixed(1)}×`
}

/** Decimal MB/GB, matching how the model sizes are quoted upstream. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 MB'
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  return `${Math.round(bytes / 1_000_000)} MB`
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

const PHASE_LABELS: Record<JobPhase, string> = {
  probing: 'Reading the file',
  preparing: 'Preparing audio',
  transcribing: 'Transcribing',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

export function phaseLabel(phase: JobPhase): string {
  return PHASE_LABELS[phase]
}
