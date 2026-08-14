import { describe, expect, it } from 'vitest'
import { CSP_DEVELOPMENT, CSP_PRODUCTION, cspFor, cspForBuild } from '../../src/shared/csp.js'

describe('the production policy', () => {
  it('allows scripts only from the app itself', () => {
    expect(CSP_PRODUCTION).toContain("script-src 'self'")
    expect(CSP_PRODUCTION).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(CSP_PRODUCTION).not.toContain('unsafe-eval')
  })

  it('names no remote origin', () => {
    expect(CSP_PRODUCTION).not.toMatch(/https?:/)
    expect(CSP_PRODUCTION).not.toMatch(/wss?:/)
    expect(CSP_PRODUCTION).not.toContain('*')
  })

  it('defaults to self and blocks plugins, base tags, forms and framing', () => {
    expect(CSP_PRODUCTION).toContain("default-src 'self'")
    expect(CSP_PRODUCTION).toContain("object-src 'none'")
    expect(CSP_PRODUCTION).toContain("base-uri 'none'")
    expect(CSP_PRODUCTION).toContain("form-action 'none'")
    expect(CSP_PRODUCTION).toContain("frame-ancestors 'none'")
  })

  it('allows inline styles, which Vite needs and which execute no script', () => {
    expect(CSP_PRODUCTION).toContain("style-src 'self' 'unsafe-inline'")
  })
})

describe('cspFor', () => {
  it('returns the strict policy for production', () => {
    expect(cspFor('production')).toBe(CSP_PRODUCTION)
  })

  it('relaxes only script-src for development', () => {
    expect(cspFor('development')).toBe(CSP_DEVELOPMENT)
    expect(CSP_DEVELOPMENT).toContain("script-src 'self' 'unsafe-inline'")
    expect(CSP_DEVELOPMENT.replace(" 'unsafe-inline'", '')).toBe(CSP_PRODUCTION)
  })
})

describe('cspForBuild', () => {
  it('permits the Fast Refresh inline script when building for the dev server', () => {
    expect(cspForBuild(true)).toBe(CSP_DEVELOPMENT)
    expect(cspForBuild(true)).toContain("script-src 'self' 'unsafe-inline'")
  })

  it('ships the strict policy otherwise, with no inline script-src and no remote origin', () => {
    const policy = cspForBuild(false)
    expect(policy).toBe(CSP_PRODUCTION)
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).not.toMatch(/https?:/)
    expect(policy).not.toMatch(/wss?:/)
  })
})
