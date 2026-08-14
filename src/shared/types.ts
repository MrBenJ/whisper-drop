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

/** Iterable form, so the renderer's message table can be proved exhaustive. */
export const ERROR_CODES = [
  'NO_AUDIO_STREAM',
  'UNREADABLE_MEDIA',
  'NO_MODEL_INSTALLED',
  'MODEL_FILE_MISSING',
  'INSUFFICIENT_DISK_SPACE',
  'DOWNLOAD_CHECKSUM_MISMATCH',
  'DOWNLOAD_NETWORK_ERROR',
  'WHISPER_FAILED',
  'FFMPEG_FAILED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

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

/** A row in the model picker. */
export type ModelBaseId = 'tiny' | 'base' | 'small' | 'large-v3-turbo' | 'large-v3'

/** A concrete model file. */
export type ModelId = ModelBaseId | 'tiny.en' | 'base.en' | 'small.en'

export type ModelEntry = {
  id: ModelId
  base: ModelBaseId
  label: string
  bytes: number
  sha256: string
  url: string
  blurb: string
  englishOnly: boolean
}

export type DownloadProgress = {
  id: ModelId
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
}

export type Settings = {
  version: 1
  englishOnly: boolean
  activeModel: ModelBaseId | null
  /** ISO 639-1 code, or 'auto'. Ignored while englishOnly. */
  language: string
  throughput: Partial<Record<ModelId, { realtimeFactor: number; samples: number }>>
}

export const EXPORT_FORMATS = ['txt', 'srt', 'vtt'] as const

export type ExportFormat = (typeof EXPORT_FORMATS)[number]
