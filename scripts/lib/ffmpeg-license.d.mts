export const FORBIDDEN_FLAGS: readonly string[]

export function scanFfmpegLicense(buffer: Buffer): { hasConfig: boolean; forbidden: string[] }

export function assertRedistributableFfmpeg(buffer: Buffer, label: string): void
