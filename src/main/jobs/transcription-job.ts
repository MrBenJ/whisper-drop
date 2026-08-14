import { AppError } from '../../shared/errors.js'
import type { JobState, MediaInfo, Segment, Unsubscribe } from '../../shared/types.js'

/** Fixed by the spec. Progress is one 0..1 value spanning every phase. */
export const PROGRESS_BANDS = {
  probing: { from: 0, to: 0.02 },
  preparing: { from: 0.02, to: 0.08 },
  transcribing: { from: 0.08, to: 1 },
} as const

/** Transcription-phase progress below which the ETA is too noisy to show. */
const ETA_THRESHOLD = 0.1

export type JobDeps = {
  probe: (filePath: string) => Promise<MediaInfo>
  extract: (options: {
    inputPath: string
    outputPath: string
    durationMs: number
    onProgress: (fraction: number) => void
    signal: AbortSignal
  }) => Promise<void>
  run: (
    options: { wavPath: string; modelPath: string; language: string; signal: AbortSignal },
    onSegment: (segment: Segment) => void,
  ) => Promise<Segment[]>
  tempWavPath: (jobId: string) => string
  /** Must succeed when the file does not exist. */
  removeFile: (path: string) => Promise<void>
  now: () => number
}

export type JobInput = {
  id: string
  filePath: string
  modelPath: string
  /** ISO 639-1 code, or 'auto'. */
  language: string
}

/**
 * Sequences one file through the pipeline and is the only holder of job state.
 *
 * Collaborators are injected so the phase machine, progress banding and cleanup
 * can be tested without spawning a process or touching the disk.
 */
export class TranscriptionJob {
  readonly id: string

  private readonly controller = new AbortController()
  private readonly listeners = new Set<(state: JobState) => void>()
  private current: JobState
  private cancelled = false

  constructor(
    private readonly deps: JobDeps,
    private readonly input: JobInput,
  ) {
    this.id = input.id
    this.current = {
      id: input.id,
      filePath: input.filePath,
      phase: 'probing',
      progress: 0,
      segments: [],
    }
  }

  get state(): JobState {
    return this.snapshot()
  }

  subscribe(listener: (state: JobState) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cancel(): void {
    if (this.isFinished()) return
    this.cancelled = true
    this.controller.abort()
  }

  async start(): Promise<void> {
    const wavPath = this.deps.tempWavPath(this.id)

    try {
      const media = await this.probePhase()
      await this.preparePhase(media, wavPath)
      await this.transcribePhase(media, wavPath)
    } catch (cause) {
      if (this.cancelled) this.finishCancelled()
      else this.finishFailed(cause)
    } finally {
      // The job's outcome is already recorded and delivered to subscribers. A
      // failed temp cleanup must not convert that into a thrown error.
      await this.deps.removeFile(wavPath).catch(() => {})
    }
  }

  // --- phases -------------------------------------------------------------

  private async probePhase(): Promise<MediaInfo> {
    this.update({ phase: 'probing', progress: PROGRESS_BANDS.probing.from })

    const media = await this.deps.probe(this.input.filePath)
    this.throwIfCancelled()

    if (!media.hasAudio) {
      throw new AppError(
        'NO_AUDIO_STREAM',
        "This file doesn't contain any audio.",
        `${this.input.filePath} (${media.container})`,
      )
    }

    this.current = { ...this.current, media }
    return media
  }

  private async preparePhase(media: MediaInfo, wavPath: string): Promise<void> {
    const { from, to } = PROGRESS_BANDS.preparing
    this.update({ phase: 'preparing', progress: from })

    await this.deps.extract({
      inputPath: this.input.filePath,
      outputPath: wavPath,
      durationMs: media.durationMs,
      onProgress: (fraction) => {
        this.update({ progress: band(from, to, fraction) })
      },
      signal: this.controller.signal,
    })

    this.throwIfCancelled()
  }

  private async transcribePhase(media: MediaInfo, wavPath: string): Promise<void> {
    const { from, to } = PROGRESS_BANDS.transcribing
    const startedAt = this.deps.now()

    this.update({ phase: 'transcribing', progress: from })

    const segments: Segment[] = []

    await this.deps.run(
      {
        wavPath,
        modelPath: this.input.modelPath,
        language: this.input.language,
        signal: this.controller.signal,
      },
      (segment) => {
        segments.push(segment)

        const fraction =
          media.durationMs > 0 ? Math.min(1, segment.endMs / media.durationMs) : 1
        const elapsed = this.deps.now() - startedAt

        this.update({
          segments: [...segments],
          progress: band(from, to, fraction),
          etaMs:
            fraction >= ETA_THRESHOLD ? Math.round((elapsed * (1 - fraction)) / fraction) : undefined,
        })
      },
    )

    this.throwIfCancelled()

    const elapsed = Math.max(1, this.deps.now() - startedAt)

    this.update({
      phase: 'done',
      progress: 1,
      etaMs: undefined,
      segments: [...segments],
      realtimeFactor: media.durationMs / elapsed,
    })
  }

  // --- terminal states ----------------------------------------------------

  private finishCancelled(): void {
    this.update({ phase: 'cancelled', etaMs: undefined })
  }

  private finishFailed(cause: unknown): void {
    const error =
      cause instanceof AppError
        ? cause.toJSON()
        : {
            code: 'WHISPER_FAILED' as const,
            message: 'Transcription failed unexpectedly.',
            detail: cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : String(cause),
          }

    this.update({ phase: 'failed', etaMs: undefined, error })
  }

  // --- plumbing -----------------------------------------------------------

  private isFinished(): boolean {
    return ['done', 'cancelled', 'failed'].includes(this.current.phase)
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new Error('TranscriptionJob: cancelled')
  }

  private update(patch: Partial<JobState>): void {
    this.current = { ...this.current, ...patch }
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  /** Listeners get their own copy, so later mutation cannot reach them. */
  private snapshot(): JobState {
    return { ...this.current, segments: [...this.current.segments] }
  }
}

/** Map a 0..1 phase fraction into its slice of overall progress. */
function band(from: number, to: number, fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction))
  return from + (to - from) * clamped
}
