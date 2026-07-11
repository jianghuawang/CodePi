/**
 * CodePi appends attachment context blocks to the end of outgoing user
 * messages. The block builders and the display-collapsing parser live
 * together so they cannot drift: collapseAttachedContext recognizes only
 * the exact format the builders emit.
 */

export function attachedTextBlock(name: string, text: string): string {
  const safeName = name.replace(/[\r\n`]/g, ' ').slice(0, 240)
  return `Attached file \`${safeName}\`:\n\n\`\`\`text\n${text}\n\`\`\``
}

export function attachedPathBlock(path: string): string {
  return `Attached file path: \`${path.replaceAll('`', '\\`')}\``
}

const attachedBlockPattern = /\n\nAttached file (?:`([^`\n]+)`:|path: `((?:\\`|[^`\n])+)`)/g

/** Collapse trailing attachment blocks into a compact 📎 list for display. */
export function collapseAttachedContext(value: string): string {
  const matches = [...value.matchAll(attachedBlockPattern)]
  const first = matches[0]?.index ?? -1
  if (first < 0) return value
  const names = matches.map((match) => match[1] ?? match[2])
  return `${value.slice(0, first)}\n\n${names.map((name) => `📎 ${name}`).join('\n')}`
}
