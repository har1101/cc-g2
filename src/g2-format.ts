export function formatForG2Display(text: string, maxLines = 3, maxCharsPerLine = 22): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return '（認識結果なし）'

  const words = normalized.split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxCharsPerLine) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length >= maxLines) break
  }
  if (lines.length < maxLines && current) lines.push(current)

  let output = lines.slice(0, maxLines)
  const consumed = output.join(' ').length
  if (normalized.length > consumed && output.length > 0) {
    output[output.length - 1] = `${output[output.length - 1].slice(0, Math.max(0, maxCharsPerLine - 1))}…`
  }

  return output.join('\n')
}
