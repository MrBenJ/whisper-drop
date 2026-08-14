import { msToTimestamp } from '../../shared/time.js'
import type { ExportFormat, Segment } from '../../shared/types.js'

export type { ExportFormat }

/** Trim and collapse internal whitespace so wrapped output reads as one line. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Drop segments with no words. Whisper emits these around silence, and they
 * would otherwise become empty cues and gaps in the SRT numbering.
 */
function meaningful(segments: Segment[]): { startMs: number; endMs: number; text: string }[] {
  return segments
    .map((segment) => ({ startMs: segment.startMs, endMs: segment.endMs, text: normalise(segment.text) }))
    .filter((segment) => segment.text.length > 0)
}

export function toTxt(segments: Segment[]): string {
  const lines = meaningful(segments).map((segment) => segment.text)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

export function toSrt(segments: Segment[]): string {
  const cues = meaningful(segments)
  if (cues.length === 0) return ''

  return cues
    .map((cue, i) => {
      const start = msToTimestamp(cue.startMs, ',')
      const end = msToTimestamp(cue.endMs, ',')
      return `${i + 1}\n${start} --> ${end}\n${cue.text}\n`
    })
    .join('\n')
}

export function toVtt(segments: Segment[]): string {
  const cues = meaningful(segments)
  const body = cues
    .map((cue) => {
      const start = msToTimestamp(cue.startMs, '.')
      const end = msToTimestamp(cue.endMs, '.')
      return `${start} --> ${end}\n${cue.text}\n`
    })
    .join('\n')

  return `WEBVTT\n\n${body}`
}

export function format(segments: Segment[], as: ExportFormat): string {
  switch (as) {
    case 'txt':
      return toTxt(segments)
    case 'srt':
      return toSrt(segments)
    case 'vtt':
      return toVtt(segments)
  }
}
