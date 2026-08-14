import { describe, expect, it } from 'vitest'
import {
  basenameOf,
  formatBytes,
  formatDuration,
  formatEta,
  formatPercent,
  formatRate,
  formatRealtimeFactor,
  phaseLabel,
} from '../../src/renderer/format.js'

describe('basenameOf', () => {
  it('takes the last segment of a posix path', () => {
    expect(basenameOf('/Users/ben/Movies/interview.mp4')).toBe('interview.mp4')
  })

  it('takes the last segment of a windows path', () => {
    expect(basenameOf('C:\\Users\\ben\\Movies\\interview.mp4')).toBe('interview.mp4')
  })

  it('returns a bare filename unchanged', () => {
    expect(basenameOf('interview.mp4')).toBe('interview.mp4')
  })
})

describe('formatPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatPercent(0.4269)).toBe(43)
  })

  it('clamps outside 0..1', () => {
    expect(formatPercent(-1)).toBe(0)
    expect(formatPercent(2)).toBe(100)
  })

  it('reads non-finite input as zero rather than NaN', () => {
    expect(formatPercent(Number.NaN)).toBe(0)
  })
})

describe('formatEta', () => {
  it('returns null when there is no estimate, so nothing is shown', () => {
    expect(formatEta(undefined)).toBeNull()
    expect(formatEta(Number.NaN)).toBeNull()
    expect(formatEta(-1)).toBeNull()
  })

  it('describes sub-second estimates without a bogus zero', () => {
    expect(formatEta(200)).toBe('less than a second')
  })

  it('formats seconds', () => {
    expect(formatEta(5_000)).toBe('5 sec')
    expect(formatEta(59_400)).toBe('59 sec')
  })

  it('formats minutes, dropping a zero seconds part', () => {
    expect(formatEta(80_000)).toBe('1 min 20 sec')
    expect(formatEta(120_000)).toBe('2 min')
  })

  it('formats hours', () => {
    expect(formatEta(3_600_000)).toBe('1 hr 0 min')
    expect(formatEta(5_460_000)).toBe('1 hr 31 min')
  })

  it('rounds to the nearest second', () => {
    expect(formatEta(59_600)).toBe('1 min')
  })
})

describe('formatDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatDuration(247_000)).toBe('4:07')
    expect(formatDuration(9_000)).toBe('0:09')
  })

  it('formats over an hour as h:mm:ss', () => {
    expect(formatDuration(3_723_000)).toBe('1:02:03')
  })

  it('formats zero and rejects nonsense to zero', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('formatRealtimeFactor', () => {
  it('returns null when the model has never been run here', () => {
    expect(formatRealtimeFactor(undefined)).toBeNull()
    expect(formatRealtimeFactor(0)).toBeNull()
    expect(formatRealtimeFactor(Number.NaN)).toBeNull()
  })

  it('shows one decimal below ten', () => {
    expect(formatRealtimeFactor(0.83)).toBe('0.8×')
    expect(formatRealtimeFactor(4)).toBe('4.0×')
  })

  it('rounds to whole multiples at ten and above', () => {
    expect(formatRealtimeFactor(12.4)).toBe('12×')
  })
})

describe('formatBytes', () => {
  it('uses decimal MB and GB, matching how the catalog quotes sizes', () => {
    expect(formatBytes(77_691_713)).toBe('78 MB')
    expect(formatBytes(147_951_465)).toBe('148 MB')
    expect(formatBytes(1_624_555_275)).toBe('1.6 GB')
    expect(formatBytes(3_095_033_483)).toBe('3.1 GB')
  })

  it('handles nonsense without printing NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 MB')
    expect(formatBytes(-1)).toBe('0 MB')
  })
})

describe('formatRate', () => {
  it('renders a per-second rate', () => {
    expect(formatRate(2_500_000)).toBe('3 MB/s')
  })

  it('renders nothing at all when the rate is unknown', () => {
    expect(formatRate(0)).toBe('')
    expect(formatRate(Number.NaN)).toBe('')
  })
})

describe('phaseLabel', () => {
  it('gives every phase a plain-language label', () => {
    expect(phaseLabel('probing')).toBe('Reading the file')
    expect(phaseLabel('preparing')).toBe('Preparing audio')
    expect(phaseLabel('transcribing')).toBe('Transcribing')
    expect(phaseLabel('done')).toBe('Done')
    expect(phaseLabel('cancelled')).toBe('Cancelled')
    expect(phaseLabel('failed')).toBe('Failed')
  })
})
