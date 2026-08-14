import { IPC_BOUNDARY_CODES, type IpcFailure } from '../shared/ipc.js'
import { ERROR_CODES } from '../shared/types.js'

// Not part of this task's brief — added because App.tsx's given wiring code
// imports it. Task 6 owns the full errors.ts (presentError, detailBlock);
// this narrows to just what App.tsx needs until then, with the same signature.
const KNOWN_CODES: ReadonlySet<string> = new Set([...ERROR_CODES, ...IPC_BOUNDARY_CODES])

/** Anything a rejected IPC call throws, narrowed to something renderable. */
export function asIpcFailure(cause: unknown): IpcFailure {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    'message' in cause &&
    typeof (cause as { code: unknown }).code === 'string' &&
    typeof (cause as { message: unknown }).message === 'string' &&
    KNOWN_CODES.has((cause as { code: string }).code)
  ) {
    return cause as IpcFailure
  }

  return {
    code: 'UNEXPECTED',
    message: 'Something went wrong.',
    detail: cause instanceof Error ? cause.message : String(cause),
  }
}
