import { AppError } from '../../shared/errors.js'
import type { IpcErrorCode, IpcFailure, IpcResult } from '../../shared/ipc.js'

/** A boundary rejection: the request itself was wrong, not the operation. */
export class IpcError extends Error {
  readonly code: IpcErrorCode
  readonly detail?: string

  constructor(code: IpcErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Anything that isn't an AppError or an IpcError is a bug, so its message is
 * replaced rather than forwarded — the UI must never surface a bare `ENOENT`.
 * The original text survives in `detail`, behind the disclosure.
 */
export function toFailure(cause: unknown): IpcFailure {
  if (cause instanceof AppError || cause instanceof IpcError) {
    return { code: cause.code, message: cause.message, detail: cause.detail }
  }

  return {
    code: 'UNEXPECTED',
    message: 'Something went wrong.',
    detail: cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : String(cause),
  }
}

export async function toResult<T>(run: () => T | Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (cause) {
    return { ok: false, error: toFailure(cause) }
  }
}
