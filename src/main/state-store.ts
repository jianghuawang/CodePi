import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AppSettings,
  PersistedState,
  ProjectRecord,
  ThreadRecord,
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
    ...(worktree ? { worktree } : {})
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
  return {
    version: 1,
    projects,
    threads,
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
    let value: unknown
    try {
      value = JSON.parse(await readFile(filePath, 'utf8'))
    } catch {
      value = undefined
    }
    return new StateStore(filePath, normalizeState(value))
  }

  snapshot(): InternalPersistedState {
    return clone(this.state)
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
    version: 1,
    projects: [],
    threads: [],
    windowBounds: clone(defaultBounds),
    settings: clone(defaultSettings)
  }
}
