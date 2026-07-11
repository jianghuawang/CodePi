import { randomUUID } from 'node:crypto'
import type {
  AgentMessage,
  PromptTemplate,
  ThreadRecord,
  ThreadUpdate,
  UsageDashboard,
  UsageLedgerEntry,
  UsagePeriod
} from '../shared/contracts'
import { normalizeTags } from '../shared/tags'
import type { StateStore } from './state-store'

export interface SavePromptTemplateInput {
  id?: string
  title: string
  prompt: string
}

export interface UsageSnapshotInput {
  sessionId: string
  tokens: number
  cost: number
}

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface ModelUsageAggregate {
  provider?: string
  model?: string
  turns: number
  tokens: TokenTotals
  cost: number
}

export interface UsageAggregate {
  turns: number
  tokens: TokenTotals
  cost: number
  byModel: ModelUsageAggregate[]
}

function requiredText(value: string, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${name} is invalid`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new TypeError(`${name} is invalid`)
  return normalized
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} is invalid`)
  return value
}

function promptId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new TypeError('Prompt id is invalid')
  return value
}

function threadById(state: { threads: ThreadRecord[] }, threadId: string): ThreadRecord {
  const thread = state.threads.find((candidate) => candidate.id === threadId)
  if (!thread) throw new Error('Thread not found')
  return thread
}

function cloneThread(thread: ThreadRecord): ThreadRecord {
  return structuredClone(thread)
}

/** Updates metadata only. Process lifecycle changes for archive belong to the caller. */
export function updateThreadMetadata(
  store: StateStore,
  threadId: string,
  update: ThreadUpdate
): ThreadRecord {
  const title = update.title === undefined ? undefined : requiredText(update.title, 'Thread title', 240)
  const tags = update.tags === undefined ? undefined : normalizeTags(update.tags)
  if (update.pinned !== undefined && typeof update.pinned !== 'boolean') throw new TypeError('Pinned state is invalid')
  if (update.archived !== undefined && typeof update.archived !== 'boolean') throw new TypeError('Archived state is invalid')
  if (update.unread !== undefined && typeof update.unread !== 'boolean') throw new TypeError('Unread state is invalid')
  let result: ThreadRecord | undefined
  store.update((state) => {
    const thread = threadById(state, threadId)
    if (thread.deletedAt !== undefined && (update.pinned === true || update.archived !== undefined)) {
      throw new Error('Restore the thread before changing its active state')
    }
    if (update.pinned === true && (update.archived === true || (update.archived !== false && thread.archived))) {
      throw new Error('Only active threads can be pinned')
    }
    if (title !== undefined) thread.title = title
    if (tags !== undefined) thread.tags = tags
    if (update.archived !== undefined) {
      thread.archived = update.archived
      if (update.archived) thread.pinned = false
    }
    if (update.pinned !== undefined) thread.pinned = update.pinned
    if (update.unread !== undefined) thread.unread = update.unread
    result = cloneThread(thread)
  })
  if (!result) throw new Error('Thread update failed')
  return result
}

/** Marks a thread as trashed without removing its session, worktree, or branch. */
export function softTrashThread(store: StateStore, threadId: string, now = Date.now()): ThreadRecord {
  finiteNonNegative(now, 'Timestamp')
  let result: ThreadRecord | undefined
  store.update((state) => {
    const thread = threadById(state, threadId)
    thread.deletedAt ??= now
    thread.status = 'idle'
    thread.unread = false
    delete thread.lastError
    if (state.selectedThreadId === threadId) state.selectedThreadId = undefined
    result = cloneThread(thread)
  })
  if (!result) throw new Error('Thread trash operation failed')
  return result
}

/** Restores metadata only; callers should validate worktree existence first. */
export function restoreTrashedThread(store: StateStore, threadId: string): ThreadRecord {
  let result: ThreadRecord | undefined
  store.update((state) => {
    const thread = threadById(state, threadId)
    if (thread.deletedAt === undefined) throw new Error('Thread is not in Trash')
    delete thread.deletedAt
    thread.status = 'idle'
    thread.unread = false
    result = cloneThread(thread)
  })
  if (!result) throw new Error('Thread restore operation failed')
  return result
}

export function setThreadUnread(store: StateStore, threadId: string, unread: boolean): ThreadRecord {
  if (typeof unread !== 'boolean') throw new TypeError('Unread state is invalid')
  let result: ThreadRecord | undefined
  store.update((state) => {
    const thread = threadById(state, threadId)
    thread.unread = unread
    result = cloneThread(thread)
  })
  if (!result) throw new Error('Thread read-state update failed')
  return result
}

export function markThreadRead(store: StateStore, threadId: string): ThreadRecord {
  return setThreadUnread(store, threadId, false)
}

export function listPromptTemplates(store: StateStore): PromptTemplate[] {
  return store.snapshot().promptLibrary
    .sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title))
    .map((prompt) => structuredClone(prompt))
}

export function savePromptTemplate(
  store: StateStore,
  input: SavePromptTemplateInput,
  now = Date.now()
): PromptTemplate {
  finiteNonNegative(now, 'Timestamp')
  const id = input.id === undefined ? randomUUID() : promptId(input.id)
  const title = requiredText(input.title, 'Prompt title', 120)
  if (typeof input.prompt !== 'string' || input.prompt.includes('\0') || input.prompt.length > 200_000) {
    throw new TypeError('Prompt is invalid')
  }
  let result: PromptTemplate | undefined
  store.update((state) => {
    const existing = state.promptLibrary.find((prompt) => prompt.id === id)
    if (existing) {
      existing.title = title
      existing.prompt = input.prompt
      existing.updatedAt = now
      result = structuredClone(existing)
      return
    }
    const prompt: PromptTemplate = {
      id,
      title,
      prompt: input.prompt,
      createdAt: now,
      updatedAt: now
    }
    state.promptLibrary.push(prompt)
    result = structuredClone(prompt)
  })
  if (!result) throw new Error('Prompt update failed')
  return result
}

