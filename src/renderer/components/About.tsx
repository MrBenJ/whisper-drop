import { useEffect, useId, useRef } from 'react'

type AboutProps = {
  onClose: () => void
}

/** A local, static explanation of the app and the people behind it. */
export function About({ onClose }: AboutProps) {
  const headingId = useId()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    containerRef.current?.focus()
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // aria-modal describes the relationship to assistive technology, but it
  // does not keep keyboard focus from moving to controls behind the scrim.
  useEffect(() => {
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
      const activeIsFocusable = Array.from(focusable).some((element) => element === active)

      if (event.shiftKey) {
        if (active === first || !activeIsFocusable) {
          event.preventDefault()
          last?.focus()
        }
      } else if (active === last || !activeIsFocusable) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className="about-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={containerRef}
        className="about"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="about-header">
          <h2 id={headingId} className="about-title">
            About whisper-drop
          </h2>
          <button type="button" className="about-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="about-content">
          <section>
            <h3>Private transcription, made simple</h3>
            <p>
              whisper-drop turns audio and video into text entirely on your computer. There is no
              account, no upload, and no telemetry. Once your chosen model is downloaded,
              transcription works offline.
            </p>
          </section>

          <section>
            <h3>What to use it for</h3>
            <p>
              Use it for voice memos, meetings, interviews, client calls, and courses, or whenever
              you want to search, quote, or archive a recording as text. It is especially useful
              when the recording is sensitive or needs to stay private.
            </p>
          </section>

          <section>
            <h3>Who made it</h3>
            <p>
              whisper-drop was created by Ben Junya and is built and maintained by Human Balance
              AI as a free, open-source tool.
            </p>
            <p className="about-url">humanbalanceai.com</p>
          </section>
        </div>
      </div>
    </div>
  )
}
