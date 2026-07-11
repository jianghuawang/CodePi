import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { BrowserWindow, dialog } from 'electron'

import type { ComposerAttachment, ThreadRecord } from '../shared/contracts'

const MAX_ATTACHMENTS = 12
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_TEXT_BYTES = 1_500_000

const mimeByExtension: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml'
}

function mimeTypeFor(path: string): string {
  return mimeByExtension[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function safeName(value: string): string {
  const name = basename(value).replace(/[\0\r\n/\\]/g, '-').trim()
  return (name || 'attachment').slice(0, 220)
}

function isTextBuffer(buffer: Buffer, mimeType: string): boolean {
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return true
  return !buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)
}

async function isInside(path: string, root: string): Promise<boolean> {
  const [target, base] = await Promise.all([
    realpath(path).catch(() => resolve(path)),
    realpath(root).catch(() => resolve(root))
  ])
  return target === base || target.startsWith(`${base}/`)
}

export class AttachmentService {
  constructor(private readonly root: string) {}

  async pick(owner: BrowserWindow | undefined, thread: ThreadRecord): Promise<ComposerAttachment[]> {
    const options = {
      title: 'Attach files',
      buttonLabel: 'Attach',
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (selection.canceled) return []
    const attachments: ComposerAttachment[] = []
    for (const path of selection.filePaths.slice(0, MAX_ATTACHMENTS)) {
      attachments.push(await this.fromSelectedPath(thread, path))
    }
    return attachments
  }

  async prepare(thread: ThreadRecord, values: ComposerAttachment[]): Promise<ComposerAttachment[]> {
    if (!Array.isArray(values) || values.length > MAX_ATTACHMENTS) throw new Error('Too many attachments')
    const result: ComposerAttachment[] = []
    for (const value of values) {
      const name = safeName(value.name)
      const mimeType = typeof value.mimeType === 'string' && value.mimeType.length < 160
        ? value.mimeType
        : mimeTypeFor(name)
      const id = typeof value.id === 'string' && value.id.length < 180 ? value.id : randomUUID()
      if (value.kind === 'image') {
        if (typeof value.data !== 'string') throw new Error(`Image “${name}” is missing data`)
        const data = value.data.replace(/^data:[^;]+;base64,/, '')
        const bytes = Buffer.byteLength(data, 'base64')
        if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) throw new Error(`Image “${name}” is too large`)
        result.push({ id, name, mimeType, size: bytes, kind: 'image', data })
        continue
      }
      if (value.kind === 'text') {
        if (typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES) {
          throw new Error(`Text attachment “${name}” is too large`)
        }
        result.push({ id, name, mimeType, size: Buffer.byteLength(value.text, 'utf8'), kind: 'text', text: value.text })
        continue
      }
      if (typeof value.data === 'string') {
        const buffer = Buffer.from(value.data.replace(/^data:[^;]+;base64,/, ''), 'base64')
        if (buffer.length <= 0 || buffer.length > MAX_FILE_BYTES) throw new Error(`File “${name}” is too large`)
        const directory = join(this.root, thread.id)
        await mkdir(directory, { recursive: true })
        const path = join(directory, `${randomUUID()}-${name}`)
        await writeFile(path, buffer, { mode: 0o600 })
        result.push({ id, name, mimeType, size: buffer.length, kind: 'file', path })
        continue
      }
      if (typeof value.path !== 'string') throw new Error(`File “${name}” is missing data`)
      const allowed = await isInside(value.path, thread.cwd) || await isInside(value.path, join(this.root, thread.id))
      if (!allowed) throw new Error(`Attachment path for “${name}” is outside the thread workspace`)
      const info = await stat(value.path)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`File “${name}” is too large`)
      result.push({ id, name, mimeType, size: info.size, kind: 'file', path: await realpath(value.path) })
    }
    return result
  }

  async cleanupThread(threadId: string): Promise<void> {
    await rm(join(this.root, threadId), { recursive: true, force: true }).catch(() => undefined)
  }

  private async fromSelectedPath(thread: ThreadRecord, path: string): Promise<ComposerAttachment> {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`“${basename(path)}” is too large to attach`)
    const name = safeName(path)
    const mimeType = mimeTypeFor(path)
    const buffer = await readFile(path)
    if (mimeType.startsWith('image/')) {
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image “${name}” is too large`)
      return { id: randomUUID(), name, mimeType, size: buffer.length, kind: 'image', data: buffer.toString('base64') }
    }
    if (buffer.length <= MAX_TEXT_BYTES && isTextBuffer(buffer, mimeType)) {
      return { id: randomUUID(), name, mimeType, size: buffer.length, kind: 'text', text: buffer.toString('utf8') }
    }
    const directory = join(this.root, thread.id)
    await mkdir(directory, { recursive: true })
    const target = join(directory, `${randomUUID()}-${name}`)
    await copyFile(path, target)
    return { id: randomUUID(), name, mimeType, size: buffer.length, kind: 'file', path: target }
  }
}
