import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * House copy rule: no em- or en-dashes anywhere a user can read, which in
 * this codebase means string literals and JSX text. Comments are exempt.
 * Enforced by scanning every source file with comments stripped, so a new
 * string added anywhere in src/ can't quietly reintroduce one.
 */

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url))
const SOURCE_EXTENSION = /\.(?:tsx?|css|html)$/

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (SOURCE_EXTENSION.test(entry.name)) files.push(path)
  }
  return files
}

/** Strips /* ... *​/ blocks and full-or-trailing // comments. `//` preceded by
 * `:` survives, so a URL inside a string is still scanned. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
}

describe('user-visible copy', () => {
  it('contains no em- or en-dashes outside comments, in any source file', async () => {
    const offenders: string[] = []

    for (const path of await sourceFiles(SRC_DIR)) {
      const stripped = stripComments(await readFile(path, 'utf8'))
      stripped.split('\n').forEach((line, index) => {
        if (line.includes('—') || line.includes('–')) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`)
        }
      })
    }

    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
