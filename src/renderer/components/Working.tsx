import type { JobState } from '../../shared/types.js'
import { basenameOf, formatDuration, formatEta, formatPercent, phaseLabel } from '../format.js'

type WorkingProps = {
  job: JobState | null
  frozen: boolean
  onCancel: () => void
}

export function Working({ job, frozen, onCancel }: WorkingProps) {
  if (!job) {
    // Between the drop landing and the first JobState arriving from main.
    return (
      <section className="working" aria-label="Starting">
        <p className="working-phase">Starting…</p>
      </section>
    )
  }

  const percent = formatPercent(job.progress)
  const eta = formatEta(job.etaMs)

  return (
    <section className="working" aria-label="Transcribing">
      <div className="working-file">
        <span data-testid="source-name" className="working-filename">
          {basenameOf(job.filePath)}
        </span>
        {job.media && <span className="working-duration">{formatDuration(job.media.durationMs)}</span>}
      </div>

      <p className="working-phase">{phaseLabel(job.phase)}</p>

      <div className="working-meter">
        <div
          className="progress-track"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="progress-percent">{percent}%</span>
      </div>

      {eta && <p className="working-eta">{eta} remaining</p>}

      <button type="button" className="cancel-button" disabled={frozen} onClick={onCancel}>
        {frozen ? 'Cancelling…' : 'Cancel'}
      </button>
    </section>
  )
}
