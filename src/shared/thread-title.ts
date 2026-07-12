export const DEFAULT_THREAD_TITLE = 'New thread'

const MAX_AUTO_TITLE_LENGTH = 64
const MIN_SENTENCE_LENGTH = 12

/**
 * Derives a sidebar title from the first prompt of a thread.
 * Returns undefined when the prompt has no usable text, e.g. a bare slash command.
 */
export function autoThreadTitle(message: string): string | undefined {
  const flattened = message.replace(/\s+/g, ' ').trim()
  if (!flattened || flattened.startsWith('/')) return undefined
  const cleaned = flattened.replace(/^[#>*\-–—=:\s]+/, '')
  if (!cleaned) return undefined
  const sentenceEnd = cleaned.search(/[.!?。！？](?= |$)/)
  if (sentenceEnd >= MIN_SENTENCE_LENGTH && sentenceEnd < MAX_AUTO_TITLE_LENGTH) {
    return cleaned.slice(0, sentenceEnd)
  }
  if (cleaned.length <= MAX_AUTO_TITLE_LENGTH) return cleaned
  const cut = cleaned.slice(0, MAX_AUTO_TITLE_LENGTH)
  const lastSpace = cut.lastIndexOf(' ')
  const wordBoundary = lastSpace > MAX_AUTO_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut
  return `${wordBoundary.replace(/[\s,;:]+$/, '')}…`
}
