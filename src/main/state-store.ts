import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AppSettings,
  PersistedState,
  PromptTemplate,
  ProjectRecord,
  ThreadRecord,
  UsageLedgerEntry,
  WindowBounds
} from '../shared/contracts'

export interface InternalPersistedState extends PersistedState {
  dismissedSessionFiles?: string[]
}

const defaultBounds: WindowBounds = { width: 1240, height: 820 }
const defaultSettings: AppSettings = {
  piPath: 'pi',
  defaultModel: '',
  theme: 'system',
  env: {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown, maximum = 200): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))].slice(0, maximum)
}

function normalizeBounds(value: unknown): WindowBounds {
  const record = isRecord(value) ? value : {}
  const width = Math.min(6000, Math.max(900, finiteNumber(record.width, defaultBounds.width)))
  const height = Math.min(4000, Math.max(620, finiteNumber(record.height, defaultBounds.height)))
  const x = typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : undefined
  const y = typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : undefined
  return { width, height, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) }
}

function normalizeSettings(value: unknown): AppSettings {
  const record = isRecord(value) ? value : {}
  const theme = record.theme === 'light' || record.theme === 'dark' ? record.theme : 'system'
  const env: Record<string, string> = {}
  if (isRecord(record.env)) {
    for (const [key, item] of Object.entries(record.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string') env[key] = item
    }
  }
  return {
    piPath: typeof record.piPath === 'string' && record.piPath.length > 0 ? record.piPath : 'pi',
    defaultModel: typeof record.defaultModel === 'string' ? record.defaultModel : '',
    theme,
    env
  }
}

function normalizeProject(value: unknown): ProjectRecord | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.isGit !== 'boolean'
  ) return null
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    isGit: value.isGit,
    expanded: value.expanded !== false,
    createdAt: finiteNumber(value.createdAt, Date.now())
  }
}

function normalizeThread(value: unknown): ThreadRecord | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.cwd !== 'string'
  ) return null
  const status = value.status === 'error' ? 'error' : 'idle'
  const worktree = isRecord(value.worktree) &&
    typeof value.worktree.path === 'string' &&
    typeof value.worktree.branch === 'string' &&
    typeof value.worktree.baseBranch === 'string' &&
    typeof value.worktree.baseCommit === 'string'
    ? {
        path: value.worktree.path,
        branch: value.worktree.branch,
        baseBranch: value.worktree.baseBranch,
        baseCommit: value.worktree.baseCommit
      }
    : undefined
  return {
    id: value.id,
    projectId: value.projectId,
    title: value.title,
    cwd: value.cwd,
    status,
    createdAt: finiteNumber(value.createdAt, Date.now()),
    updatedAt: finiteNumber(value.updatedAt, Date.now()),
    ...(typeof value.sessionFile === 'string' ? { sessionFile: value.sessionFile } : {}),
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
    ...(worktree ? { worktree } : {}),
    pinned: value.pinned === true,
    archived: value.archived === true,
    unread: value.unread === true,
    tags: stringArray(value.tags, 24).map((tag) => tag.slice(0, 48)),
    ...(typeof value.deletedAt === 'number' && Number.isFinite(value.deletedAt) ? { deletedAt: value.deletedAt } : {}),
    disabledCapabilityIds: stringArray(value.disabledCapabilityIds, 2_000),
    autoRetryEnabled: value.autoRetryEnabled !== false,
    ...(isRecord(value.usageSnapshot) &&
      typeof value.usageSnapshot.sessionId === 'string' &&
      typeof value.usageSnapshot.tokens === 'number' &&
      typeof value.usageSnapshot.cost === 'number'
      ? {
          usageSnapshot: {
            sessionId: value.usageSnapshot.sessionId,
            tokens: Math.max(0, finiteNumber(value.usageSnapshot.tokens, 0)),
            cost: Math.max(0, finiteNumber(value.usageSnapshot.cost, 0))
          }
        }
      : {})
  }
}

function normalizePromptTemplate(value: unknown): PromptTemplate | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.prompt !== 'string') {
    return null
  }
  return {
    id: value.id,
    title: value.title.slice(0, 120),
    prompt: value.prompt.slice(0, 200_000),
    createdAt: finiteNumber(value.createdAt, Date.now()),
    updatedAt: finiteNumber(value.updatedAt, Date.now())
  }
}

