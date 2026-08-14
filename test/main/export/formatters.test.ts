import { describe, expect, it } from 'vitest'
import { format, toSrt, toTxt, toVtt } from '../../../src/main/export/formatters.js'
import type { Segment } from '../../../src/shared/types.js'

const seg = (index: number, startMs: number, endMs: number, text: string): Segment => ({
  index,
  startMs,
  endMs,
  text,
})

const SAMPLE: Segment[] = [
  seg(0, 0, 2_000, 'Hello there.'),
  seg(1, 2_000, 4_500, 'This is a test.'),
]

describe('toTxt', () => {
  it('writes one trimmed segment per line with a trailing newline', () => {
    expect(toTxt(SAMPLE)).toBe('Hello there.\nThis is a test.\n')
  })

  it('returns an empty string for no segments', () => {
    expect(toTxt([])).toBe('')
  })

  it('drops blank and whitespace-only segments', () => {
    const segments = [seg(0, 0, 1_000, 'Kept.'), seg(1, 1_000, 2_000, '   '), seg(2, 2_000, 3_000, 'Also kept.')]
    expect(toTxt(segments)).toBe('Kept.\nAlso kept.\n')
  })

  it('collapses internal whitespace and newlines into single spaces', () => {
    expect(toTxt([seg(0, 0, 1_000, '  Hello\n  there  ')])).toBe('Hello there\n')
  })
})

describe('toSrt', () => {
  it('numbers cues from 1 and separates them with a blank line', () => {
    expect(toSrt(SAMPLE)).toBe(
      '1\n' +
        '00:00:00,000 --> 00:00:02,000\n' +
        'Hello there.\n' +
        '\n' +
        '2\n' +
        '00:00:02,000 --> 00:00:04,500\n' +
        'This is a test.\n',
    )
  })

  it('returns an empty string for no segments', () => {
    expect(toSrt([])).toBe('')
  })

  it('keeps cue numbering contiguous when blank segments are dropped', () => {
    const segments = [seg(0, 0, 1_000, 'One.'), seg(1, 1_000, 2_000, ''), seg(2, 2_000, 3_000, 'Two.')]
    const output = toSrt(segments)
    expect(output).toContain('1\n00:00:00,000 --> 00:00:01,000\nOne.')
    expect(output).toContain('2\n00:00:02,000 --> 00:00:03,000\nTwo.')
    // No third cue number. Matched line-anchored: a bare `'3'` check would also
    // hit the `3` inside the 00:00:03,000 timestamp above.
    expect(output).not.toMatch(/^3$/m)
  })

  it('uses commas before milliseconds', () => {
    expect(toSrt(SAMPLE)).toContain('00:00:00,000 --> 00:00:02,000')
    expect(toSrt(SAMPLE)).not.toContain('00:00:00.000')
  })

  it('formats segments that cross the one-hour boundary', () => {
    expect(toSrt([seg(0, 3_599_500, 3_600_500, 'Late.')])).toContain(
      '00:59:59,500 --> 01:00:00,500',
    )
  })

  it('ignores the incoming index and renumbers from the emitted order', () => {
    expect(toSrt([seg(41, 0, 1_000, 'Only.')]).startsWith('1\n')).toBe(true)
  })
})

describe('toVtt', () => {
  it('starts with the WEBVTT header followed by a blank line', () => {
    expect(toVtt(SAMPLE).startsWith('WEBVTT\n\n')).toBe(true)
  })

  it('uses periods before milliseconds', () => {
    expect(toVtt(SAMPLE)).toContain('00:00:00.000 --> 00:00:02.000')
    expect(toVtt(SAMPLE)).not.toContain('00:00:00,000')
  })

  it('emits the header even with no segments, so the file stays valid', () => {
    expect(toVtt([])).toBe('WEBVTT\n\n')
  })

  it('does not number cues', () => {
    expect(toVtt(SAMPLE)).not.toMatch(/^\d+$/m)
  })
})

describe('format', () => {
  it('dispatches to each formatter', () => {
    expect(format(SAMPLE, 'txt')).toBe(toTxt(SAMPLE))
    expect(format(SAMPLE, 'srt')).toBe(toSrt(SAMPLE))
    expect(format(SAMPLE, 'vtt')).toBe(toVtt(SAMPLE))
  })
})
