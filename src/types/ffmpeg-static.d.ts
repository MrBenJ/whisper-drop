// ffmpeg-static's shipped types resolve to the whole module namespace under
// NodeNext + esModuleInterop instead of unwrapping the default export. This
// override restates the (correct) runtime shape: a plain default export.
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null
  export default ffmpegPath
}
