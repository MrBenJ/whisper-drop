import type { ModelRow } from '../../shared/ipc.js'
import type { ModelBaseId } from '../../shared/types.js'
import { formatBytes, formatPercent, formatRate, formatRealtimeFactor } from '../format.js'

type ModelRowViewProps = {
  row: ModelRow
  active: boolean
  downloading: boolean
  onChoose: (base: ModelBaseId) => void
  onDownload: (base: ModelBaseId) => void
  onCancelDownload: (base: ModelBaseId) => void
  onRemove: (base: ModelBaseId) => void
}

export function ModelRowView({
  row,
  active,
  downloading,
  onChoose,
  onDownload,
  onCancelDownload,
  onRemove,
}: ModelRowViewProps) {
  const speed = formatRealtimeFactor(row.realtimeFactor)

  // `row.downloading` only exists once the first progress tick lands; the
  // click that started the download makes this row `downloading` a beat
  // earlier than that, so the meter shows 0% rather than nothing.
  const received = row.downloading?.receivedBytes ?? 0
  const total = row.downloading?.totalBytes ?? row.resolved.bytes
  const rate = row.downloading ? formatRate(row.downloading.bytesPerSecond) : ''
  const percent = formatPercent(received / total)

  return (
    <div className="model-row">
      <div className="model-row-heading">
        <span className="model-row-label">{row.resolved.label}</span>
        {active && <span className="model-row-active-badge">Active</span>}
        <span className="model-row-size">{formatBytes(row.resolved.bytes)}</span>
      </div>

      <p className="model-row-blurb">{row.resolved.blurb}</p>

      {/* Position in the list is the only ordering claim for a model that has
          never run — no figure at all beats a guess. */}
      {speed && <p className="model-row-speed">~{speed} realtime on your machine</p>}

      <div className="model-row-actions">
        {downloading ? (
          <>
            <div className="model-row-progress">
              <div
                className="progress-track"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              <span className="model-row-progress-detail">
                {formatBytes(received)} of {formatBytes(total)}
                {rate && ` · ${rate}`}
              </span>
            </div>
            <button
              type="button"
              className="model-row-cancel"
              onClick={() => onCancelDownload(row.base)}
            >
              Cancel
            </button>
          </>
        ) : row.installed ? (
          <>
            <button
              type="button"
              className="model-row-choose"
              disabled={active}
              onClick={() => onChoose(row.base)}
            >
              Use this model
            </button>
            <button type="button" className="model-row-remove" onClick={() => onRemove(row.base)}>
              Remove
            </button>
          </>
        ) : (
          <button
            type="button"
            className="model-row-download"
            onClick={() => onDownload(row.base)}
          >
            Download
          </button>
        )}
      </div>
    </div>
  )
}
