import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ThreadRecord } from '../shared/contracts'

export interface ResolvedThreadPath {
  root: string
  requestedPath: string
  realPath: string
}

/**
 * Normalizes a renderer-supplied workspace path without ever allowing it to
 * become absolute or escape through a parent segment. The empty string denotes
 * the workspace root and is only accepted when explicitly requested.
 */
export function normalizeThreadRelativePath(value: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 16_384) {
    throw new TypeError('Workspace path is invalid')
  }

  const portable = value.replaceAll('\\', '/')
  if (portable === '') {
    if (allowRoot) return ''
    throw new TypeError('Workspace path cannot be empty')
  }
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) {
    throw new TypeError('Workspace path must be relative')
  }

  const pieces = portable.split('/')
  if (pieces.some((piece) => piece === '' || piece === '.' || piece === '..')) {
    throw new TypeError('Workspace path contains an unsafe segment')
  }
  return pieces.join('/')
}

export function isPathInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

/** Resolve an existing path and verify both its lexical and real path stay in the thread root. */
export async function resolveThreadPath(
  thread: Pick<ThreadRecord, 'cwd'>,
  requestedPath: string,
  options: { allowRoot?: boolean } = {},
): Promise<ResolvedThreadPath> {
  const normalized = normalizeThreadRelativePath(requestedPath, options.allowRoot)
  const root = await realpath(thread.cwd)
  const lexicalPath = normalized === '' ? root : resolve(root, ...normalized.split('/'))
  if (!isPathInside(root, lexicalPath)) throw new Error('Workspace path escapes the thread directory')

  const target = await realpath(lexicalPath)
  if (!isPathInside(root, target)) throw new Error('Workspace symlink points outside the thread directory')
  return { root, requestedPath: normalized, realPath: target }
}
