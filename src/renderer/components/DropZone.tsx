import { useState, type DragEvent, type KeyboardEvent } from 'react'

const ONE_AT_A_TIME_MESSAGE =
  'whisper-drop handles one file at a time for now — using the first.'
const DEFAULT_DISABLED_REASON = 'Waiting for the model to finish downloading'

type DropZoneProps = {
  disabled?: boolean
  reason?: string
  onFile: (path: string) => void
  onBrowse: () => void
}

export function DropZone({ disabled = false, reason, onFile, onBrowse }: DropZoneProps) {
  const [hovering, setHovering] = useState(false)
  const [multipleWarning, setMultipleWarning] = useState(false)

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    if (disabled) return
    setHovering(true)
  }

  function handleDragLeave(): void {
    setHovering(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setHovering(false)
    if (disabled) return

    setMultipleWarning(false)
    const files = event.dataTransfer.files
    if (files.length === 0) return
    if (files.length > 1) setMultipleWarning(true)

    const file = files[0]
    if (!file) return
    onFile(window.whisperDrop.droppedFile.pathFor(file))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Only the drop zone's own key events, not ones bubbling up from the
    // browse button, which already handles its own Enter/Space activation.
    if (event.target !== event.currentTarget || disabled) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onBrowse()
    }
  }

  const className = [
    'drop-zone',
    hovering && 'drop-zone--hovering',
    disabled && 'drop-zone--disabled',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label="Drop an audio or video file to transcribe it, or press Enter to browse"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
    >
      <svg className="drop-zone-glyph" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
        <path
          d="M24 6v24m0 0-9-9m9 9 9-9M9 34v4a4 4 0 0 0 4 4h22a4 4 0 0 0 4-4v-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <p className="drop-zone-prompt">
        {disabled ? (reason ?? DEFAULT_DISABLED_REASON) : 'Drop an audio or video file'}
      </p>
      {!disabled && <p className="drop-zone-or">or</p>}

      <button
        type="button"
        data-testid="browse"
        className="browse-button"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onBrowse()
        }}
      >
        Browse files
      </button>

      {multipleWarning && <p className="drop-zone-warning">{ONE_AT_A_TIME_MESSAGE}</p>}
    </div>
  )
}
