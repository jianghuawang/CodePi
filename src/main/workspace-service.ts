import { opendir, open, realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { ThreadRecord, WorkspaceFile, WorkspaceFilePreview } from '../shared/contracts'
import { isPathInside, resolveThreadPath } from './thread-path'

type ThreadLookup = (threadId: string) => ThreadRecord

interface ScannedFile extends WorkspaceFile {
  realPath: string
}

interface ScanCacheEntry {
  expiresAt: number
  files: ScannedFile[]
}

const MAX_FILES = 25_000
const MAX_DEPTH = 40
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
const CACHE_TTL_MS = 1_000
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.pi-gui',
  'node_modules',
  'out',
  'release',
  'dist',
  'coverage',
  '.next',
  '.turbo',
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.bash': 'shellscript',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.css': 'css',
  '.fish': 'shellscript',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.htm': 'html',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.less': 'less',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'shellscript',
  '.sql': 'sql',
  '.svelte': 'svelte',
  '.swift': 'swift',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'shellscript',
}

function languageForPath(path: string): string {
  const name = basename(path).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  return LANGUAGE_BY_EXTENSION[extname(name)] ?? 'text'
}

function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 64 * 1024)
  if (sampleLength === 0) return false
  let suspicious = 0
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index]
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1
  }
  return suspicious / sampleLength > 0.08
}

function scoreFile(path: string, query: string): number {
  const normalizedPath = path.toLocaleLowerCase()
  const fileName = basename(normalizedPath)
  if (fileName === query) return 0
  if (fileName.startsWith(query)) return 1
  if (fileName.includes(query)) return 2
  if (normalizedPath.startsWith(query)) return 3
  return normalizedPath.includes(query) ? 4 : Number.POSITIVE_INFINITY
}

export class WorkspaceService {
  private readonly scanCache = new Map<string, ScanCacheEntry>()

  constructor(private readonly getThread: ThreadLookup) {}

  async listFiles(threadId: string): Promise<WorkspaceFile[]> {
    const files = await this.scan(threadId)
    return files.map(({ path, name, status }) => ({ path, name, ...(status ? { status } : {}) }))
  }

  async searchFiles(threadId: string, queryValue: string, limitValue = 40): Promise<WorkspaceFile[]> {
    const query = queryValue.trim().toLocaleLowerCase()
    if (!query) return []
    if (query.length > 1_000) throw new TypeError('File search query is too long')
    const limit = Math.min(100, Math.max(1, Math.trunc(limitValue)))
    const files = await this.scan(threadId)
    return files
      .map((file) => ({ file, score: scoreFile(file.path, query) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => left.score - right.score || left.file.path.length - right.file.path.length || left.file.path.localeCompare(right.file.path))
      .slice(0, limit)
      .map(({ file }) => ({ path: file.path, name: file.name }))
  }

  async recentFiles(threadId: string, limitValue = 12): Promise<WorkspaceFile[]> {
    const limit = Math.min(50, Math.max(1, Math.trunc(limitValue)))
    const files = await this.scan(threadId)
    const dated: Array<{ file: ScannedFile; modifiedAt: number }> = []
    const concurrency = 48
    for (let start = 0; start < files.length; start += concurrency) {
      const batch = files.slice(start, start + concurrency)
      const details = await Promise.all(batch.map(async (file) => ({
        file,
        modifiedAt: await stat(file.realPath).then((value) => value.mtimeMs).catch(() => 0),
      })))
      dated.push(...details)
    }
    return dated
      .filter((item) => item.modifiedAt > 0)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, limit)
      .map(({ file }) => ({ path: file.path, name: file.name }))
  }

  async readFile(threadId: string, relativePath: string): Promise<WorkspaceFilePreview> {
    const thread = this.getThread(threadId)
    const resolved = await resolveThreadPath(thread, relativePath)
    const handle = await open(resolved.realPath, 'r')
    try {
      const details = await handle.stat()
      if (!details.isFile()) throw new Error('Workspace path is not a file')
      const bytesToRead = Math.min(details.size, MAX_PREVIEW_BYTES)
      const buffer = Buffer.allocUnsafe(bytesToRead)
      let offset = 0
      while (offset < bytesToRead) {
        const result = await handle.read(buffer, offset, bytesToRead - offset, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
      }
      const contentBuffer = offset === buffer.length ? buffer : buffer.subarray(0, offset)
      const binary = looksBinary(contentBuffer)
      const content = binary ? '' : contentBuffer.toString('utf8').replace(/^\uFEFF/, '')
      return {
        path: resolved.requestedPath,
        content,
        language: languageForPath(resolved.requestedPath),
        size: details.size,
        modifiedAt: details.mtimeMs,
        binary,
        truncated: details.size > contentBuffer.length,
      }
    } finally {
      await handle.close()
    }
  }

  invalidate(threadId?: string): void {
    if (threadId) this.scanCache.delete(threadId)
    else this.scanCache.clear()
  }

  private async scan(threadId: string): Promise<ScannedFile[]> {
    const cached = this.scanCache.get(threadId)
    if (cached && cached.expiresAt > Date.now()) return cached.files
    const thread = this.getThread(threadId)
    const root = await realpath(thread.cwd)
    const files: ScannedFile[] = []

    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
      const iterator = await opendir(directory)
      for await (const entry of iterator) {
        if (files.length >= MAX_FILES) break
        if (entry.name === '.DS_Store') continue
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        const absolutePath = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolutePath, relativePath, depth + 1)
          continue
        }
        if (entry.isFile()) {
          files.push({ path: relativePath, name: entry.name, realPath: absolutePath })
          continue
        }
        if (!entry.isSymbolicLink()) continue
        const target = await realpath(absolutePath).catch(() => undefined)
        if (!target || !isPathInside(root, target)) continue
        const targetDetails = await stat(target).catch(() => undefined)
        // Do not recurse through directory symlinks: it avoids cycles and keeps
        // file enumeration rooted in the visible workspace tree.
        if (targetDetails?.isFile()) files.push({ path: relativePath, name: entry.name, realPath: target })
      }
    }

    await walk(root, '', 0)
    files.sort((left, right) => left.path.localeCompare(right.path, 'en', { numeric: true, sensitivity: 'base' }))
    this.scanCache.set(threadId, { expiresAt: Date.now() + CACHE_TTL_MS, files })
    return files
  }
}
