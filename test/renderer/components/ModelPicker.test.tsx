// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { ModelPicker } from '../../../src/renderer/components/ModelPicker.js'
import { formatPercent } from '../../../src/renderer/format.js'
import type { ModelRow } from '../../../src/shared/ipc.js'
import type { ModelBaseId, Settings } from '../../../src/shared/types.js'
import { DEFAULT_SETTINGS, modelRow } from '../fake-api.js'

const BASES: ModelBaseId[] = ['tiny', 'base', 'small', 'large-v3-turbo', 'large-v3']

function rowsFor(bases: ModelBaseId[] = BASES, overrides: Partial<ModelRow> = {}): ModelRow[] {
  return bases.map((base) => modelRow({ base, ...overrides }))
}

type Handlers = {
  onChoose: Mock<(base: ModelBaseId) => void>
  onDownload: Mock<(base: ModelBaseId) => void>
  onCancelDownload: Mock<(base: ModelBaseId) => void>
  onRemove: Mock<(base: ModelBaseId) => void>
  onToggleEnglishOnly: Mock<(englishOnly: boolean) => void>
  onClose: Mock<() => void>
}

function handlers(): Handlers {
  return {
    onChoose: vi.fn<(base: ModelBaseId) => void>(),
    onDownload: vi.fn<(base: ModelBaseId) => void>(),
    onCancelDownload: vi.fn<(base: ModelBaseId) => void>(),
    onRemove: vi.fn<(base: ModelBaseId) => void>(),
    onToggleEnglishOnly: vi.fn<(englishOnly: boolean) => void>(),
    onClose: vi.fn<() => void>(),
  }
}

function renderPicker(
  rows: ModelRow[],
  h: Handlers,
  options: {
    settings?: Settings
    downloadingBase?: ModelBaseId | null
    firstRun?: boolean
  } = {},
) {
  return render(
    <ModelPicker
      rows={rows}
      settings={options.settings ?? DEFAULT_SETTINGS}
      downloadingBase={options.downloadingBase ?? null}
      onChoose={h.onChoose}
      onDownload={h.onDownload}
      onCancelDownload={h.onCancelDownload}
      onRemove={h.onRemove}
      onToggleEnglishOnly={h.onToggleEnglishOnly}
      onClose={options.firstRun ? undefined : h.onClose}
      firstRun={options.firstRun ?? false}
    />,
  )
}

function labelsOf(): string[] {
  return [...document.querySelectorAll('.model-row-label')].map((el) => el.textContent ?? '')
}

