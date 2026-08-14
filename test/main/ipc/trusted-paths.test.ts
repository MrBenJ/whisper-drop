import { describe, expect, it } from 'vitest'
import { createTrustedPaths } from '../../../src/main/ipc/trusted-paths.js'

describe('createTrustedPaths', () => {
  it('consumes a path it issued', () => {
    const paths = createTrustedPaths()
    paths.issue('/videos/a.mp4')

    expect(paths.consume('/videos/a.mp4')).toBe(true)
  })

  it('refuses a path it never issued', () => {
    const paths = createTrustedPaths()

    expect(paths.consume('/etc/passwd')).toBe(false)
  })

  it('cannot be consumed twice', () => {
    const paths = createTrustedPaths()
    paths.issue('/videos/a.mp4')
    paths.consume('/videos/a.mp4')

    expect(paths.consume('/videos/a.mp4')).toBe(false)
  })

  it('tracks each issued path independently', () => {
    const paths = createTrustedPaths()
    paths.issue('/a.mp4')
    paths.issue('/b.mp4')

    expect(paths.consume('/a.mp4')).toBe(true)
    expect(paths.consume('/b.mp4')).toBe(true)
  })

  it('does not grow without bound when paths are issued and never consumed', () => {
    const paths = createTrustedPaths()
    for (let i = 0; i < 1_000; i++) paths.issue(`/videos/${i}.mp4`)

    // The oldest entries were evicted; the most recent one is still trusted.
    expect(paths.consume('/videos/999.mp4')).toBe(true)
    expect(paths.consume('/videos/0.mp4')).toBe(false)
  })

  it('has checks without consuming', () => {
    const paths = createTrustedPaths()
    paths.issue('/videos/a.mp4')

    expect(paths.has('/videos/a.mp4')).toBe(true)
    expect(paths.has('/videos/a.mp4')).toBe(true)
    expect(paths.consume('/videos/a.mp4')).toBe(true)
  })

  it('has returns false for a path never issued', () => {
    const paths = createTrustedPaths()

    expect(paths.has('/etc/passwd')).toBe(false)
  })

  it('has returns false once the entry has been consumed', () => {
    const paths = createTrustedPaths()
    paths.issue('/videos/a.mp4')
    paths.consume('/videos/a.mp4')

    expect(paths.has('/videos/a.mp4')).toBe(false)
  })
})
