import { writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import type { ExportFormat, Segment } from '../../shared/types.js'
import { format } from './formatters.js'

/** Enough to be certain the loop terminates; a real folder never gets here. */
const MAX_ATTEMPTS = 999

export type SaveOptions = {
  segments: Segment[]
  /** The media file the transcript came from. Always a path main already holds. */
  sourcePath: string
  as: ExportFormat
}

/**
 * `interview.mp4` -> `interview.srt`, then `interview (2).srt`.
 *
 * `parse().name` strips one extension only, so `archive.tar.gz` becomes
 * `archive.tar.srt` — which is the honest answer for a double extension.
 */
export function candidatePath(sourcePath: string, as: ExportFormat, attempt: number): string {
  const { dir, name } = parse(sourcePath)
  const suffix = attempt === 1 ? '' : ` (${attempt})`
  return join(dir, `${name}${suffix}.${as}`)
}

/**
 * Write next to the source file, never overwriting. `wx` makes the
 * existence check and the write one step, so nothing can land in the gap
 * between them.
 */
export async function saveTranscript(options: SaveOptions): Promise<string> {
  const text = format(options.segments, options.as)

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const target = candidatePath(options.sourcePath, options.as, attempt)
    try {
      await writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
      return target
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    }
  }

  throw new Error(
    `saveTranscript: ${MAX_ATTEMPTS} names already taken beside ${options.sourcePath}`,
  )
}
