/** One transcribed span of audio. `index` is 0-based; SRT adds 1 at format time. */
export type Segment = {
  index: number
  startMs: number
  endMs: number
  text: string
}

/** What `ffprobe` tells us about a dropped file. */
export type MediaInfo = {
  path: string
  durationMs: number
  hasAudio: boolean
  container: string
}

export type JobPhase =
  | 'probing'
  | 'preparing'
  | 'transcribing'
  | 'done'
  | 'cancelled'
  | 'failed'

export type ErrorCode =
  | 'NO_AUDIO_STREAM'
  | 'UNREADABLE_MEDIA'
  | 'NO_MODEL_INSTALLED'
  | 'MODEL_FILE_MISSING'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'DOWNLOAD_CHECKSUM_MISMATCH'
  | 'DOWNLOAD_NETWORK_ERROR'
  | 'WHISPER_FAILED'
  | 'FFMPEG_FAILED'

/** Serialisable snapshot of a job, safe to send across the IPC boundary. */
export type JobState = {
  id: string
  filePath: string
  media?: MediaInfo
  phase: JobPhase
  /** 0..1 spanning every phase. */
  progress: number
  etaMs?: number
  segments: Segment[]
  /** durationMs / transcribeElapsedMs. Present only once the phase is `done`. */
  realtimeFactor?: number
  error?: { code: ErrorCode; message: string; detail?: string }
}

export type Unsubscribe = () => void
