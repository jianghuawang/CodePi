import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type {
  AgentMessage,
  ThreadRecord,
  ThreadSearchResult as SharedThreadSearchResult,
  ThreadStatus
} from '../shared/contracts'
import { readSessionMessages } from './sessions'

export type ThreadSearchLocation = 'active' | 'archived' | 'trash' | 'all'
export type ThreadSearchMatchSource = 'title' | 'tag' | 'message'

export interface ThreadSearchQuery {
  query: string
  threads: readonly ThreadRecord[]
  projectIds?: readonly string[]
  tags?: readonly string[]
  statuses?: readonly ThreadStatus[]
  location?: ThreadSearchLocation
  unreadOnly?: boolean
  pinnedOnly?: boolean
  limit?: number
  concurrency?: number
  maxThreadsScanned?: number
  maxSessionBytes?: number
  maxMessagesPerSession?: number
  maxMatchesPerThread?: number
}

export interface ThreadSearchResult extends SharedThreadSearchResult {
  source: ThreadSearchMatchSource
  score: number
}

interface SearchableMessage {
  timestamp?: number
  text: string
  normalized: string
}

interface CacheEntry {
  size: number
  modifiedAt: number
  maximumBytes: number
  maximumMessages: number
  characters: number
  messages: SearchableMessage[]
}

const defaultMaximumSessionBytes = 16 * 1024 * 1024
const maximumMessageText = 64 * 1024

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function textParts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
  })
}

function messageText(message: AgentMessage): string {
  switch (message.role) {
    case 'user':
      return textParts(message.content).join('\n')
    case 'assistant':
      return message.content.flatMap((content) => {
        if (content.type === 'text') return [content.text]
        if (content.type === 'thinking') return [content.thinking]
        try {
          return [`${content.name}\n${JSON.stringify(content.arguments)}`]
        } catch {
          return [content.name]
        }
      }).join('\n')
    case 'toolResult':
      return `${message.toolName}\n${message.content.map((content) => content.text).join('\n')}`
    case 'bashExecution':
      return `${message.command}\n${message.output}`
    case 'custom':
      return message.display ? `${message.customType}\n${textParts(message.content).join('\n')}` : ''
    case 'branchSummary':
    case 'compactionSummary':
      return message.summary
    default:
      return ''
  }
}

function searchableMessage(message: AgentMessage): SearchableMessage | null {
  const text = messageText(message).replace(/\0/g, '').slice(0, maximumMessageText).trim()
  if (!text) return null
  return {
    ...(Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}),
    text,
    normalized: normalize(text)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === 'string' && typeof value.timestamp === 'number'
}

