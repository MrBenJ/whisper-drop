/**
 * A filesystem path reaches the renderer in exactly two ways: the open
 * dialog (`dialog.openFile`) and a dropped file resolved via
 * `webUtils.getPathForFile` in the preload (`droppedFile.pathFor`). Both are
 * issued here before the renderer ever sees them. `transcribe.start` consumes
 * an entry before it will act on a path, so a compromised renderer cannot ask
 * main to transcribe a file the user never actually chose.
 */
export type TrustedPaths = {
  issue(path: string): void
  /**
   * Non-consuming: true if `path` is still trusted. `transcribe.start` checks
   * this before any later step that can still reject the request (busy, no
   * model, model missing) — a rejection there must not burn the one path a
   * retry would need. See `consume`.
   */
  has(path: string): boolean
  /** True and removes the entry; false leaves nothing behind to retry. */
  consume(path: string): boolean
}

/** Bounds memory if paths are issued and the job that would consume them never starts. */
const MAX_ISSUED = 500

export function createTrustedPaths(): TrustedPaths {
  const issued = new Set<string>()

  return {
    issue(path) {
      if (issued.size >= MAX_ISSUED) {
        const oldest = issued.values().next().value
        if (oldest !== undefined) issued.delete(oldest)
      }
      issued.add(path)
    },
    has(path) {
      return issued.has(path)
    },
    consume(path) {
      return issued.delete(path)
    },
  }
}
