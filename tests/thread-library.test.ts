import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { StateStore } from '../src/main/state-store'
import {
  aggregateUsageLedger,
  deletePromptTemplate,
  listPromptTemplates,
  markThreadRead,
  recordUsageSnapshot,
  restoreTrashedThread,
  savePromptTemplate,
  setThreadUnread,
  softTrashThread,
  updateThreadMetadata,
} from '../src/main/thread-library'
import type { ThreadRecord, UsageLedgerEntry } from '../src/shared/contracts'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function thread(id = 'thread-1', projectId = 'project-1'): ThreadRecord {
  return {
    id,
    projectId,
    title: 'Original title',
    cwd: `/tmp/${id}`,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    unread: false,
    tags: [],
    disabledCapabilityIds: [],
    autoRetryEnabled: true,
  }
}

async function seededStore(includeSecondProject = false): Promise<StateStore> {
  const directory = await mkdtemp(join(tmpdir(), 'codepi-library-'))
  temporaryPaths.push(directory)
  const store = await StateStore.open(directory)
  store.update((state) => {
    state.projects.push({
      id: 'project-1',
      name: 'Project 1',
      path: '/tmp/project-1',
      isGit: false,
      expanded: true,
      createdAt: 1,
    })
    state.threads.push(thread())
    state.selectedThreadId = 'thread-1'
    if (includeSecondProject) {
      state.projects.push({
        id: 'project-2',
        name: 'Project 2',
        path: '/tmp/project-2',
        isGit: false,
        expanded: true,
        createdAt: 1,
      })
      state.threads.push(thread('thread-2', 'project-2'))
    }
  })
  await store.flush()
  return store
}

describe('thread metadata lifecycle', () => {
  it('normalizes edits and supports pin, archive, trash, restore, and read-state transitions', async () => {
    const store = await seededStore()

    const renamed = updateThreadMetadata(store, 'thread-1', {
      title: '  Renamed thread  ',
      tags: ['  Alpha   tag ', 'alpha tag', 'Beta'],
      unread: true,
    })
    expect(renamed).toMatchObject({
      title: 'Renamed thread',
      tags: ['Alpha tag', 'Beta'],
      unread: true,
    })

    renamed.tags.push('mutation outside the store')
    expect(store.snapshot().threads[0].tags).toEqual(['Alpha tag', 'Beta'])

    expect(updateThreadMetadata(store, 'thread-1', { pinned: true }).pinned).toBe(true)
    expect(updateThreadMetadata(store, 'thread-1', { archived: true })).toMatchObject({
      archived: true,
      pinned: false,
    })
    expect(() => updateThreadMetadata(store, 'thread-1', { pinned: true })).toThrow(/active threads/)

    const trashed = softTrashThread(store, 'thread-1', 1_000)
    expect(trashed).toMatchObject({ deletedAt: 1_000, status: 'idle', unread: false })
    expect(store.snapshot().selectedThreadId).toBeUndefined()
    expect(softTrashThread(store, 'thread-1', 2_000).deletedAt).toBe(1_000)
    expect(() => updateThreadMetadata(store, 'thread-1', { archived: false })).toThrow(/Restore the thread/)

    expect(restoreTrashedThread(store, 'thread-1')).toMatchObject({ status: 'idle', unread: false })
    expect(store.snapshot().threads[0].deletedAt).toBeUndefined()
    expect(() => restoreTrashedThread(store, 'thread-1')).toThrow(/not in Trash/)

    expect(setThreadUnread(store, 'thread-1', true).unread).toBe(true)
    expect(markThreadRead(store, 'thread-1').unread).toBe(false)
    await store.flush()
  })
})

