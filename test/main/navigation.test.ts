import { describe, expect, it } from 'vitest'
import { isAllowedNavigation } from '../../src/main/navigation.js'

describe('isAllowedNavigation', () => {
  it('allows a reload of the document already loaded', () => {
    expect(isAllowedNavigation('http://localhost:5173/', 'http://localhost:5173/')).toBe(true)
  })

  it('denies anything a transcript could point at', () => {
    const current = 'file:///Applications/whisper-drop.app/renderer/index.html'

    for (const target of [
      'https://example.com/',
      'http://localhost:5173/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///Applications/whisper-drop.app/renderer/index.html#x',
    ]) {
      expect(isAllowedNavigation(current, target), target).toBe(false)
    }
  })
})
