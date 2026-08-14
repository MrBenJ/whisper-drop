import { useCallback, useEffect, useReducer, useState } from 'react'
import { Done } from './components/Done.js'
import { DropZone } from './components/DropZone.js'
import { ErrorView } from './components/ErrorView.js'
import { Header } from './components/Header.js'
import { ModelPicker } from './components/ModelPicker.js'
import { Toast } from './components/Toast.js'
import { Working } from './components/Working.js'
import { asIpcFailure, presentError } from './errors.js'
import type { ExportFormat, ModelBaseId } from '../shared/types.js'
import { activeRow, INITIAL_STATE, reduce, viewFor } from './state/app-state.js'

export function App() {
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE)
  // Local, transient UI state — not part of the reducer because it never
  // affects which of the five views is shown, only what a row inside the
  // picker looks like while a download is in flight.
  const [downloadingBase, setDownloadingBase] = useState<ModelBaseId | null>(null)
  const [lastDownloadBase, setLastDownloadBase] = useState<ModelBaseId | null>(null)

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
    // M11: DropZone calls this bare from an onClick handler, with nothing of
    // its own to catch a rejection — a failing dialog.openFile() would
    // otherwise be a silent unhandled rejection instead of reaching the
    // error surface like every other failure here does.
    try {
      const filePath = await window.whisperDrop.dialog.openFile()
      if (filePath !== null) await startTranscription(filePath)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
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

  const chooseModel = useCallback(async (base: ModelBaseId) => {
    try {
      const settings = await window.whisperDrop.settings.set({ activeModel: base })
      dispatch({ type: 'settings-changed', settings })
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const downloadModel = useCallback(
    async (base: ModelBaseId) => {
      setDownloadingBase(base)
      setLastDownloadBase(base)
      try {
        await window.whisperDrop.models.download(base)
      } catch (cause) {
        dispatch({ type: 'failed', error: asIpcFailure(cause) })
      } finally {
        // Runs on cancellation too: the row must stop showing a progress bar.
        // M11: refresh() sat outside any try/catch here, so a rejection from
        // it (e.g. settings.get failing) was an unhandled rejection instead
        // of reaching the error surface — and would have skipped clearing
        // downloadingBase below, leaving the row stuck showing a progress bar.
        try {
          await refresh()
        } catch (cause) {
          dispatch({ type: 'failed', error: asIpcFailure(cause) })
        } finally {
          setDownloadingBase(null)
        }
      }
    },
    [refresh],
  )

  const cancelDownload = useCallback(async (base: ModelBaseId) => {
    // Aborts the in-flight `download` call above; that call's own `finally`
    // clears `downloadingBase` and refreshes the rows once it settles, so
    // there is nothing left to do here beyond forwarding the abort.
    try {
      await window.whisperDrop.models.cancelDownload(base)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  const removeModel = useCallback(
    async (base: ModelBaseId) => {
      try {
        await window.whisperDrop.models.remove(base)
      } catch (cause) {
        dispatch({ type: 'failed', error: asIpcFailure(cause) })
      } finally {
        // M11: same shape as downloadModel above — refresh() rejecting here
        // used to be an unhandled rejection instead of reaching the user.
        try {
          await refresh()
        } catch (cause) {
          dispatch({ type: 'failed', error: asIpcFailure(cause) })
        }
      }
    },
    [refresh],
  )

  // C1: deliberately does not catch. A save failure is caught by `Done`
  // itself (`handleSave`), right where the transcript and every Save button
  // stay on screen — routing it through the app-level error state here would
  // hand the user only "Start over" (UNEXPECTED's `dismiss` action), which
  // resets `job` and discards the very transcript this save just proved main
  // still holds.
  const save = useCallback(async (jobId: string, format: ExportFormat) => {
    dispatch({ type: 'saved', path: await window.whisperDrop.exportTranscript.save(jobId, format) })
  }, [])

  const reveal = useCallback(async (path: string) => {
    // The path came from `save` above, so it is already on main's allowlist.
    try {
      await window.whisperDrop.shell.reveal(path)
    } catch (cause) {
      dispatch({ type: 'failed', error: asIpcFailure(cause) })
    }
  }, [])

  // Injected rather than called directly from `Done`, so the component never
  // reaches into `navigator` itself — the same seam every other outside
  // effect in the renderer goes through `window.whisperDrop` for.
  const copyTranscript = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text)
  }, [])

  // Which concrete thing to retry depends on which operation failed, which
  // `state.error` alone doesn't say — a transcription failure retries the
  // job that failed, a download failure retries the model that was being
  // fetched when it did.
  const retry = useCallback(() => {
    if (!state.error) return
    const action = presentError(state.error).action
    if (action === 'retry-transcription' && state.job) {
      void startTranscription(state.job.filePath)
    } else if (action === 'retry-download' && lastDownloadBase) {
      void downloadModel(lastDownloadBase)
    }
  }, [state.error, state.job, lastDownloadBase, startTranscription, downloadModel])

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
          <div className="first-run">
            <ModelPicker
              firstRun
              rows={state.models}
              settings={state.settings}
              downloadingBase={downloadingBase}
              onChoose={(base) => void chooseModel(base)}
              onDownload={(base) => void downloadModel(base)}
              onCancelDownload={(base) => void cancelDownload(base)}
              onRemove={(base) => void removeModel(base)}
              onToggleEnglishOnly={(value) => void setEnglishOnly(value)}
            />
            <DropZone
              disabled
              reason="Choose a model above to get started."
              onFile={(path) => void startTranscription(path)}
              onBrowse={browse}
            />
          </div>
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

        {view === 'done' && state.job && (
          <Done
            job={state.job}
            onSave={(format) => (state.job ? save(state.job.id, format) : Promise.resolve())}
            onCopy={copyTranscript}
            onReset={() => dispatch({ type: 'reset' })}
          />
        )}

        {view === 'error' && state.error && (
          <ErrorView
            failure={state.error}
            onRetry={retry}
            onOpenPicker={() => dispatch({ type: 'picker-opened' })}
            onDismiss={() => dispatch({ type: 'reset' })}
          />
        )}
      </main>

      {/* The picker is reachable at any time via the header, overlaying
          whichever of the five views is current — first-run already shows it
          inline above, so it isn't repeated here. */}
      {state.pickerOpen && view !== 'first-run' && (
        <ModelPicker
          firstRun={false}
          rows={state.models}
          settings={state.settings}
          downloadingBase={downloadingBase}
          onChoose={(base) => void chooseModel(base)}
          onDownload={(base) => void downloadModel(base)}
          onCancelDownload={(base) => void cancelDownload(base)}
          onRemove={(base) => void removeModel(base)}
          onToggleEnglishOnly={(value) => void setEnglishOnly(value)}
          onClose={() => dispatch({ type: 'picker-closed' })}
        />
      )}

      {state.savedPath && (
        <Toast
          path={state.savedPath}
          onReveal={(path) => void reveal(path)}
          onDismiss={() => dispatch({ type: 'toast-dismissed' })}
        />
      )}
    </div>
  )
}
