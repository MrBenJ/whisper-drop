import { useEffect, useId, useRef } from 'react'
import type { ModelRow } from '../../shared/ipc.js'
import type { ModelBaseId, Settings } from '../../shared/types.js'
import { ModelRowView } from './ModelRowView.js'

type ModelPickerProps = {
  rows: ModelRow[]
  settings: Settings | null
  /** The base a click has already started, ahead of the first progress tick. */
  downloadingBase: ModelBaseId | null
  onChoose: (base: ModelBaseId) => void
  onDownload: (base: ModelBaseId) => void
  onCancelDownload: (base: ModelBaseId) => void
  onRemove: (base: ModelBaseId) => void
  onToggleEnglishOnly: (englishOnly: boolean) => void
  onClose?: () => void
  firstRun: boolean
}

// OpenAI never shipped English-only weights above `small`, so the toggle
// leaves these two rows exactly as they were — and says so, rather than
// looking inert.
const NO_PARTIAL_SWAP_NOTE =
  'No English-only weights exist above small — these stay multilingual, and are still the most accurate option for English.'
const NO_PARTIAL_SWAP_BASES: ReadonlySet<ModelBaseId> = new Set(['large-v3-turbo', 'large-v3'])

export function ModelPicker({
  rows,
  settings,
  downloadingBase,
  onChoose,
  onDownload,
  onCancelDownload,
  onRemove,
  onToggleEnglishOnly,
  onClose,
  firstRun,
}: ModelPickerProps) {
  const englishOnly = settings?.englishOnly ?? false
  const activeBase = settings?.activeModel ?? null
  const headingId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // Modal semantics only apply outside first run, where the picker is a
  // dialog overlaying one of the five states rather than being the state.
  useEffect(() => {
    if (firstRun) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    containerRef.current?.focus()
    return () => previouslyFocused.current?.focus()
  }, [firstRun])

  useEffect(() => {
    if (firstRun || !onClose) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [firstRun, onClose])

  // aria-modal="true" only says the rest of the page is inert to assistive
  // tech — it doesn't stop Tab from actually reaching the header behind the
  // scrim. This traps it inside the dialog, wrapping at either end.
  useEffect(() => {
    if (firstRun) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return

      const focusable = container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault()
          last?.focus()
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [firstRun])

  const picker = (
    <div
      ref={containerRef}
      className="model-picker"
      tabIndex={-1}
      role={firstRun ? undefined : 'dialog'}
      aria-modal={firstRun ? undefined : true}
      aria-labelledby={headingId}
    >
      <div className="model-picker-header">
        <h2 id={headingId} className="model-picker-title">
          Choose a model
        </h2>
        {!firstRun && (
          <button type="button" className="model-picker-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
      </div>

      <p className="model-picker-tradeoff">
        Bigger models catch more of what's said but take longer per minute of audio. Start with
        whatever downloads fastest — you can switch models any time without losing a download.
      </p>

      <label className="switch-control model-picker-toggle">
        <span>{englishOnly ? 'English only' : 'All languages'}</span>
        <input
          type="checkbox"
          role="switch"
          checked={englishOnly}
          onChange={(event) => onToggleEnglishOnly(event.target.checked)}
        />
      </label>

      <ul className="model-picker-list">
        {rows.map((row) => {
          const active = row.base === activeBase
          const downloading = row.downloading !== undefined || row.base === downloadingBase
          const note = englishOnly && NO_PARTIAL_SWAP_BASES.has(row.base)

          return (
            <li key={row.base} className="model-row-item" aria-current={active ? 'true' : undefined}>
              <ModelRowView
                row={row}
                active={active}
                downloading={downloading}
                onChoose={onChoose}
                onDownload={onDownload}
                onCancelDownload={onCancelDownload}
                onRemove={onRemove}
              />
              {note && <p className="model-row-note">{NO_PARTIAL_SWAP_NOTE}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )

  if (firstRun) return picker

  return (
    <div
      className="model-picker-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.()
      }}
    >
      {picker}
    </div>
  )
}
