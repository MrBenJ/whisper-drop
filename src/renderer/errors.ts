import type { IpcErrorCode, IpcFailure } from '../shared/ipc.js'

/** What the Error view offers. The component maps these to its own handlers. */
export type ErrorAction = 'open-picker' | 'retry-transcription' | 'retry-download' | 'dismiss'

export type ErrorPresentation = {
  /** Plain language. Never a stack, never a bare errno. */
  title: string
  suggestion: string
  action: ErrorAction
}

type Entry = { fallbackTitle: string; suggestion: string; action: ErrorAction }

const TABLE: Record<IpcErrorCode, Entry> = {
  NO_AUDIO_STREAM: {
    fallbackTitle: "This file doesn't contain any audio.",
    suggestion: 'Try a different file — a video with no audio track has nothing to transcribe.',
    action: 'dismiss',
  },
  UNREADABLE_MEDIA: {
    fallbackTitle: "This file couldn't be read as audio or video.",
    suggestion: 'Check the file opens in a media player, then try again.',
    action: 'dismiss',
  },
  NO_MODEL_INSTALLED: {
    fallbackTitle: 'Choose a model first.',
    suggestion: 'Pick a model and download it, then drop your file again.',
    action: 'open-picker',
  },
  MODEL_FILE_MISSING: {
    fallbackTitle: "That model isn't on disk anymore.",
    suggestion: 'Download it again from the model picker.',
    action: 'open-picker',
  },
  INSUFFICIENT_DISK_SPACE: {
    fallbackTitle: 'Not enough free space for that model.',
    suggestion: 'Free some space, or choose a smaller model.',
    action: 'open-picker',
  },
  DOWNLOAD_CHECKSUM_MISMATCH: {
    fallbackTitle: 'The download was corrupted.',
    suggestion: 'The file is discarded rather than used. Try downloading it again.',
    action: 'retry-download',
  },
  DOWNLOAD_NETWORK_ERROR: {
    fallbackTitle: "Couldn't reach the model server.",
    suggestion: 'Check your connection and try again. A partial download resumes where it stopped.',
    action: 'retry-download',
  },
  WHISPER_FAILED: {
    fallbackTitle: 'Transcription failed unexpectedly.',
    suggestion: 'Try again. If it keeps happening, the details below belong in a bug report.',
    action: 'retry-transcription',
  },
  FFMPEG_FAILED: {
    fallbackTitle: "Couldn't prepare the audio from this file.",
    suggestion: 'Try converting the file to a common format, or use a different recording.',
    action: 'retry-transcription',
  },
  INVALID_REQUEST: {
    fallbackTitle: 'That request was not understood.',
    suggestion: 'Start again from the beginning. The details below belong in a bug report.',
    action: 'dismiss',
  },
  JOB_ALREADY_RUNNING: {
    fallbackTitle: 'whisper-drop transcribes one file at a time.',
    suggestion: 'Wait for the current file to finish, or cancel it first.',
    action: 'dismiss',
  },
  UNEXPECTED: {
    fallbackTitle: 'Something went wrong.',
    suggestion: 'Try again. If it keeps happening, the details below belong in a bug report.',
    action: 'dismiss',
  },
}

/**
 * `message` already arrives as plain language from main — including the
 * numbers only main knows, like how much space a model needs — so it wins over
 * the table's title. The table supplies the suggested action either way.
 */
export function presentError(failure: IpcFailure): ErrorPresentation {
  const entry = TABLE[failure.code] ?? TABLE.UNEXPECTED
  return {
    title: failure.message.trim() === '' ? entry.fallbackTitle : failure.message,
    suggestion: entry.suggestion,
    action: entry.action,
  }
}

/** Anything a rejected IPC call throws, narrowed to something renderable. */
export function asIpcFailure(cause: unknown): IpcFailure {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    'message' in cause &&
    typeof (cause as { code: unknown }).code === 'string' &&
    typeof (cause as { message: unknown }).message === 'string' &&
    (cause as { code: string }).code in TABLE
  ) {
    return cause as IpcFailure
  }

  return {
    code: 'UNEXPECTED',
    message: 'Something went wrong.',
    detail: cause instanceof Error ? cause.message : String(cause),
  }
}

/** The disclosure body, formatted for pasting into a GitHub issue. */
export function detailBlock(failure: IpcFailure): string {
  return [`code: ${failure.code}`, `message: ${failure.message}`, failure.detail ?? '']
    .filter((line) => line !== '')
    .join('\n')
}
