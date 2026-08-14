/// <reference types="vite/client" />

import type { WhisperDropApi } from '../shared/ipc.js'

declare global {
  interface Window {
    /** The complete surface the renderer has. There is no other way out. */
    readonly whisperDrop: WhisperDropApi
  }
}
