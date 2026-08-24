// Upstream bug: under NodeNext, these packages' CJS `export default` resolves
// to the whole module namespace instead of `string | null`. Delete these
// declarations once upstream's types resolve correctly.
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null
  export default ffmpegPath
}

declare module '@derhuerst/ffprobe-static' {
  const ffprobePath: string | null
  export default ffprobePath
}
