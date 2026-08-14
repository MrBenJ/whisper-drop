/**
 * The renderer loads nothing from the network, so the policy is `'self'`
 * throughout. `style-src` allows inline styles because Vite injects CSS as
 * `<style>` elements; inline *style* is not a script-execution vector.
 */
export const CSP_PRODUCTION = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Dev only. `@vitejs/plugin-react` injects its Fast Refresh preamble as an
 * inline module script, which `script-src 'self'` blocks. `'self'` already
 * covers the HMR websocket: CSP matches `ws://` against an `http://` document
 * origin. This string must never reach a packaged build.
 */
export const CSP_DEVELOPMENT = CSP_PRODUCTION.replace(
  "script-src 'self'",
  "script-src 'self' 'unsafe-inline'",
)

export function cspFor(mode: 'development' | 'production'): string {
  return mode === 'production' ? CSP_PRODUCTION : CSP_DEVELOPMENT
}
