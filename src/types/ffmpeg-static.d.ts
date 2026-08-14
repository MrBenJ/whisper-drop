// Upstream bug: under NodeNext, ffmpeg-static's CJS `export default` resolves
// to the whole module namespace instead of `string | null`. Delete this file
// once upstream's types resolve correctly.
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null
  export default ffmpegPath
}
