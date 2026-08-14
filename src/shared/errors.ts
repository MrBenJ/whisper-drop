import type { ErrorCode } from './types.js'

/**
 * Every failure the user can see. `message` is plain language shown directly in
 * the UI; `detail` is technical output shown behind a disclosure and formatted
 * for pasting into a GitHub issue.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail?: string

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }

  toJSON(): { code: ErrorCode; message: string; detail?: string } {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}
