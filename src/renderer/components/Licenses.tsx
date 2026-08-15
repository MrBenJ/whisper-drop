import { useEffect, useId, useRef } from 'react'
import { LICENSES } from '../licenses.js'

type LicensesProps = {
  onClose: () => void
}

/**
 * A dialog, not a view: reachable from the header over any of the five app
 * states, the same way ModelPicker overlays them outside first-run. Renders
 * only `LICENSES` — no fetch, no IPC, nothing to wire beyond open/close.
 */
export function Licenses({ onClose }: LicensesProps) {
  const headingId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null
    containerRef.current?.focus()
    return () => previouslyFocused.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="licenses-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={containerRef}
        className="licenses"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="licenses-header">
          <h2 id={headingId} className="licenses-title">
            Licenses
          </h2>
          <button type="button" className="licenses-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <ul className="licenses-list">
          {LICENSES.map((entry) => (
            <li key={entry.name} className="licenses-item">
              <div className="licenses-item-heading">
                <span className="licenses-item-name">{entry.name}</span>
                {entry.version && <span className="licenses-item-version">{entry.version}</span>}
                <span className="licenses-item-license">{entry.license}</span>
              </div>
              <p className="licenses-item-note">{entry.note}</p>
              {/* Selectable text, not a link: the window denies navigation and
                  refuses to open new windows, so an anchor would be dead chrome. */}
              <p className="licenses-item-url">{entry.url}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
