import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * The stylesheet defines the dark palette twice, because dark can win two
 * ways: the OS is dark and the user hasn't chosen light (a media query), or
 * the user explicitly chose dark (a data-theme attribute). Nothing in the
 * cascade ties the two blocks together, so a color edited in one and
 * forgotten in the other ships an app whose "Dark" setting and OS-dark
 * appearance silently disagree. This reads the real stylesheet and asserts
 * the two blocks carry identical tokens.
 */

const CSS_PATH = new URL('../../src/renderer/styles.css', import.meta.url)

/** The `{ ... }` body starting at the first `{` at or after `from`. */
function blockBody(css: string, from: number): string {
  const open = css.indexOf('{', from)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error('unbalanced braces in styles.css')
}

function tokensIn(body: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) {
      tokens[name] = value.replace(/\s+/g, ' ').trim()
    }
  }
  return tokens
}

async function readCss(): Promise<string> {
  return readFile(CSS_PATH, 'utf8')
}

describe('theme tokens', () => {
  it('defines the same dark palette for OS-dark and explicit-dark', async () => {
    const css = await readCss()

    const mediaAt = css.indexOf('@media (prefers-color-scheme: dark)')
    expect(mediaAt).toBeGreaterThan(-1)
    // The media block wraps a selector block; the inner body holds the tokens.
    const mediaInner = blockBody(css, css.indexOf('{', mediaAt) + 1)

    const explicitAt = css.indexOf(":root[data-theme='dark']")
    expect(explicitAt).toBeGreaterThan(-1)
    const explicitInner = blockBody(css, explicitAt)

    const mediaTokens = tokensIn(mediaInner)
    const explicitTokens = tokensIn(explicitInner)

    expect(Object.keys(mediaTokens).length).toBeGreaterThan(0)
    expect(explicitTokens).toEqual(mediaTokens)
  })

  it('lets an explicit light choice beat OS-dark', async () => {
    const css = await readCss()
    expect(css).toContain(":root:not([data-theme='light'])")
  })

  it('never introduces a dark-only token with no light fallback', async () => {
    const css = await readCss()

    const rootAt = css.indexOf(':root {')
    expect(rootAt).toBeGreaterThan(-1)
    const rootTokens = tokensIn(blockBody(css, rootAt))

    const mediaAt = css.indexOf('@media (prefers-color-scheme: dark)')
    const mediaTokens = tokensIn(blockBody(css, css.indexOf('{', mediaAt) + 1))

    for (const name of Object.keys(mediaTokens)) {
      expect(rootTokens, `dark defines ${name} but bare :root does not`).toHaveProperty(name)
    }
  })
})
