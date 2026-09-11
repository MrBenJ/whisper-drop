// FFmpeg compiles its full ./configure line into every binary (FFMPEG_CONFIGURATION),
// alongside a copyright banner. We scan those bytes directly rather than executing
// the binary, so the check works even on a cross-arch binary this host can't run.

export const FORBIDDEN_FLAGS = Object.freeze(['--enable-nonfree', '--enable-gpl'])

// Proof we're looking at a real ffmpeg/ffprobe build: absent this, a stripped or
// unrelated file would pass the forbidden-flag check simply by not containing them.
const BANNER = 'the FFmpeg developers'

export function scanFfmpegLicense(buffer) {
  const text = buffer.toString('latin1')
  return {
    hasConfig: text.includes(BANNER),
    forbidden: FORBIDDEN_FLAGS.filter((flag) => text.includes(flag)),
  }
}

export function assertRedistributableFfmpeg(buffer, label) {
  const { hasConfig, forbidden } = scanFfmpegLicense(buffer)
  if (!hasConfig) {
    throw new Error(
      `${label}: no embedded ffmpeg configuration string found — cannot confirm this is a redistributable LGPL build`,
    )
  }
  if (forbidden.length > 0) {
    throw new Error(
      `${label}: non-redistributable build flags present in the binary's configuration: ${forbidden.join(', ')}`,
    )
  }
}
