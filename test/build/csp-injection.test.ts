import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { injectCsp } from '../../electron.vite.config.js'
import { CSP_DEVELOPMENT, CSP_PRODUCTION } from '../../src/shared/csp.js'

/**
 * M14: the CSP reaches the built renderer by string-replacing `</head>` in
 * `electron.vite.config.ts`'s `transformIndexHtml` hook. A whitespace or
 * casing change to the real `src/renderer/index.html` would silently make
 * that replace a no-op, shipping a CSP-less renderer behind a green build —
 * nothing else in the suite reads the actual HTML source, so nothing else
 * would catch it. This reads the real file and runs it through the same
 * function the build uses.
 */

const INDEX_HTML_PATH = new URL('../../src/renderer/index.html', import.meta.url)

describe('CSP injection into the built renderer HTML', () => {
  it('inserts the production policy into the real index.html source, before </head>', async () => {
    const html = await readFile(INDEX_HTML_PATH, 'utf8')
    const injected = injectCsp(html, CSP_PRODUCTION)

    expect(injected).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${CSP_PRODUCTION}">`,
    )
    expect(injected.indexOf('Content-Security-Policy')).toBeLessThan(injected.indexOf('</head>'))
  })

  it('inserts the development policy the same way', async () => {
    const html = await readFile(INDEX_HTML_PATH, 'utf8')
    const injected = injectCsp(html, CSP_DEVELOPMENT)

    expect(injected).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${CSP_DEVELOPMENT}">`,
    )
  })

  it('leaves the head-close tag itself intact, right after the inserted tag', async () => {
    const html = await readFile(INDEX_HTML_PATH, 'utf8')
    const injected = injectCsp(html, CSP_PRODUCTION)

    expect(injected).toMatch(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*<\/head>/)
    // Nothing was duplicated or dropped: exactly one </head> remains.
    expect(injected.match(/<\/head>/g)).toHaveLength(1)
  })

  it('throws rather than silently shipping a CSP-less page when </head> is missing', () => {
    expect(() => injectCsp('<html><body>no head here</body></html>', CSP_PRODUCTION)).toThrow(
      /whisper-drop-csp/,
    )
  })

  it('would have caught a whitespace regression in the real file (regression guard)', async () => {
    const html = await readFile(INDEX_HTML_PATH, 'utf8')
    const mangled = html.replace('</head>', '</head >')

    expect(() => injectCsp(mangled, CSP_PRODUCTION)).toThrow(/whisper-drop-csp/)
  })
})
