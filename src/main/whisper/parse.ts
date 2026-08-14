import { timestampToMs } from '../../shared/time.js'
import type { Segment } from '../../shared/types.js'

/**
 * A whisper-cli segment line, e.g.
 *   [00:00:00.000 --> 00:00:02.000]   Testing one two
 * Everything else on stdout is model-loading and timing logging.
 */
const SEGMENT_LINE = /^\[(\d+:[0-5]\d:[0-5]\d[.,]\d{3})\s*-->\s*(\d+:[0-5]\d:[0-5]\d[.,]\d{3})\]\s?(.*)$/

export type ParsedSegment = { startMs: number; endMs: number; text: string }

/** Parse one line of whisper-cli stdout. Returns null for anything else. */
export function parseSegmentLine(line: string): ParsedSegment | null {
  const match = SEGMENT_LINE.exec(line.trim())
  if (!match) return null

  const [, start, end, text] = match as unknown as [string, string, string, string]

  return {
    startMs: timestampToMs(start),
    endMs: timestampToMs(end),
    text: text.trim(),
  }
}

/**
 * Parse a whole stdout buffer. Empty-text segments are kept: the runner uses
 * their end timestamps for progress, and the formatters drop them at the end.
 */
export function parseSegments(stdout: string): Segment[] {
  const segments: Segment[] = []

  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parseSegmentLine(line)
    if (parsed) segments.push({ index: segments.length, ...parsed })
  }

  return segments
}
