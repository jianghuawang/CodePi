export const maximumTags = 24
export const maximumTagLength = 48

/**
 * Canonical tag normalization: trim, collapse inner whitespace, drop empties
 * and case-insensitive duplicates. Throws on anything over the limits — use
 * at trust boundaries (IPC validation, persistence).
 */
export function normalizeTags(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > maximumTags * 2) throw new TypeError('Tags are invalid')
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Tag is invalid')
    const tag = value.trim().replace(/\s+/g, ' ')
    if (!tag) continue
    if (tag.length > maximumTagLength) throw new TypeError(`Tag is longer than ${maximumTagLength} characters`)
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length > maximumTags) throw new TypeError(`A maximum of ${maximumTags} tags is allowed`)
  }
  return result
}

/** Lenient variant for comma-separated UI input: clamps instead of throwing. */
export function normalizeTagInput(value: string): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of value.split(',')) {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, maximumTagLength)
    const key = tag.toLocaleLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length === maximumTags) break
  }
  return result
}
