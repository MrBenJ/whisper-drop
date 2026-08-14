export type DialogDeps = {
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>
  /** Records the chosen path as trusted, so `transcribe.start` will accept it. */
  issuePath: (path: string) => void
}

export type DialogHandlers = {
  openFile(): Promise<string | null>
}

/**
 * No extension filter: file validity is ffprobe's answer, not a list of
 * extensions. The dialog is the click-to-browse fallback for the drop zone,
 * and one of the two ways a path enters the renderer — see `trusted-paths.ts`.
 */
export function createDialogHandlers(deps: DialogDeps): DialogHandlers {
  return {
    async openFile(): Promise<string | null> {
      const result = await deps.showOpenDialog()
      if (result.canceled) return null

      const path = result.filePaths[0] ?? null
      if (path !== null) deps.issuePath(path)
      return path
    },
  }
}
