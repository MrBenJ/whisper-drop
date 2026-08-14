import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
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

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found: string[] = []

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)))
    else if (/\.tsx?$/.test(entry.name)) found.push(full)
  }

  return found
}

const FILES = await sourceFiles(SRC)
const key = (file: string): string => relative(SRC, file).split(sep).join('/')

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
})