async function readRecentJsonlMessages(
  file: string,
  size: number,
  maximumBytes: number,
  maximumMessages: number
): Promise<AgentMessage[]> {
  const start = Math.max(0, size - maximumBytes)
  const input = createReadStream(file, { encoding: 'utf8', start })
  const lines = createInterface({ input, crlfDelay: Infinity })
  const result: AgentMessage[] = []
  let first = true
  try {
    for await (const line of lines) {
      // A tail read normally begins in the middle of a JSON object.
      if (first && start > 0) {
        first = false
        continue
      }
      first = false
      if (!line.trim()) continue
      try {
        const entry: unknown = JSON.parse(line)
        if (!isRecord(entry) || entry.type !== 'message' || !looksLikeAgentMessage(entry.message)) continue
        result.push(entry.message)
        if (result.length > maximumMessages) result.shift()
      } catch {
        // Concurrent Pi writes and a partial trailing JSONL record are expected.
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return result
}

function excerpt(text: string, terms: readonly string[], maximum = 220): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maximum) return compact
  const lowered = compact.toLocaleLowerCase()
  const firstIndex = terms.reduce((best, term) => {
    const index = lowered.indexOf(term.toLocaleLowerCase())
    if (index < 0) return best
    return best < 0 ? index : Math.min(best, index)
  }, -1)
  const center = firstIndex < 0 ? 0 : firstIndex
  const start = Math.max(0, Math.min(compact.length - maximum, center - Math.floor(maximum / 3)))
  return `${start > 0 ? '…' : ''}${compact.slice(start, start + maximum).trim()}${start + maximum < compact.length ? '…' : ''}`
}

function threadLocation(thread: ThreadRecord): Exclude<ThreadSearchLocation, 'all'> {
  if (thread.deletedAt !== undefined) return 'trash'
  if (thread.archived) return 'archived'
  return 'active'
}

function matchesFilters(thread: ThreadRecord, query: ThreadSearchQuery): boolean {
  const location = query.location ?? 'active'
  if (location !== 'all' && threadLocation(thread) !== location) return false
  if (query.projectIds?.length && !query.projectIds.includes(thread.projectId)) return false
  if (query.statuses?.length && !query.statuses.includes(thread.status)) return false
  if (query.unreadOnly && !thread.unread) return false
  if (query.pinnedOnly && !thread.pinned) return false
  if (query.tags?.length) {
    const available = new Set((thread.tags ?? []).map(normalize))
    if (!query.tags.every((tag) => available.has(normalize(tag)))) return false
  }
  return true
}

function recencyBonus(updatedAt: number): number {
  const ageInDays = Math.max(0, (Date.now() - updatedAt) / 86_400_000)
  return Math.max(0, 10 - Math.log2(ageInDays + 1))
}

export class TranscriptSearchService {
  private readonly cache = new Map<string, CacheEntry>()
  private cachedCharacters = 0

  constructor(
    private readonly maximumCacheEntries = 32,
    private readonly maximumCachedCharacters = 32 * 1024 * 1024
  ) {}

  clear(sessionFile?: string): void {
    if (sessionFile) {
      const cached = this.cache.get(sessionFile)
      if (cached) this.cachedCharacters -= cached.characters
      this.cache.delete(sessionFile)
    } else {
      this.cache.clear()
      this.cachedCharacters = 0
    }
  }

  async search(query: ThreadSearchQuery): Promise<ThreadSearchResult[]> {
    if (typeof query.query !== 'string' || query.query.includes('\0')) throw new TypeError('Search query is invalid')
    const limit = clampInteger(query.limit, 60, 1, 200)
    const concurrency = clampInteger(query.concurrency, 4, 1, 8)
    const maximumThreads = clampInteger(query.maxThreadsScanned, 500, 1, 5_000)
    const maximumBytes = clampInteger(
      query.maxSessionBytes,
      defaultMaximumSessionBytes,
      64 * 1024,
      64 * 1024 * 1024
    )
    const maximumMessages = clampInteger(query.maxMessagesPerSession, 5_000, 1, 20_000)
    const matchesPerThread = clampInteger(query.maxMatchesPerThread, 2, 1, 10)
    const normalizedQuery = normalize(query.query.slice(0, 512))
    const terms = normalizedQuery.split(' ').filter(Boolean)
    const candidates = query.threads
      .filter((thread) => matchesFilters(thread, query))
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt)

    const results: ThreadSearchResult[] = []
    for (const thread of candidates) {
      const title = normalize(thread.title)
      const matchingTag = (thread.tags ?? []).find((tag) => {
        const normalizedTag = normalize(tag)
        return !normalizedQuery || normalizedTag.includes(normalizedQuery) || terms.every((term) => normalizedTag.includes(term))
      })
      const titleMatches = !normalizedQuery || title.includes(normalizedQuery) || terms.every((term) => title.includes(term))
      if (titleMatches || matchingTag) {
        results.push({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          source: titleMatches ? 'title' : 'tag',
          score: (titleMatches ? 120 : 90) + (thread.pinned ? 20 : 0) + recencyBonus(thread.updatedAt),
          snippet: matchingTag && !titleMatches ? matchingTag : thread.title,
          timestamp: thread.updatedAt
        })
      }
    }

    if (terms.length > 0) {
      const contentCandidates = candidates.filter((thread) => thread.sessionFile).slice(0, maximumThreads)
      const contentResults: ThreadSearchResult[] = []
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < contentCandidates.length) {
          const thread = contentCandidates[cursor++]
          const messages = await this.indexedMessages(thread.sessionFile!, maximumBytes, maximumMessages).catch(() => [])
          let count = 0
          for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
            const message = messages[messageIndex]
            if (!terms.every((term) => message.normalized.includes(term))) continue
            const exact = message.normalized.includes(normalizedQuery)
            contentResults.push({
              threadId: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              source: 'message',
              score: (exact ? 70 : 55) + recencyBonus(thread.updatedAt),
              snippet: excerpt(message.text, terms),
              timestamp: message.timestamp ?? thread.updatedAt
            })
            count += 1
            if (count >= matchesPerThread) break
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, contentCandidates.length) }, () => worker()))
      results.push(...contentResults)
    }

    return results
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, limit)
  }

  private async indexedMessages(
    sessionFile: string,
    maximumBytes: number,
    maximumMessages: number
  ): Promise<SearchableMessage[]> {
    const info = await stat(sessionFile)
    const cached = this.cache.get(sessionFile)
    if (
      cached &&
      cached.size === info.size &&
      cached.modifiedAt === info.mtimeMs &&
      cached.maximumBytes === maximumBytes &&
      cached.maximumMessages === maximumMessages
    ) {
      this.cache.delete(sessionFile)
      this.cache.set(sessionFile, cached)
      return cached.messages
    }

    const rawMessages = info.size <= maximumBytes
      ? (await readSessionMessages(sessionFile)).slice(-maximumMessages)
      : await readRecentJsonlMessages(sessionFile, info.size, maximumBytes, maximumMessages)
    const messages = rawMessages
      .map(searchableMessage)
      .filter((message): message is SearchableMessage => message !== null)
    const previous = this.cache.get(sessionFile)
    if (previous) this.cachedCharacters -= previous.characters
    const characters = messages.reduce((total, message) => total + message.text.length + message.normalized.length, 0)
    this.cache.set(sessionFile, {
      size: info.size,
      modifiedAt: info.mtimeMs,
      maximumBytes,
      maximumMessages,
      characters,
      messages
    })
    this.cachedCharacters += characters
    while (
      this.cache.size > Math.max(0, this.maximumCacheEntries) ||
      this.cachedCharacters > Math.max(0, this.maximumCachedCharacters)
    ) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      const entry = this.cache.get(oldest)
      if (entry) this.cachedCharacters -= entry.characters
      this.cache.delete(oldest)
    }
    return messages
  }
}

export async function searchThreads(query: ThreadSearchQuery): Promise<ThreadSearchResult[]> {
  return new TranscriptSearchService(0, 0).search(query)
}