export function deletePromptTemplate(store: StateStore, idValue: string): PromptTemplate {
  const id = promptId(idValue)
  let removed: PromptTemplate | undefined
  store.update((state) => {
    const index = state.promptLibrary.findIndex((prompt) => prompt.id === id)
    if (index < 0) throw new Error('Prompt not found')
    removed = structuredClone(state.promptLibrary[index])
    state.promptLibrary.splice(index, 1)
  })
  if (!removed) throw new Error('Prompt deletion failed')
  return removed
}

/**
 * Records only the positive delta from an absolute Pi session usage snapshot.
 * Repeated snapshots are therefore idempotent.
 */
export function recordUsageSnapshot(
  store: StateStore,
  threadId: string,
  snapshot: UsageSnapshotInput,
  now = Date.now()
): UsageLedgerEntry | null {
  const sessionId = requiredText(snapshot.sessionId, 'Session id', 512)
  const tokens = finiteNonNegative(snapshot.tokens, 'Token count')
  const cost = finiteNonNegative(snapshot.cost, 'Usage cost')
  finiteNonNegative(now, 'Timestamp')
  let result: UsageLedgerEntry | null = null
  store.update((state) => {
    const thread = threadById(state, threadId)
    const previous = thread.usageSnapshot?.sessionId === sessionId ? thread.usageSnapshot : undefined
    const tokenDelta = Math.max(0, tokens - (previous?.tokens ?? 0))
    const costDelta = Math.max(0, cost - (previous?.cost ?? 0))
    thread.usageSnapshot = { sessionId, tokens, cost }
    if (tokenDelta === 0 && costDelta === 0) return
    const entry: UsageLedgerEntry = {
      id: randomUUID(),
      projectId: thread.projectId,
      threadId: thread.id,
      timestamp: now,
      tokens: tokenDelta,
      cost: costDelta
    }
    state.usageLedger.push(entry)
    if (state.usageLedger.length > 20_000) state.usageLedger.splice(0, state.usageLedger.length - 20_000)
    result = structuredClone(entry)
  })
  return result
}

function emptyPeriod(): UsagePeriod {
  return { tokens: 0, cost: 0, turns: 0 }
}

function addEntry(period: UsagePeriod, entry: UsageLedgerEntry): void {
  period.tokens += Number.isFinite(entry.tokens) ? Math.max(0, entry.tokens) : 0
  period.cost += Number.isFinite(entry.cost) ? Math.max(0, entry.cost) : 0
  period.turns += 1
}

function localDateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function aggregateUsageLedger(
  entries: readonly UsageLedgerEntry[],
  projectId?: string,
  now = new Date()
): UsageDashboard {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (29 - index))
    return { date: localDateKey(date), ...emptyPeriod() }
  })
  const dayMap = new Map(days.map((day) => [day.date, day]))
  const today = emptyPeriod()
  const month = emptyPeriod()
  for (const entry of entries) {
    if (projectId !== undefined && entry.projectId !== projectId) continue
    if (!Number.isFinite(entry.timestamp) || entry.timestamp > now.getTime()) continue
    if (entry.timestamp >= todayStart) addEntry(today, entry)
    if (entry.timestamp >= monthStart) addEntry(month, entry)
    const day = dayMap.get(localDateKey(new Date(entry.timestamp)))
    if (day) addEntry(day, entry)
  }
  return { today, month, days }
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function addTokens(target: TokenTotals, source: Omit<TokenTotals, 'total'>): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.total = target.input + target.output + target.cacheRead + target.cacheWrite
}

function usageCost(cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | undefined): number {
  if (!cost) return 0
  if (typeof cost.total === 'number' && Number.isFinite(cost.total)) return Math.max(0, cost.total)
  return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]
    .reduce<number>((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0), 0)
}

export function aggregateMessageUsage(messages: readonly AgentMessage[]): UsageAggregate {
  const aggregate: UsageAggregate = { turns: 0, tokens: emptyTokens(), cost: 0, byModel: [] }
  const models = new Map<string, ModelUsageAggregate>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage) continue
    const usage = message.usage
    const tokens = {
      input: finiteNonNegative(usage.input, 'Input tokens'),
      output: finiteNonNegative(usage.output, 'Output tokens'),
      cacheRead: finiteNonNegative(usage.cacheRead, 'Cache-read tokens'),
      cacheWrite: finiteNonNegative(usage.cacheWrite, 'Cache-write tokens')
    }
    const cost = usageCost(usage.cost)
    aggregate.turns += 1
    addTokens(aggregate.tokens, tokens)
    aggregate.cost += cost

    const key = `${message.provider ?? ''}\0${message.model ?? ''}`
    let model = models.get(key)
    if (!model) {
      model = {
        ...(message.provider ? { provider: message.provider } : {}),
        ...(message.model ? { model: message.model } : {}),
        turns: 0,
        tokens: emptyTokens(),
        cost: 0
      }
      models.set(key, model)
    }
    model.turns += 1
    addTokens(model.tokens, tokens)
    model.cost += cost
  }
  aggregate.byModel = [...models.values()].sort((left, right) => right.tokens.total - left.tokens.total)
  return aggregate
}
