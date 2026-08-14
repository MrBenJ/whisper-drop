import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

/**
 * The four files that own the Electron surface. Everything else stays plain
 * Node, which is what keeps the unit suite running without an app harness.
 */
const MAY_IMPORT_ELECTRON = new Set([
  'main/index.ts',
  'main/window.ts',
  'main/ipc/index.ts',
  'preload/index.ts',
])

const ELECTRON_IMPORT = /(?:from|import|require)\s*\(?\s*['"]electron['"]/
const NODE_BUILTIN_IMPORT = /(?:from|import|require)\s*\(?\s*['"]node:/
// `global` is deliberately excluded: it is common in ordinary prose/comments
// and TypeScript's own `globalThis` typings, and every real Node escape hatch
// this is meant to catch already goes through one of the other four names.
const NODE_GLOBAL = /\b(?:process|require|__dirname|__filename|Buffer)\b/
// Captures the specifier of every import/export/require, relative or not —
// filtered down to relative ones by the caller, which is what the transitive
// walk below follows.
const IMPORT_SPECIFIER = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

// Covers every source-file extension this project's ESM style can produce,
// not just `.ts`/`.tsx` — a `.cjs`/`.mjs` helper that `require`s electron
// would otherwise be invisible to every check in this file.
const SOURCE_EXTENSION = /\.(?:tsx?|mts|cts|mjs|cjs|js)$/

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)))
    else if (SOURCE_EXTENSION.test(entry.name)) found.push(full)
  }

  return found
}

const FILES = await sourceFiles(SRC)
const key = (file: string): string => relative(SRC, file).split(sep).join('/')

/**
 * Resolves a relative specifier back to the source file it names. This
 * project's ESM style writes `.js`/`.jsx`/`.mjs`/`.cjs` specifiers that refer
 * to `.ts`/`.tsx`/`.mts`/`.cts` source, so those extensions are tried first;
 * a literal or extensionless specifier falls back to trying the specifier
 * itself, then each source extension, then an `index` file in that directory.
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const target = resolve(dirname(fromFile), specifier)
  const ext = extname(target)
  const stem = ext ? target.slice(0, -ext.length) : target

  const swapped: Record<string, string> = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' }
  const candidates = ext
    ? [swapped[ext] ? stem + swapped[ext] : null, target].filter((c): c is string => c !== null)
    : [target + '.ts', target + '.tsx', join(target, 'index.ts'), join(target, 'index.tsx')]

  return candidates.find(existsSync) ?? null
}

function relativeSpecifiers(contents: string): string[] {
  const specifiers: string[] = []
  for (const match of contents.matchAll(IMPORT_SPECIFIER)) {
    if (match[1]?.startsWith('.')) specifiers.push(match[1])
  }
  return specifiers
}

/**
 * Follows relative imports from `file` looking for one that imports
 * `electron` directly, so a `src/shared` or `src/renderer` file that reaches
 * Electron only by importing a shell file (with no `'electron'` string of
 * its own) is still caught. Returns the chain of files from `file` down to
 * `'electron'`, or `null` if nothing in the reachable graph imports it.
 */
async function findElectronChain(file: string, visiting: string[] = []): Promise<string[] | null> {
  if (visiting.includes(file)) return null // cycle guard
  const contents = await readFile(file, 'utf8')
  const chain = [...visiting, file]

  if (ELECTRON_IMPORT.test(contents)) return [...chain.map(key), 'electron']

  for (const specifier of relativeSpecifiers(contents)) {
    const resolved = resolveRelativeImport(file, specifier)
    if (!resolved) continue
    const found = await findElectronChain(resolved, chain)
    if (found) return found
  }

  return null
}

/** Shared between the renderer and shared-code checks below — same rule, two directories. */
function checksNodeFreedom(dirPrefix: string) {
  return async (): Promise<void> => {
    const offenders: string[] = []

    for (const file of FILES.filter((f) => key(f).startsWith(dirPrefix))) {
      const contents = await readFile(file, 'utf8')
      if (NODE_BUILTIN_IMPORT.test(contents) || NODE_GLOBAL.test(contents)) {
        offenders.push(key(file))
      }
    }

    expect(offenders).toEqual([])
  }
}

/** Shared between the renderer and shared-code transitive checks below. */
function checksNoElectronReach(dirPrefix: string) {
  return async (): Promise<void> => {
    const chains: string[] = []

    for (const file of FILES.filter((f) => key(f).startsWith(dirPrefix))) {
      const chain = await findElectronChain(file)
      if (chain) chains.push(chain.join(' -> '))
    }

    expect(chains).toEqual([])
  }
}

describe('the Electron boundary', () => {
  it('finds source files to check, so a broken walk cannot pass silently', () => {
    expect(FILES.length).toBeGreaterThan(15)
  })

  it('lets only the four shell files import electron', async () => {
    const offenders: string[] = []

    for (const file of FILES) {
      const name = key(file)
      if (MAY_IMPORT_ELECTRON.has(name)) continue
      if (ELECTRON_IMPORT.test(await readFile(file, 'utf8'))) offenders.push(name)
    }

    expect(offenders).toEqual([])
  })

  it('keeps node builtins and node globals out of the renderer', checksNodeFreedom('renderer/'))

  // The renderer typechecks under tsconfig.web.json alongside src/shared, so
  // shared code that quietly depended on Node would still pass tsc — only
  // this test catches it.
  it('keeps node builtins and node globals out of shared code', checksNodeFreedom('shared/'))

  it('keeps main out of the renderer, so the renderer cannot reach the filesystem', async () => {
    const offenders: string[] = []

    for (const file of FILES.filter((f) => key(f).startsWith('renderer/'))) {
      if (/from\s+['"][^'"]*\/main\//.test(await readFile(file, 'utf8'))) offenders.push(key(file))
    }

    expect(offenders).toEqual([])
  })

  // The per-file check above only catches a literal `'electron'` string in
  // the file itself. A shared/renderer file that imports an allowlisted
  // shell file (e.g. `main/window.js`) reaches Electron one hop away with no
  // such string of its own, and neither tsc nor the direct check would flag
  // it. This follows the actual import graph instead.
  it('keeps shared code from transitively reaching electron', checksNoElectronReach('shared/'))
  it('keeps the renderer from transitively reaching electron', checksNoElectronReach('renderer/'))

  it('keeps every ipc handler module electron-free except its index', async () => {
    const handlers = FILES.filter(
      (file) => key(file).startsWith('main/ipc/') && key(file) !== 'main/ipc/index.ts',
    )

    expect(handlers.length).toBeGreaterThan(3)
    for (const file of handlers) {
      expect(ELECTRON_IMPORT.test(await readFile(file, 'utf8')), key(file)).toBe(false)
    }
  })
})
