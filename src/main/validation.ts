import type {
  AppSettings,
  CommitInput,
  ComposerAttachment,
  CreateThreadInput,
  DeliveryMode,
  ExportFormat,
  ThreadUpdate,
  ThemeMode,
  ViewBounds
} from '../shared/contracts'
import { normalizeTags } from '../shared/tags'

export function requireString(
  value: unknown,
  name: string,
  options: { max?: number; allowEmpty?: boolean } = {}
): string {
  const max = options.max ?? 4096
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) {
    throw new TypeError(`${name} must be a valid string`)
  }
  if (!options.allowEmpty && value.trim().length === 0) throw new TypeError(`${name} cannot be empty`)
  return value
}

export function requireId(value: unknown, name = 'id'): string {
  const id = requireString(value, name, { max: 160 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new TypeError(`${name} is invalid`)
  return id
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

export function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

export function parseCreateThreadInput(value: unknown): CreateThreadInput {
  if (!isRecord(value)) throw new TypeError('Thread options are invalid')
  let branchFrom: CreateThreadInput['branchFrom']
  if (value.branchFrom !== undefined) {
    if (!isRecord(value.branchFrom)) throw new TypeError('Branch source is invalid')
    branchFrom = {
      sourceThreadId: requireId(value.branchFrom.sourceThreadId, 'sourceThreadId'),
      entryId: requireId(value.branchFrom.entryId, 'entryId')
    }
  }
  return {
    projectId: requireId(value.projectId, 'projectId'),
    ...(value.title === undefined
      ? {}
      : { title: requireString(value.title, 'title', { max: 240, allowEmpty: true }) }),
    isolated: requireBoolean(value.isolated, 'isolated'),
    ...(branchFrom ? { branchFrom } : {})
  }
}

export function parseCommitInput(value: unknown): CommitInput {
  if (!isRecord(value)) throw new TypeError('Commit options are invalid')
  return {
    threadId: requireId(value.threadId, 'threadId'),
    message: requireString(value.message, 'commit message', { max: 10_000 }),
    push: requireBoolean(value.push, 'push')
  }
}

export function parseDeliveryMode(value: unknown): DeliveryMode {
  if (value !== 'prompt' && value !== 'steer' && value !== 'followUp') {
    throw new TypeError('Delivery mode is invalid')
  }
  return value
}

export function parseAttachments(value: unknown): ComposerAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 12) throw new TypeError('Attachments are invalid')
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`Attachment ${index + 1} is invalid`)
    const kind = item.kind
    if (kind !== 'image' && kind !== 'text' && kind !== 'file') throw new TypeError('Attachment kind is invalid')
    const size = requireInteger(item.size, 'attachment size', 0, 25 * 1024 * 1024)
    return {
      id: requireString(item.id, 'attachment id', { max: 180 }),
      name: requireString(item.name, 'attachment name', { max: 240 }),
      mimeType: requireString(item.mimeType, 'attachment mime type', { max: 160 }),
      size,
      kind,
      ...(typeof item.data === 'string' ? { data: requireString(item.data, 'attachment data', { max: 36_000_000 }) } : {}),
      ...(typeof item.text === 'string' ? { text: requireString(item.text, 'attachment text', { max: 1_500_000, allowEmpty: true }) } : {}),
      ...(typeof item.path === 'string' ? { path: requireString(item.path, 'attachment path', { max: 16_384 }) } : {})
    }
  })
}

export function parseThreadUpdate(value: unknown): ThreadUpdate {
  if (!isRecord(value)) throw new TypeError('Thread update is invalid')
  const result: ThreadUpdate = {}
  if (value.title !== undefined) result.title = requireString(value.title, 'title', { max: 240 })
  if (value.pinned !== undefined) result.pinned = requireBoolean(value.pinned, 'pinned')
  if (value.archived !== undefined) result.archived = requireBoolean(value.archived, 'archived')
  if (value.unread !== undefined) result.unread = requireBoolean(value.unread, 'unread')
  if (value.tags !== undefined) result.tags = normalizeTags(value.tags as readonly string[])
  return result
}

export function parseExportFormat(value: unknown): ExportFormat {
  if (value !== 'markdown' && value !== 'html') throw new TypeError('Export format is invalid')
  return value
}

export function parseViewBounds(value: unknown): ViewBounds {
  if (!isRecord(value)) throw new TypeError('Preview bounds are invalid')
  return {
    x: requireInteger(value.x, 'preview x', 0, 20_000),
    y: requireInteger(value.y, 'preview y', 0, 20_000),
    width: requireInteger(value.width, 'preview width', 1, 20_000),
    height: requireInteger(value.height, 'preview height', 1, 20_000)
  }
}

export function parseSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new TypeError('Settings are invalid')
  const theme = parseTheme(value.theme)
  if (!isRecord(value.env)) throw new TypeError('Environment variables are invalid')
  const env: Record<string, string> = {}
  for (const [key, item] of Object.entries(value.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`Invalid environment variable: ${key}`)
    env[key] = requireString(item, key, { max: 100_000, allowEmpty: true })
  }
  return {
    piPath: requireString(value.piPath, 'Pi path', { max: 4096 }),
    defaultModel: requireString(value.defaultModel, 'Default model', { max: 512, allowEmpty: true }),
    theme,
    env
  }
}

export function parseTheme(value: unknown): ThemeMode {
  if (value !== 'system' && value !== 'light' && value !== 'dark') throw new TypeError('Theme is invalid')
  return value
}

export function requireRepoPath(value: unknown): string {
  const file = requireString(value, 'file path', { max: 16_384 })
  if (file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file)) {
    throw new TypeError('File path must be relative')
  }
  const pieces = file.replaceAll('\\', '/').split('/')
  if (pieces.some((piece) => piece === '..' || piece === '')) throw new TypeError('File path is invalid')
  return pieces.join('/')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