describe('prompt library', () => {
  it('creates, updates, sorts, and deletes prompt templates', async () => {
    const store = await seededStore()

    expect(savePromptTemplate(store, {
      id: 'review',
      title: '  Review code  ',
      prompt: 'Review the selected changes.',
    }, 100)).toEqual({
      id: 'review',
      title: 'Review code',
      prompt: 'Review the selected changes.',
      createdAt: 100,
      updatedAt: 100,
    })
    savePromptTemplate(store, { id: 'explain', title: 'Explain', prompt: 'Explain this.' }, 200)
    expect(savePromptTemplate(store, {
      id: 'review',
      title: 'Review carefully',
      prompt: 'Review this for correctness and security.',
    }, 300)).toMatchObject({ createdAt: 100, updatedAt: 300 })

    expect(listPromptTemplates(store).map((prompt) => prompt.id)).toEqual(['review', 'explain'])
    const listed = listPromptTemplates(store)
    listed[0].title = 'external mutation'
    expect(listPromptTemplates(store)[0].title).toBe('Review carefully')

    expect(deletePromptTemplate(store, 'review').id).toBe('review')
    expect(listPromptTemplates(store).map((prompt) => prompt.id)).toEqual(['explain'])
    expect(() => deletePromptTemplate(store, 'review')).toThrow(/not found/)
    await store.flush()
  })
})

describe('usage accounting', () => {
  it('records only positive snapshot deltas and is idempotent for repeated snapshots', async () => {
    const store = await seededStore()

    expect(recordUsageSnapshot(store, 'thread-1', { sessionId: 'session-a', tokens: 100, cost: 1 }, 100))
      .toMatchObject({ projectId: 'project-1', threadId: 'thread-1', tokens: 100, cost: 1, timestamp: 100 })
    expect(recordUsageSnapshot(store, 'thread-1', { sessionId: 'session-a', tokens: 100, cost: 1 }, 200)).toBeNull()
    expect(recordUsageSnapshot(store, 'thread-1', { sessionId: 'session-a', tokens: 135, cost: 1.25 }, 300))
      .toMatchObject({ tokens: 35, cost: 0.25 })
    expect(recordUsageSnapshot(store, 'thread-1', { sessionId: 'session-b', tokens: 5, cost: 0.1 }, 400))
      .toMatchObject({ tokens: 5, cost: 0.1 })

    const state = store.snapshot()
    expect(state.usageLedger.map(({ tokens, cost }) => ({ tokens, cost }))).toEqual([
      { tokens: 100, cost: 1 },
      { tokens: 35, cost: 0.25 },
      { tokens: 5, cost: 0.1 },
    ])
    expect(state.threads[0].usageSnapshot).toEqual({ sessionId: 'session-b', tokens: 5, cost: 0.1 })
    await store.flush()
  })

  it('aggregates today, month, and rolling daily usage with project filtering', () => {
    const now = new Date(2026, 6, 11, 12, 0, 0)
    const at = (year: number, month: number, day: number, hour = 12): number =>
      new Date(year, month, day, hour, 0, 0).getTime()
    const entries: UsageLedgerEntry[] = [
      { id: '1', projectId: 'project-1', threadId: 'thread-1', timestamp: at(2026, 6, 11, 9), tokens: 10, cost: 0.1 },
      { id: '2', projectId: 'project-2', threadId: 'thread-2', timestamp: at(2026, 6, 11, 10), tokens: 20, cost: 0.2 },
      { id: '3', projectId: 'project-1', threadId: 'thread-1', timestamp: at(2026, 6, 10), tokens: 5, cost: 0.05 },
      { id: '4', projectId: 'project-1', threadId: 'thread-1', timestamp: at(2026, 5, 25), tokens: 7, cost: 0.07 },
      { id: '5', projectId: 'project-1', threadId: 'thread-1', timestamp: at(2026, 6, 12), tokens: 99, cost: 0.99 },
    ]

    const dashboard = aggregateUsageLedger(entries, 'project-1', now)

    expect(dashboard.today).toEqual({ tokens: 10, cost: 0.1, turns: 1 })
    expect(dashboard.month).toEqual({ tokens: 15, cost: 0.15000000000000002, turns: 2 })
    expect(dashboard.days).toHaveLength(30)
    expect(dashboard.days.at(-1)).toEqual({ date: '2026-07-11', tokens: 10, cost: 0.1, turns: 1 })
    expect(dashboard.days.find((day) => day.date === '2026-06-25')).toEqual({
      date: '2026-06-25',
      tokens: 7,
      cost: 0.07,
      turns: 1,
    })
    expect(dashboard.days.reduce((sum, day) => sum + day.tokens, 0)).toBe(22)

    const allProjects = aggregateUsageLedger(entries, undefined, now)
    expect(allProjects.today).toEqual({ tokens: 30, cost: 0.30000000000000004, turns: 2 })
  })
})
