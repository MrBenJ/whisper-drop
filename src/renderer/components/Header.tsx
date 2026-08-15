import type { ModelRow } from '../../shared/ipc.js'
import type { Settings } from '../../shared/types.js'

/** Common enough to ship as defaults; the full catalog is whatever whisper.cpp supports. */
const LANGUAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ru', label: 'Russian' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' },
]

type HeaderProps = {
  settings: Settings | null
  activeRow: ModelRow | undefined
  onOpenPicker: () => void
  onToggleEnglishOnly: (englishOnly: boolean) => void
  onLanguageChange: (language: string) => void
  onOpenLicenses: () => void
}

export function Header({
  settings,
  activeRow,
  onOpenPicker,
  onToggleEnglishOnly,
  onLanguageChange,
  onOpenLicenses,
}: HeaderProps) {
  const modelLabel = activeRow?.resolved.label ?? 'Choose a model'
  const englishOnly = settings?.englishOnly ?? false

  return (
    <header className="app-header">
      <button
        type="button"
        className="model-button"
        onClick={onOpenPicker}
        aria-label={activeRow ? `Change model, currently ${modelLabel}` : 'Choose a model'}
      >
        <span className="model-button-eyebrow">Model</span>
        <span className="model-button-value">{modelLabel}</span>
      </button>

      <div className="header-controls">
        {/* One control, not two: the language picker only exists while there is
            a language to pick. Once English-only is on, the switch's own label
            already says "English only" — no separate status text needed. */}
        {!englishOnly && (
          <label className="language-control">
            <span className="language-control-label">Language</span>
            <select
              value={settings?.language ?? 'auto'}
              onChange={(event) => onLanguageChange(event.target.value)}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="switch-control">
          <span>English only</span>
          <input
            type="checkbox"
            role="switch"
            checked={englishOnly}
            onChange={(event) => onToggleEnglishOnly(event.target.checked)}
          />
        </label>

        <button type="button" className="licenses-button" onClick={onOpenLicenses}>
          Licenses
        </button>
      </div>
    </header>
  )
}
