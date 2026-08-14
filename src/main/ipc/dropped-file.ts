import { requireNonEmptyString } from './validate.js'

export type DroppedFileDeps = {
  /** Records the path as trusted, so `transcribe.start` will accept it. */
  issuePath: (path: string) => void
}

export type DroppedFileHandlers = {
  register(path: unknown): Promise<void>
}

/**
 * The preload resolves a dropped `File`'s real path via
 * `webUtils.getPathForFile` and reports it here, so `transcribe.start` can
 * trust it later. This is the second of the two ways a path enters the
 * renderer — `dialog.openFile` is the first. Neither spec lists this channel:
 * it exists purely to close the trust boundary, not as a capability the
 * renderer calls deliberately.
 */
export function createDroppedFileHandlers(deps: DroppedFileDeps): DroppedFileHandlers {
  return {
    async register(path: unknown): Promise<void> {
      deps.issuePath(requireNonEmptyString(path, 'path'))
    },
  }
}
