import { useCallback, useEffect, useReducer } from 'react'
import { DropZone } from './components/DropZone.js'
import { Header } from './components/Header.js'
import { Working } from './components/Working.js'
import { asIpcFailure } from './errors.js'
import { activeRow, INITIAL_STATE, reduce, viewFor } from './state/app-state.js'

export function App() {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE)

  const refresh = useCallback(async () => {
    const [settings, models] = await Promise.all([
      window.whisperDrop.settings.get(),
      window.whisperDrop.models.list(),
    ])
    dispatch({ type: 'loaded', settings, models })
  }, [])

  useEffect(() => {
    void refresh().catch((cause) => dispatch({ type: 'failed', error: asIpcFailure(cause) }))
  }, [refresh])

  useEffect(() => {
    const off = window.whisperDrop.transcribe.onState((jobState) =>
      dispatch({ type: 'job-state', state: jobState }),
    )
    return off
  }, [])

  useEffect(() => {
    // Download progress only changes a row's numbers, so the rows are re-read
    // rather than patched in place — one source of truth for install state.
    const off = window.whisperDrop.models.onProgress(() => {
      void window.whisperDrop.models
        .list()
        .then((models) => dispatch({ type: 'models-changed', models }))
        .catch(() => {})
    })
    return off
  }, [])

  // A dropped file must never navigate the renderer, in any state, including
  // over parts of the window that are not the drop target.
  useEffect(() => {
    const swallow = (event: DragEvent): void => event.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  const startTranscription = useCallback(async (filePath: string) => {
    dispatch({ type: 'start-requested' })
    try {
      await window.whisperDrop.transcribe.start(filePath)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const cancel = useCallback(async (jobId: string) => {
    dispatch({ type: 'cancel-requested' })
    try {
      await window.whisperDrop.transcribe.cancel(jobId)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const browse = useCallback(async () => {
    const filePath = await window.whisperDrop.dialog.openFile()
    if (filePath !== null) await startTranscription(filePath)
  }, [startTranscription])

  // Ahead of the model picker (task 5), which needs the same wiring — writing
  // it once here means task 5 wires the picker to an already-correct setter
  // rather than duplicating it.
  const setEnglishOnly = useCallback(async (englishOnly: boolean) => {
    try {
      const settings = await window.whisperDrop.settings.set({ englishOnly })
      dispatch({ type: 'settings-changed', settings })
      dispatch({ type: 'models-changed', models: await window.whisperDrop.models.list() })
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const setLanguage = useCallback(async (language: string) => {
    try {
      const settings = await window.whisperDrop.settings.set({ language })
      dispatch({ type: 'settings-changed', settings })
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const view = viewFor(state)

  return (
    <div className="app-shell">
      <Header
        settings={state.settings}
        activeRow={activeRow(state)}
        onOpenPicker={() => dispatch({ type: 'picker-opened' })}
        onToggleEnglishOnly={(value) => void setEnglishOnly(value)}
        onLanguageChange={(value) => void setLanguage(value)}
      />

      <main className="app-main">
        {view === 'first-run' && (
          <DropZone
            disabled
            reason="Choose a model above to get started."
            onFile={(path) => void startTranscription(path)}
            onBrowse={browse}
          />
        )}

        {view === 'idle' && (
          <DropZone onFile={(path) => void startTranscription(path)} onBrowse={browse} />
        )}

        {view === 'working' && (
          <Working
            job={state.job}
            frozen={state.frozen}
            onCancel={() => {
              if (state.job) void cancel(state.job.id)
            }}
          />
        )}

        {/* Done and Error views land in a later task; this keeps the shell
            navigable in the meantime rather than rendering nothing. */}
        {view === 'done' && (
          <section className="placeholder-view">
            <p>Transcription finished. The transcript view is coming in a later task.</p>
          </section>
        )}

        {view === 'error' && (
          <section className="placeholder-view" role="alert">
            <p>{state.error?.message ?? 'Something went wrong.'}</p>
          </section>
        )}
      </main>
    </div>
  )
}
