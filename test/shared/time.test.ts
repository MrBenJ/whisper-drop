import { describe, expect, it } from 'vitest'
import { msToTimestamp, timestampToMs } from '../../src/shared/time.js'

describe('msToTimestamp', () => {
  it('formats zero', () => {
    expect(msToTimestamp(0)).toBe('00:00:00,000')
  })

  it('formats hours, minutes, seconds and milliseconds', () => {
    expect(msToTimestamp(3_661_500)).toBe('01:01:01,500')
  })

  it('crosses the one-hour boundary correctly', () => {
    expect(msToTimestamp(3_600_000)).toBe('01:00:00,000')
    expect(msToTimestamp(3_599_999)).toBe('00:59:59,999')
  })

  it('uses a period separator when asked, for WebVTT', () => {
    expect(msToTimestamp(3_661_500, '.')).toBe('01:01:01.500')
  })

  it('pads milliseconds to three digits', () => {
    expect(msToTimestamp(1_007)).toBe('00:00:01,007')
  })

  it('rounds fractional milliseconds', () => {
    expect(msToTimestamp(1_500.6)).toBe('00:00:01,501')
  })

  it('handles durations beyond 99 hours without truncating', () => {
    expect(msToTimestamp(360_000_000)).toBe('100:00:00,000')
  })

  it('rejects negative and non-finite input', () => {
    expect(() => msToTimestamp(-1)).toThrow(RangeError)
    expect(() => msToTimestamp(Number.NaN)).toThrow(RangeError)
    expect(() => msToTimestamp(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('timestampToMs', () => {
  it('parses a comma-separated timestamp', () => {
    expect(timestampToMs('01:01:01,500')).toBe(3_661_500)
  })

  it('parses a period-separated timestamp', () => {
    expect(timestampToMs('01:01:01.500')).toBe(3_661_500)
  })

  it('parses zero', () => {
    expect(timestampToMs('00:00:00.000')).toBe(0)
  })

  it('parses hour values above two digits', () => {
    expect(timestampToMs('100:00:00.000')).toBe(360_000_000)
  })

  it('round-trips with msToTimestamp', () => {
    for (const ms of [0, 1, 999, 1_000, 59_999, 3_600_000, 3_661_500]) {
      expect(timestampToMs(msToTimestamp(ms))).toBe(ms)
    }
  })

  it('rejects malformed input', () => {
    expect(() => timestampToMs('nope')).toThrow(RangeError)
    expect(() => timestampToMs('00:00.000')).toThrow(RangeError)
    expect(() => timestampToMs('00:00:00')).toThrow(RangeError)
  })
})