describe('ModelPicker', () => {
  it('renders exactly five rows, in the order given, without re-sorting', () => {
    const reversed = [...BASES].reverse()
    renderPicker(rowsFor(reversed), handlers())

    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(labelsOf()).toEqual(reversed)
  })

  it("shows each row's label, size and blurb", () => {
    const rows = [
      modelRow({
        base: 'base',
        resolved: {
          id: 'base',
          base: 'base',
          label: 'Base',
          bytes: 147_951_465,
          sha256: 'x'.repeat(64),
          url: 'https://example.invalid/base',
          blurb: 'Good default. Quick, decent accuracy.',
          englishOnly: false,
        },
      }),
    ]
    renderPicker(rows, handlers())

    expect(screen.getByText('Base')).toBeTruthy()
    expect(screen.getByText('148 MB')).toBeTruthy()
    expect(screen.getByText('Good default. Quick, decent accuracy.')).toBeTruthy()
  })

  it('shows ~12× realtime on your machine for a row with realtimeFactor: 12.4', () => {
    renderPicker([modelRow({ base: 'base', realtimeFactor: 12.4 })], handlers())

    expect(screen.getByText('~12× realtime on your machine')).toBeTruthy()
  })

  it('renders no speed text at all for a row with no realtimeFactor', () => {
    renderPicker([modelRow({ base: 'base' })], handlers())

    expect(document.querySelector('.model-row-speed')).toBeNull()
  })

  it('with englishOnly off, rows resolve to the multilingual ids, show plain (non-.en) labels, and no partial-swap note appears', () => {
    const rows: ModelRow[] = [
      modelRow({
        base: 'tiny',
        resolved: {
          id: 'tiny',
          base: 'tiny',
          label: 'Tiny',
          bytes: 1,
          sha256: 'x',
          url: 'x',
          blurb: 'x',
          englishOnly: false,
        },
      }),
    ]
    renderPicker(rows, handlers(), { settings: { ...DEFAULT_SETTINGS, englishOnly: false } })

    expect(document.querySelector('.model-row-note')).toBeNull()
    expect(labelsOf()).toEqual(['Tiny'])
  })

  it('with englishOnly on, the tiny/base/small rows show their .en labels and the two large rows carry the note', () => {
    const rows: ModelRow[] = [
      modelRow({
        base: 'tiny',
        resolved: {
          id: 'tiny.en',
          base: 'tiny',
          label: 'Tiny (English)',
          bytes: 1,
          sha256: 'x',
          url: 'x',
          blurb: 'x',
          englishOnly: true,
        },
      }),
      modelRow({
        base: 'large-v3-turbo',
        resolved: {
          id: 'large-v3-turbo',
          base: 'large-v3-turbo',
          label: 'Large v3 Turbo',
          bytes: 1,
          sha256: 'x',
          url: 'x',
          blurb: 'x',
          englishOnly: false,
        },
      }),
      modelRow({
        base: 'large-v3',
        resolved: {
          id: 'large-v3',
          base: 'large-v3',
          label: 'Large v3',
          bytes: 1,
          sha256: 'x',
          url: 'x',
          blurb: 'x',
          englishOnly: false,
        },
      }),
    ]
    renderPicker(rows, handlers(), { settings: { ...DEFAULT_SETTINGS, englishOnly: true } })

    // The .en swap actually happened: the tiny row's label reflects the
    // resolved .en model, not the plain 'tiny' catalog entry.
    expect(labelsOf()).toEqual(['Tiny (English)', 'Large v3 Turbo', 'Large v3'])

    expect(document.querySelectorAll('.model-row-note')).toHaveLength(2)
    expect(
      screen.getAllByText(
        'No English-only weights exist above small — these stay multilingual, and are still the most accurate option for English.',
      ),
    ).toHaveLength(2)
  })

  it('flipping the toggle calls onToggleEnglishOnly(true) exactly once', () => {
    const h = handlers()
    renderPicker(rowsFor(), h, { settings: { ...DEFAULT_SETTINGS, englishOnly: false } })

    fireEvent.click(screen.getByRole('switch'))

    expect(h.onToggleEnglishOnly).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('a row whose installed flips from true to false after a toggle shows a Download button, not Remove', () => {
    const h = handlers()
    const { rerender } = render(
      <ModelPicker
        rows={[modelRow({ base: 'base', installed: true })]}
        settings={DEFAULT_SETTINGS}
        downloadingBase={null}
        onChoose={h.onChoose}
        onDownload={h.onDownload}
        onCancelDownload={h.onCancelDownload}
        onRemove={h.onRemove}
        onToggleEnglishOnly={h.onToggleEnglishOnly}
        onClose={h.onClose}
        firstRun={false}
      />,
    )
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()

    rerender(
      <ModelPicker
        rows={[modelRow({ base: 'base', installed: false })]}
        settings={{ ...DEFAULT_SETTINGS, englishOnly: true }}
        downloadingBase={null}
        onChoose={h.onChoose}
        onDownload={h.onDownload}
        onCancelDownload={h.onCancelDownload}
        onRemove={h.onRemove}
        onToggleEnglishOnly={h.onToggleEnglishOnly}
        onClose={h.onClose}
        firstRun={false}
      />,
    )
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it("an uninstalled row's Download button calls onDownload(base)", () => {
    const h = handlers()
    renderPicker([modelRow({ base: 'small', installed: false })], h)

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))

    expect(h.onDownload).toHaveBeenCalledExactlyOnceWith('small')
  })

  it("a downloading row shows a progressbar whose aria-valuenow matches the received/total ratio, plus a Cancel button and no Download button", () => {
    const h = handlers()
    renderPicker(
      [
        modelRow({
          base: 'small',
          installed: false,
          downloading: { id: 'small', receivedBytes: 30, totalBytes: 120, bytesPerSecond: 5 },
        }),
      ],
      h,
    )

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      String(formatPercent(30 / 120)),
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('cancel on a downloading row calls onCancelDownload(base)', () => {
    const h = handlers()
    renderPicker(
      [
        modelRow({
          base: 'small',
          installed: false,
          downloading: { id: 'small', receivedBytes: 30, totalBytes: 120, bytesPerSecond: 5 },
        }),
      ],
      h,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(h.onCancelDownload).toHaveBeenCalledExactlyOnceWith('small')
  })

  it('an installed row shows Remove, and clicking it calls onRemove(base)', () => {
    const h = handlers()
    renderPicker([modelRow({ base: 'small', installed: true })], h, {
      settings: { ...DEFAULT_SETTINGS, activeModel: 'base' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(h.onRemove).toHaveBeenCalledExactlyOnceWith('small')
  })

  it('choosing an installed row calls onChoose(base)', () => {
    const h = handlers()
    renderPicker([modelRow({ base: 'small', installed: true })], h, {
      settings: { ...DEFAULT_SETTINGS, activeModel: 'base' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Use this model' }))

    expect(h.onChoose).toHaveBeenCalledExactlyOnceWith('small')
  })

  it('the active row is marked aria-current="true" and its choose control is disabled', () => {
    const h = handlers()
    renderPicker([modelRow({ base: 'base', installed: true })], h, {
      settings: { ...DEFAULT_SETTINGS, activeModel: 'base' },
    })

    expect(screen.getByRole('listitem').getAttribute('aria-current')).toBe('true')
    expect((screen.getByRole('button', { name: 'Use this model' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('in firstRun mode there is no close button and no role="dialog"', () => {
    renderPicker(rowsFor(), handlers(), { firstRun: true })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('outside first run it is a role="dialog" with aria-modal, and Escape calls onClose', () => {
    const h = handlers()
    renderPicker(rowsFor(), h, { firstRun: false })

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(h.onClose).toHaveBeenCalledOnce()
  })

  // M8 regression test removed here (was: 'still shows the partial-swap note
  // even if the resolved id does not equal the base id'). It constructed
  // `resolved.id: 'large-v3'` equal to `base: 'large-v3'` despite an inline
  // comment claiming otherwise, so restoring the deleted
  // `row.resolved.id === row.base &&` clause left it passing unchanged — it
  // proved nothing about the fix it claimed to guard. It also cannot be
  // rewritten into a genuine mismatch: `ModelId` only offers a `.en`
  // alternate for `tiny`/`base`/`small`, and `resolveModelId` always returns
  // `base` itself for `large-v3`/`large-v3-turbo` (the only
  // `NO_PARTIAL_SWAP_BASES` members), so `resolved.id === base` is a real
  // invariant for every row this note can appear on — no legitimately typed
  // `ModelRow` can produce the mismatch this test wanted to exercise. The
  // dead-clause removal in `ModelPicker.tsx` itself is still correct and
  // low-risk; M7's `labelsOf()` assertions above already cover the note's
  // actual rendering logic (`englishOnly && NO_PARTIAL_SWAP_BASES.has(row.base)`,
  // which never referenced `resolved.id` in the first place).

  // M13: aria-modal="true" alone doesn't stop Tab from reaching the header
  // behind the scrim — this proves the trap that keeps it inside the dialog.
  it('traps Tab focus inside the dialog, wrapping from the last focusable element back to the first', () => {
    const h = handlers()
    renderPicker([modelRow({ base: 'small', installed: false })], h, { firstRun: false })

    const closeButton = screen.getByRole('button', { name: 'Close' })
    const downloadButton = screen.getByRole('button', { name: 'Download' })

    downloadButton.focus()
    expect(document.activeElement).toBe(downloadButton)
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton)

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(downloadButton)
  })
})
