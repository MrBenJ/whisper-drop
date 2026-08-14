import { useEffect, useRef } from 'react'
import { basenameOf } from '../format.js'

const AUTO_DISMISS_MS = 6000

type ToastProps = {
  path: string
  onReveal: (path: string) => void
  onDismiss: () => void
}

export function Toast({ path, onReveal, onDismiss }: ToastProps) {
  // App.tsx passes an inline arrow for `onDismiss`, so its identity changes
  // on every one of App's re-renders — a job-state tick, a models refresh,
  // anything. Depending the timer effect on `onDismiss` directly would
  // restart the 6-second countdown on each of those, so the latest callback
  // is instead read through a ref the timer effect never depends on; only a
  // genuinely new toast (`path` changing) restarts the clock.
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [path])

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
