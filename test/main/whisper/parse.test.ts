import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSegmentLine, parseSegments } from '../../../src/main/whisper/parse.js'

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/whisper-stdout.txt', import.meta.url)),
  'utf8',
)

describe('parseSegmentLine', () => {
  it('parses a segment line into milliseconds and text', () => {
    expect(parseSegmentLine('[00:00:00.000 --> 00:00:02.000]   Testing one two')).toEqual({
      startMs: 0,
      endMs: 2_000,
      text: 'Testing one two',
    })
  })

  it('accepts comma-separated milliseconds', () => {
    expect(parseSegmentLine('[00:00:01,500 --> 00:00:02,500]  Hi.')).toEqual({
      startMs: 1_500,
      endMs: 2_500,
      text: 'Hi.',
    })
  })

  it('parses timestamps past one hour', () => {
    const parsed = parseSegmentLine('[01:02:03.004 --> 01:02:04.005]  Late.')
    expect(parsed?.startMs).toBe(3_723_004)
    expect(parsed?.endMs).toBe(3_724_005)
  })

  it('returns an empty string for a segment with no words', () => {
    expect(parseSegmentLine('[00:00:03.000 --> 00:00:04.000]  ')?.text).toBe('')
  })

  it('tolerates leading and trailing whitespace on the line', () => {
    expect(parseSegmentLine('  [00:00:00.000 --> 00:00:01.000]  Hi.  ')?.text).toBe('Hi.')
  })

  it('returns null for log lines', () => {
    expect(parseSegmentLine('whisper_model_load: loading model')).toBeNull()
    expect(parseSegmentLine('system_info: n_threads = 4 / 10 | METAL = 1 |')).toBeNull()
    expect(parseSegmentLine('')).toBeNull()
  })

  it('returns null for a line that looks close but is malformed', () => {
    expect(parseSegmentLine('[00:00 --> 00:01] nope')).toBeNull()
    expect(parseSegmentLine('[00:00:00.000 00:00:01.000] nope')).toBeNull()
  })
})

describe('parseSegments', () => {
  it('extracts only the segment lines from real output', () => {
    const segments = parseSegments(FIXTURE)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ index: 0, startMs: 0, endMs: 2_000, text: 'Testing one two' })
    expect(segments[1]).toEqual({ index: 1, startMs: 2_000, endMs: 3_000, text: 'three four.' })
  })

  it('assigns sequential zero-based indices', () => {
    expect(parseSegments(FIXTURE).map((s) => s.index)).toEqual([0, 1, 2])
  })

  it('keeps empty-text segments so timing stays intact for the caller', () => {
    expect(parseSegments(FIXTURE)[2]).toEqual({
      index: 2,
      startMs: 3_000,
      endMs: 4_000,
      text: '',
    })
  })

  it('handles CRLF line endings', () => {
    const crlf = '[00:00:00.000 --> 00:00:01.000]  Hi.\r\nwhisper: done\r\n'
    expect(parseSegments(crlf)).toEqual([{ index: 0, startMs: 0, endMs: 1_000, text: 'Hi.' }])
  })

  it('returns an empty array when there are no segments', () => {
    expect(parseSegments('whisper_model_load: loading model\n')).toEqual([])
  })
})
