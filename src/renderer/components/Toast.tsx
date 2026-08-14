import { useEffect } from 'react'
import { basenameOf } from '../format.js'

const AUTO_DISMISS_MS = 6000

type ToastProps = {
  path: string
  onReveal: (path: string) => void
  onDismiss: () => void
}

export function Toast({ path, onReveal, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [path, onDismiss])

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-message">Saved {basenameOf(path)}</span>
      <button type="button" className="toast-reveal" onClick={() => onReveal(path)}>
        Reveal
      </button>
      <button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}
