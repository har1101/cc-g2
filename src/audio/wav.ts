export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function encodePcm16kMonoS16leToWav(pcm: Uint8Array): Uint8Array {
  const sampleRate = 16_000
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.byteLength
  const wavSize = 44 + dataSize

  const wav = new Uint8Array(wavSize)
  const view = new DataView(wav.buffer)

  writeAscii(wav, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(wav, 8, 'WAVE')
  writeAscii(wav, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(wav, 36, 'data')
  view.setUint32(40, dataSize, true)
  wav.set(pcm, 44)

  return wav
}

function writeAscii(target: Uint8Array, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    target[offset + i] = text.charCodeAt(i)
  }
}
