import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  AgentMessage,
  ProjectRecord,
  SessionEntry,
  SessionTreeNode,
  ThreadRecord
} from '../shared/contracts'

interface SessionHeader {
  type: 'session'
  id: string
  timestamp?: string
  cwd: string
  version?: number
  parentSession?: string
}

interface SessionDocument {
  header: SessionHeader
  entries: SessionEntry[]
}

export interface DiscoveredSession {
  file: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHeader(value: unknown): value is SessionHeader {
  return isRecord(value) &&
    value.type === 'session' &&
    typeof value.id === 'string' &&
    typeof value.cwd === 'string'
}

function isEntry(value: unknown): value is SessionEntry {
  return isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.id === 'string' &&
    (value.parentId === null || typeof value.parentId === 'string')
}

function parseDocument(content: string, source: string): SessionDocument {
  const values: unknown[] = []
  const lines = content.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      values.push(JSON.parse(line))
    } catch (error) {
      const partialFinalRecord = index === lines.length - 1 && !content.endsWith('\n')
      if (partialFinalRecord) continue
      throw new Error(`Invalid Pi session record in ${source} at line ${index + 1}`, { cause: error })
    }
  }
  if (!isHeader(values[0])) throw new Error('Invalid Pi session header')
  return { header: values[0], entries: values.slice(1).filter(isEntry) }
}

async function readPrefix(file: string, maximum = 256 * 1024): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maximum)
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

