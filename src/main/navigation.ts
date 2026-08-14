/**
 * The shell only ever stays on the document it loaded. A transcript is
 * arbitrary text, so any navigation it can provoke — a link, a redirect, a
 * `location.assign` — is denied. Reloads target the same URL and are allowed,
 * which is what keeps Vite's dev HMR working.
 */
export function isAllowedNavigation(currentUrl: string, targetUrl: string): boolean {
  return targetUrl === currentUrl
}
