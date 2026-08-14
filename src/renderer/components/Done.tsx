import { useState } from 'react'
import type { ExportFormat, JobState, Segment } from '../../shared/types.js'
import { basenameOf, formatDuration } from '../format.js'

/** Segments separated by this long a silence start a new paragraph. */
const PARAGRAPH_GAP_MS = 1500

/** Meaningful segment text, grouped into reading paragraphs by gap. Blank
 * segments are dropped first, exactly as the export formatters do, so a
 * silence flanked by two blank segments doesn't split a paragraph twice. */
function paragraphsFrom(segments: Segment[]): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  let previousEnd: number | null = null

  for (const segment of segments) {
    const text = segment.text.trim()
    if (text === '') continue

    if (previousEnd !== null && segment.startMs - previousEnd >= PARAGRAPH_GAP_MS) {
      paragraphs.push(current.join(' '))
      current = []
    }

    current.push(text)
    previousEnd = segment.endMs
  }

  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs
}

type DoneProps = {
  job: JobState
  onSave: (format: ExportFormat) => void
  /** Injected so the component never touches `navigator` directly — mirrors
   * how the rest of the renderer reaches the outside world only through
   * `window.whisperDrop`. */
  onCopy: (text: string) => Promise<void>
  onReset: () => void
}

export function Done({ job, onSave, onCopy, onReset }: DoneProps) {
  const [copyFailed, setCopyFailed] = useState(false)
  const paragraphs = paragraphsFrom(job.segments)
  const transcriptText = paragraphs.join('\n\n')

  function handleCopy(): void {
    setCopyFailed(false)
    // A clipboard failure is not a transcription failure — it stays local to
    // this view rather than dispatching into the Error state.
    onCopy(transcriptText).catch(() => setCopyFailed(true))
  }

  return (
    <section className="done" aria-label="Transcript">
      <div className="done-file">
        <span data-testid="source-name" className="done-filename">
          {basenameOf(job.filePath)}
        </span>
        {job.media && <span className="done-duration">{formatDuration(job.media.durationMs)}</span>}
      </div>

      <div data-testid="transcript" className="transcript">
        {paragraphs.length === 0 ? (
          <p className="transcript-empty">No speech was found in this file.</p>
        ) : (
          paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
        )}
      </div>

      <div className="done-actions">
        <div className="done-actions-copy">
          <button type="button" className="done-copy" onClick={handleCopy}>
            Copy
          </button>
          {copyFailed && <span className="done-copy-note">Couldn't copy</span>}
        </div>
        <button type="button" className="done-save" onClick={() => onSave('txt')}>
          Save .txt
        </button>
        <button type="button" className="done-save" onClick={() => onSave('srt')}>
          Save .srt
        </button>
        <button type="button" className="done-save" onClick={() => onSave('vtt')}>
          Save .vtt
        </button>
        <button type="button" className="done-reset" onClick={onReset}>
          Transcribe another
        </button>
      </div>
    </section>
  )
}
