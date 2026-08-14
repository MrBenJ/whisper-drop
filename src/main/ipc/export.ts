import { AppError } from '../../shared/errors.js'
import type { ExportFormat, JobState, Segment } from '../../shared/types.js'
import { IpcError } from './errors.js'
import { requireExportFormat, requireNonEmptyString } from './validate.js'

export type ExportDeps = {
  lookupJob: (jobId: string) => JobState | undefined
  writeTranscript: (options: {
    segments: Segment[]
    sourcePath: string
    as: ExportFormat
  }) => Promise<string>
  reveal: (path: string) => void
}

export type ExportHandlers = {
  save(jobId: unknown, as: unknown): Promise<string>
  reveal(path: unknown): Promise<void>
}

/** Same bound as trusted-paths.ts's MAX_ISSUED, and for the same reason: caps
 * memory if the app runs a long time and exports without ever revealing. */
const MAX_REVEALABLE = 500

export function createExportHandlers(deps: ExportDeps): ExportHandlers {
  // Reveal only ever surfaces a path this process itself produced. The
  // renderer cannot name one.
  const revealable = new Set<string>()

  async function save(jobId: unknown, as: unknown): Promise<string> {
    const id = requireNonEmptyString(jobId, 'jobId')
    const format = requireExportFormat(as)

    const state = deps.lookupJob(id)
    if (!state) {
      throw new IpcError('INVALID_REQUEST', 'That transcript is no longer available.', `jobId=${id}`)
    }
    if (state.phase !== 'done') {
      throw new IpcError(
        'INVALID_REQUEST',
        'That transcript is not finished yet.',
        `phase=${state.phase}`,
      )
    }

    let path: string
    try {
      // sourcePath comes from main's own record of the job, never from the
      // renderer — the renderer supplies a Map key and a format literal, and
      // nothing else reaches the filesystem.
      path = await deps.writeTranscript({
        segments: state.segments,
        sourcePath: state.filePath,
        as: format,
      })
    } catch (cause) {
      if (cause instanceof AppError || cause instanceof IpcError) throw cause
      throw new IpcError(
        'UNEXPECTED',
        "Couldn't save the transcript. Check you can write to that folder.",
        cause instanceof Error ? cause.message : String(cause),
      )
    }

    if (revealable.size >= MAX_REVEALABLE) {
      const oldest = revealable.values().next().value
      if (oldest !== undefined) revealable.delete(oldest)
    }
    revealable.add(path)
    return path
  }

  async function reveal(path: unknown): Promise<void> {
    const target = requireNonEmptyString(path, 'path')
    if (!revealable.has(target)) {
      throw new IpcError(
        'INVALID_REQUEST',
        "That file wasn't written by whisper-drop.",
        `path=${target}`,
      )
    }
    deps.reveal(target)
  }

  return { save, reveal }
}
