// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../../src/renderer/App.js'
import { installFakeApi } from './fake-api.js'

describe('App', () => {
  it('unsubscribes from transcribe.onState and models.onProgress on unmount', async () => {
    const fake = installFakeApi()

    const { unmount } = render(<App />)

    await waitFor(() => {
      expect(fake.api.settings.get).toHaveBeenCalled()
    })

    // Proves the subscription happened at all — a `0` here from a broken
    // effect would otherwise let the unmount assertion below pass vacuously.
    expect(fake.stateSubscribers()).toBe(1)
    expect(fake.progressSubscribers()).toBe(1)

    unmount()

    expect(fake.stateSubscribers()).toBe(0)
    expect(fake.progressSubscribers()).toBe(0)
  })
})