function normalizeUsageEntry(value: unknown): UsageLedgerEntry | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.threadId !== 'string'
  ) return null
  return {
    id: value.id,
    projectId: value.projectId,
    threadId: value.threadId,
    timestamp: finiteNumber(value.timestamp, Date.now()),
    tokens: Math.max(0, finiteNumber(value.tokens, 0)),
    cost: Math.max(0, finiteNumber(value.cost, 0))
  }
}

function normalizeState(value: unknown): InternalPersistedState {
  const record = isRecord(value) ? value : {}
  const projects = Array.isArray(record.projects)
    ? record.projects.map(normalizeProject).filter((item): item is ProjectRecord => item !== null)
    : []
  const projectIds = new Set(projects.map((project) => project.id))
  const threads = Array.isArray(record.threads)
    ? record.threads
        .map(normalizeThread)
        .filter((item): item is ThreadRecord => item !== null && projectIds.has(item.projectId))
    : []
  const dismissedSessionFiles = Array.isArray(record.dismissedSessionFiles)
    ? record.dismissedSessionFiles.filter((item): item is string => typeof item === 'string')
    : []
  const promptLibrary = Array.isArray(record.promptLibrary)
    ? record.promptLibrary.map(normalizePromptTemplate).filter((item): item is PromptTemplate => item !== null).slice(0, 500)
    : []
  const usageLedger = Array.isArray(record.usageLedger)
    ? record.usageLedger.map(normalizeUsageEntry).filter((item): item is UsageLedgerEntry => item !== null).slice(-20_000)
    : []
  return {
    version: 2,
    projects,
    threads,
    promptLibrary,
    usageLedger,
    ...(typeof record.selectedThreadId === 'string' ? { selectedThreadId: record.selectedThreadId } : {}),
    windowBounds: normalizeBounds(record.windowBounds),
    settings: normalizeSettings(record.settings),
    dismissedSessionFiles
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class StateStore {
  readonly filePath: string
  private state: InternalPersistedState
  private saveTimer: NodeJS.Timeout | undefined
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(filePath: string, state: InternalPersistedState) {
    this.filePath = filePath
    this.state = state
  }

  static async open(userDataPath: string): Promise<StateStore> {
    const filePath = join(userDataPath, 'state.json')
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new StateStore(filePath, normalizeState(undefined))
      }
      throw new Error(`CodePi could not read its state file at ${filePath}`, { cause: error })
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
      await copyFile(filePath, backupPath, constants.COPYFILE_EXCL).catch(() => undefined)
      throw new Error(`CodePi state is not valid JSON. The original was preserved and copied to ${backupPath}.`, { cause: error })
    }
    if (isRecord(value) && typeof value.version === 'number' && value.version > 2) {
      throw new Error(`CodePi state version ${value.version} is newer than this app supports`)
    }
    if (isRecord(value) && value.version === 1) {
      await copyFile(filePath, `${filePath}.v1.bak`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
    return new StateStore(filePath, normalizeState(value))
  }

  snapshot(): InternalPersistedState {
    return clone(this.state)
  }

  /** Read-only view of the live state without the deep-clone cost of snapshot(). Never mutate it; writes go through update(). */
  peek(): Readonly<InternalPersistedState> {
    return this.state
  }

  update(mutator: (state: InternalPersistedState) => void): void {
    mutator(this.state)
    this.scheduleSave()
  }

  replace(state: InternalPersistedState): void {
    this.state = normalizeState(state)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.enqueueWrite()
    }, 180)
  }

  private enqueueWrite(): Promise<void> {
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(join(this.filePath, '..'), { recursive: true })
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 })
        await rename(tempPath, this.filePath)
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined)
      }
    })
    return this.writeChain
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      await this.enqueueWrite()
    }
    await this.writeChain
  }
}

export function makeDefaultState(): PersistedState {
  return {
    version: 2,
    projects: [],
    threads: [],
    promptLibrary: [],
    usageLedger: [],
    windowBounds: clone(defaultBounds),
    settings: clone(defaultSettings)
  }
}