function titleFromPrefix(prefix: string): string {
  let firstPrompt = ''
  let latestName = ''
  for (const line of prefix.split('\n')) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    if (value.type === 'session_info' && typeof value.name === 'string') latestName = value.name
    if (!firstPrompt && value.type === 'message' && isRecord(value.message) && value.message.role === 'user') {
      const content = value.message.content
      if (typeof content === 'string') firstPrompt = content
      else if (Array.isArray(content)) {
        firstPrompt = content
          .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'text')
          .map((item) => typeof item.text === 'string' ? item.text : '')
          .join(' ')
      }
    }
  }
  const title = (latestName || firstPrompt || 'Recovered Pi session').replace(/\s+/g, ' ').trim()
  return title.length > 72 ? `${title.slice(0, 69)}…` : title
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const result: string[] = []
  let directories
  try {
    directories = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    let files
    try {
      files = await readdir(join(root, directory.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.jsonl')) result.push(join(root, directory.name, file.name))
      if (result.length >= 20_000) return result
    }
  }
  return result
}

export function agentDirectory(env: Record<string, string>): string {
  return resolve(env.PI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'))
}

export function sessionDirectoryForCwd(cwd: string, env: Record<string, string>): string {
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(agentDirectory(env), 'sessions', safePath)
}

export async function discoverProjectSessions(
  projects: ProjectRecord[],
  knownThreads: ThreadRecord[],
  env: Record<string, string>
): Promise<Map<string, DiscoveredSession[]>> {
  const result = new Map<string, DiscoveredSession[]>()
  if (projects.length === 0) return result
  const projectByCwd = new Map(projects.map((project) => [resolve(project.path), project]))
  for (const thread of knownThreads) {
    const project = projects.find((candidate) => candidate.id === thread.projectId)
    if (project) projectByCwd.set(resolve(thread.cwd), project)
  }
  const files = await collectJsonlFiles(join(agentDirectory(env), 'sessions'))
  let nextFile = 0
  const inspectNext = async (): Promise<void> => {
    while (nextFile < files.length) {
      const file = files[nextFile++]
      try {
        const prefix = await readPrefix(file)
        const firstLine = prefix.split('\n', 1)[0]
        const header: unknown = JSON.parse(firstLine)
        if (!isHeader(header)) continue
        const sessionCwd = await realpath(header.cwd).catch(() => resolve(header.cwd))
        const project = projectByCwd.get(resolve(sessionCwd))
        if (!project) continue
        const info = await stat(file)
        const timestamp = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : Number.NaN
        const session: DiscoveredSession = {
          file,
          cwd: resolve(sessionCwd),
          title: titleFromPrefix(prefix),
          createdAt: Number.isFinite(timestamp) ? timestamp : info.birthtimeMs || info.mtimeMs,
          updatedAt: info.mtimeMs
        }
        const list = result.get(project.id) ?? []
        list.push(session)
        result.set(project.id, list)
      } catch {
        // Ignore malformed, unreadable, or concurrently-written session files.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, () => inspectNext()))
  for (const list of result.values()) list.sort((left, right) => right.updatedAt - left.updatedAt)
  return result
}

export function recoveredThreadId(sessionFile: string): string {
  return `session-${createHash('sha256').update(resolve(sessionFile)).digest('hex').slice(0, 20)}`
}

export async function readSessionTree(
  sessionFile: string
): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
  const document = parseDocument(await readFile(sessionFile, 'utf8'), sessionFile)
  const nodes = new Map<string, SessionTreeNode>()
  const order = new Map<string, number>()
  const labels = new Map<string, { label?: string; timestamp?: string }>()
  document.entries.forEach((entry, index) => {
    nodes.set(entry.id, { entry, children: [] })
    order.set(entry.id, index)
    if (entry.type === 'label' && typeof entry.targetId === 'string') {
      labels.set(entry.targetId, {
        ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
        ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {})
      })
    }
  })
  for (const [target, label] of labels) {
    const node = nodes.get(target)
    if (!node) continue
    node.label = label.label
    node.labelTimestamp = label.timestamp
  }
  const roots: SessionTreeNode[] = []
  for (const entry of document.entries) {
    const node = nodes.get(entry.id)
    if (!node) continue
    const parent = entry.parentId ? nodes.get(entry.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const sortTree = (items: SessionTreeNode[], ancestors: Set<string>): void => {
    items.sort((left, right) => (order.get(left.entry.id) ?? 0) - (order.get(right.entry.id) ?? 0))
    for (const item of items) {
      if (ancestors.has(item.entry.id)) {
        item.children = []
        continue
      }
      sortTree(item.children, new Set([...ancestors, item.entry.id]))
    }
  }
  sortTree(roots, new Set())
  return { tree: roots, leafId: document.entries.at(-1)?.id ?? null }
}

export async function cloneSessionAtEntry(
  sourceFile: string,
  entryId: string,
  targetCwd: string,
  env: Record<string, string>
): Promise<string> {
  return cloneSessionBranch(sourceFile, entryId, targetCwd, env, true)
}

export async function cloneSessionBranch(
  sourceFile: string,
  entryId: string,
  targetCwd: string,
  env: Record<string, string>,
  rewindSelectedUser = false
): Promise<string> {
  const document = parseDocument(await readFile(sourceFile, 'utf8'), sourceFile)
  const byId = new Map(document.entries.map((entry) => [entry.id, entry]))
  const selectedEntry = byId.get(entryId)
  if (!selectedEntry) throw new Error('The selected history entry no longer exists')
  // Pi's fork command rewinds to the parent of a selected user prompt so a
  // fork never opens with an unanswered user message at its leaf.
  const selectedMessage = selectedEntry.type === 'message' ? selectedEntry.message : undefined
  const targetEntryId = rewindSelectedUser && selectedMessage?.role === 'user' ? selectedEntry.parentId : selectedEntry.id
  const branch: SessionEntry[] = []
  const seen = new Set<string>()
  let current = targetEntryId ? byId.get(targetEntryId) : undefined
  while (current) {
    if (seen.has(current.id)) throw new Error('The Pi session tree contains a cycle')
    seen.add(current.id)
    branch.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  branch.reverse()
  const now = new Date().toISOString()
  const sessionId = randomUUID()
  const header: SessionHeader & { version: number; timestamp: string; parentSession: string } = {
    type: 'session',
    version: typeof document.header.version === 'number' ? document.header.version : 3,
    id: sessionId,
    timestamp: now,
    cwd: resolve(targetCwd),
    parentSession: resolve(sourceFile)
  }
  const directory = sessionDirectoryForCwd(targetCwd, env)
  await mkdir(directory, { recursive: true })
  const target = join(directory, `${now.replace(/[:.]/g, '-')}_${sessionId}.jsonl`)
  const data = `${[header, ...branch].map((entry) => JSON.stringify(entry)).join('\n')}\n`
  await writeFile(target, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return target
}

export async function readSessionMessages(sessionFile: string): Promise<AgentMessage[]> {
  const document = parseDocument(await readFile(sessionFile, 'utf8'), sessionFile)
  return document.entries
    .filter((entry) => entry.type === 'message' && entry.message !== undefined)
    .map((entry) => entry.message as AgentMessage)
}

// Used only by diagnostics to avoid keeping file handles open while Pi appends.
export function streamSession(sessionFile: string): NodeJS.ReadableStream {
  return createReadStream(sessionFile, { encoding: 'utf8' })
}

export function isSessionInsideAgentDirectory(sessionFile: string, env: Record<string, string>): boolean {
  const base = `${resolve(agentDirectory(env))}/`
  return resolve(sessionFile).startsWith(base) && dirname(resolve(sessionFile)).startsWith(base)
}
