import { useState } from 'react'
import type { IpcFailure } from '../../shared/ipc.js'
import { detailBlock, presentError, type ErrorAction } from '../errors.js'

type ErrorViewProps = {
  failure: IpcFailure
  onRetry: () => void
  onOpenPicker: () => void
  onDismiss: () => void
}

const ACTION_LABEL: Record<ErrorAction, string> = {
  'open-picker': 'Choose a model',
  'retry-transcription': 'Try again',
  'retry-download': 'Try the download again',
  dismiss: 'Start over',
}

export function ErrorView({ failure, onRetry, onOpenPicker, onDismiss }: ErrorViewProps) {
  const presentation = presentError(failure)
  const [copied, setCopied] = useState(false)
  const block = detailBlock(failure)

  const handleAction: Record<ErrorAction, () => void> = {
    'open-picker': onOpenPicker,
    'retry-transcription': onRetry,
    'retry-download': onRetry,
    dismiss: onDismiss,
  }

  return (
    <section className="error-view" role="alert">
      <h2 className="error-title">{presentation.title}</h2>
      <p className="error-suggestion">{presentation.suggestion}</p>

      <div className="error-actions">
        <button type="button" className="error-action" onClick={handleAction[presentation.action]}>
          {ACTION_LABEL[presentation.action]}
        </button>
        {/* Dismiss is already the action button when there's nothing else to
            try — a second copy of it would be redundant. */}
        {presentation.action !== 'dismiss' && (
          <button type="button" className="error-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>

      {/* The only place any technical text appears — never in the title or
          suggestion above. */}
      <details className="error-details">
        <summary>Details</summary>
        <pre>{block}</pre>
        <button
          type="button"
          className="error-copy-details"
          onClick={() => {
            navigator.clipboard
              ?.writeText(block)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
        >
          Copy details
        </button>
        {copied && <span className="error-copied-note">Copied</span>}
      </details>
    </section>
  )
}
