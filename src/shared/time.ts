const TIMESTAMP = /^(\d+):([0-5]\d):([0-5]\d)[.,](\d{3})$/

/**
 * Format milliseconds as `HH:MM:SS,mmm`.
 *
 * SRT uses a comma before the milliseconds; WebVTT uses a period. Hours are
 * zero-padded to two digits but never truncated, so a 100-hour input still
 * round-trips.
 */
export function msToTimestamp(ms: number, msSeparator: ',' | '.' = ','): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`msToTimestamp: expected a non-negative finite number, received ${ms}`)
  }

  const total = Math.round(ms)
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  const millis = total % 1_000

  const pad = (value: number, width = 2) => String(value).padStart(width, '0')

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`
}

/** Parse `HH:MM:SS,mmm` or `HH:MM:SS.mmm` into milliseconds. */
export function timestampToMs(ts: string): number {
  const match = TIMESTAMP.exec(ts.trim())
  if (!match) {
    throw new RangeError(`timestampToMs: malformed timestamp ${JSON.stringify(ts)}`)
  }

  const [, hours, minutes, seconds, millis] = match as unknown as [string, string, string, string, string]

  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000 +
    Number(millis)
  )
}
