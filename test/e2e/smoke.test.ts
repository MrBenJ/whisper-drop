import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { whisperCliPath } from '../../src/main/binaries.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE = join(ROOT, 'test/fixtures/hello.mp4')
const TINY_MODEL = join(ROOT, '.cache/models/ggml-tiny.bin')

let userData: string
let app: ElectronApplication
let page: Page

beforeAll(async () => {
  expect(existsSync(join(ROOT, 'out/main/index.js')), 'run `npm run build` first').toBe(true)
  expect(existsSync(TINY_MODEL), 'run `node scripts/fetch-test-model.mjs` first').toBe(true)
  // `npm run setup` compiles whisper.cpp via cmake, which can take minutes —
  // deliberately not triggered automatically from here (that would turn a
  // clear, fast failure into an opaque, silent multi-minute wait, the same
  // class of problem this check exists to catch). Checked before Electron
  // ever launches, so a fresh checkout fails in milliseconds with an
  // actionable message instead of the app going quiet for ~5 minutes with
  // NO_MODEL_INSTALLED/timeout as the only eventual symptom.
  expect(existsSync(whisperCliPath()), 'whisper-cli not found — run `npm run setup` first').toBe(
    true,
  )

  // A throwaway user-data directory, pre-seeded so the app starts past first
  // run. `--user-data-dir` is a Chromium switch Electron honours, which is why
  // no test-only seam is needed in the app itself.
  userData = await mkdtemp(join(tmpdir(), 'whisper-drop-e2e-'))
  await mkdir(join(userData, 'models'), { recursive: true })
  await copyFile(TINY_MODEL, join(userData, 'models', 'tiny.bin'))
  // Asserted separately from the source-file check above: if the copy silently
  // failed or landed at the wrong path, the failure should say so, rather than
  // surfacing 240 seconds later as a mysterious NO_MODEL_INSTALLED/timeout.
  expect(existsSync(join(userData, 'models', 'tiny.bin')), 'seeded model did not land in userData').toBe(
    true,
  )
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      englishOnly: false,
      activeModel: 'tiny',
      language: 'en',
      throughput: {},
    }),
    'utf8',
  )

  app = await electron.launch({ args: [ROOT, `--user-data-dir=${userData}`] })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

afterAll(async () => {
  await app?.close()
  await rm(userData, { recursive: true, force: true })
})

describe('the packaged renderer', () => {
  it('has no Node in the renderer', async () => {
    expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
      'undefined',
    )
    expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe(
      'undefined',
    )
  })

  it('exposes exactly the bridged API and nothing else', async () => {
    expect(
      await page.evaluate(() =>
        Object.keys((globalThis as unknown as { whisperDrop: object }).whisperDrop).sort(),
      ),
    ).toEqual([
      'dialog',
      'droppedFile',
      'exportTranscript',
      'models',
      'settings',
      'shell',
      'transcribe',
    ])
  })
})

describe('transcribing the committed fixture end to end', () => {
  it('renders a transcript containing the spoken words', async () => {
    // The open dialog is native, so it is replaced in main rather than driven.
    // This is the browse path the drop zone falls back to, and it exercises
    // the same start -> IPC -> job -> state-forwarding wiring a drop does.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
    }, FIXTURE)

    await page.getByTestId('browse').click()

    await expect
      .poll(async () => (await page.getByTestId('transcript').textContent()) ?? '', {
        timeout: 240_000,
        interval: 500,
      })
      .toMatch(/testing/i)
  })

  it('shows the source filename while it works and after it finishes', async () => {
    await expect.poll(() => page.getByTestId('source-name').textContent()).toBe('hello.mp4')
  })
})
