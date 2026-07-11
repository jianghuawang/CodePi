import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { shell } from 'electron'
import parseDiff from 'parse-diff'
import type { DiffFile, ThreadRecord, WorktreeRecord } from '../shared/contracts'
import { gitNullDevice } from './platform'

interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  acceptedCodes: readonly number[] = [0]
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0
        const result = { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code }
        if (!error || acceptedCodes.includes(code)) {
          resolvePromise(result)
          return
        }
        const detail = result.stderr.trim() || result.stdout.trim() || error.message
        reject(new Error(detail))
      }
    )
  })
}

async function git(cwd: string, args: readonly string[], acceptedCodes?: readonly number[]): Promise<string> {
  return (await run('git', ['-c', 'core.quotepath=false', ...args], cwd, acceptedCodes)).stdout
}

function gitWithInput(cwd: string, args: readonly string[], input: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise()
          return
        }
        reject(new Error(String(stderr ?? '').trim() || String(stdout ?? '').trim() || error.message))
      }
    )
    child.stdin?.end(input)
  })
}

function validThreadId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) throw new Error('Invalid thread identifier')
}

function pathWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child))
  return value !== '' && !value.startsWith('..') && !value.startsWith('/')
}

function cleanDiffPath(value: string | undefined): string {
  if (!value || value === '/dev/null' || value === 'NUL') return ''
  // parse-diff already removes Git's synthetic a/ and b/ prefixes. Removing
  // them again would corrupt legitimate repository paths such as a/index.ts.
  return value
}

function mapDiff(raw: string, stagedPaths: Set<string>, stageablePaths?: Set<string>): DiffFile[] {
  return parseDiff(raw).map((file) => {
    const from = cleanDiffPath(file.from)
    const to = cleanDiffPath(file.to)
    const current = to || from
    return {
      from,
      to,
      additions: file.additions,
      deletions: file.deletions,
      staged: stagedPaths.has(current),
      stageable: stageablePaths ? stageablePaths.has(current) : true,
      binary: raw.includes(`Binary files a/${from} and b/${to} differ`) || raw.includes(`Binary files /dev/null and b/${to} differ`),
      chunks: file.chunks.map((chunk) => ({
        content: chunk.content,
        oldStart: chunk.oldStart,
        oldLines: chunk.oldLines,
        newStart: chunk.newStart,
        newLines: chunk.newLines,
        changes: chunk.changes.map((change) => ({
          type: change.type,
          content: change.content,
          ...(change.type === 'normal'
            ? { oldNumber: change.ln1, newNumber: change.ln2 }
            : change.type === 'add'
              ? { newNumber: change.ln }
              : { oldNumber: change.ln })
        }))
      }))
    }
  })
}

async function excludePiGui(projectPath: string): Promise<void> {
  try {
    const excludePath = (await git(projectPath, ['rev-parse', '--git-path', 'info/exclude'])).trim()
    const absolute = resolve(projectPath, excludePath)
    const existing = await readFile(absolute, 'utf8').catch(() => '')
    if (existing.split(/\r?\n/).includes('.pi-gui/')) return
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
    await writeFile(absolute, `${existing}${prefix}.pi-gui/\n`, 'utf8')
  } catch {
    // Excluding the private worktree directory is a convenience, not a prerequisite.
  }
}

export async function isGitProject(directory: string): Promise<boolean> {
  try {
    return (await git(directory, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

export async function createWorktree(
  projectPath: string,
  threadId: string,
  seed?: ThreadRecord
): Promise<WorktreeRecord> {
  validThreadId(threadId)
  const projectCommit = (await git(projectPath, ['rev-parse', 'HEAD'])).trim()
  if (seed && !seed.worktree) throw new Error('The source thread is not isolated')
  if (seed?.worktree && !/^[0-9a-f]{40,64}$/i.test(seed.worktree.baseCommit)) {
    throw new Error('The source worktree base commit is invalid')
  }
  const startCommit = seed?.worktree
    ? (await git(seed.cwd, ['rev-parse', 'HEAD'])).trim()
    : projectCommit
  const baseCommit = seed?.worktree?.baseCommit || projectCommit
  let baseBranch = seed?.worktree?.baseBranch || (await git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim()
  if (!baseBranch) baseBranch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (!baseBranch || baseBranch === 'HEAD') throw new Error('Create a branch before using an isolated worktree')
  const branch = `pi/${threadId}`
  const worktreePath = resolve(projectPath, '.pi-gui', 'worktrees', threadId)
  if (!pathWithin(projectPath, worktreePath)) throw new Error('Invalid worktree path')
  await mkdir(dirname(worktreePath), { recursive: true })
  await excludePiGui(projectPath)
  try {
    await git(projectPath, ['worktree', 'add', '-b', branch, worktreePath, startCommit])
  } catch (error) {
    await git(projectPath, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
    await git(projectPath, ['worktree', 'prune']).catch(() => undefined)
    await git(projectPath, ['branch', '-D', branch]).catch(() => undefined)
    throw error
  }
  return { path: worktreePath, branch, baseBranch, baseCommit }
}

/** Copy the source worktree's tracked and untracked working state onto a seeded worktree. */
export async function copyWorktreeState(source: ThreadRecord, target: ThreadRecord): Promise<void> {
  if (!source.worktree || !target.worktree) return
  const patch = await git(source.cwd, ['diff', '--binary', 'HEAD', '--'])
  if (patch.trim()) await gitWithInput(target.cwd, ['apply', '--whitespace=nowarn', '--'], patch)
  const untracked = (await git(source.cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--']))
    .split('\0')
    .filter(Boolean)
    .slice(0, 5_000)
  for (const relativePath of untracked) {
    const from = resolve(source.cwd, relativePath)
    const to = resolve(target.cwd, relativePath)
    if (!pathWithin(source.cwd, from) || !pathWithin(target.cwd, to)) continue
    const details = await lstat(from).catch(() => undefined)
    if (!details?.isFile()) continue
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

export async function removeWorktree(projectPath: string, thread: ThreadRecord): Promise<void> {
  if (!thread.worktree) return
  validThreadId(thread.id)
  const expected = resolve(projectPath, '.pi-gui', 'worktrees', thread.id)
  if (resolve(thread.worktree.path) !== expected || !pathWithin(projectPath, expected)) {
    throw new Error('Refusing to remove an unexpected worktree path')
  }
  try {
    await git(projectPath, ['worktree', 'remove', '--force', expected])
  } catch {
    await git(projectPath, ['worktree', 'unlock', expected]).catch(() => undefined)
    await git(projectPath, ['worktree', 'remove', '--force', expected]).catch(async () => {
      await rm(expected, { recursive: true, force: true })
      await git(projectPath, ['worktree', 'prune'])
    })
  }
  await git(projectPath, ['branch', '-D', thread.worktree!.branch]).catch(() => undefined)
}

export async function getWorktreeRemovalRisk(thread: ThreadRecord): Promise<{
  dirty: boolean
  unpushedCommits: number
}> {
  if (!thread.worktree) return { dirty: false, unpushedCommits: 0 }
  const dirty = Boolean((await git(thread.worktree.path, ['status', '--porcelain'])).trim())
  let unpushedCommits = 0
  const upstream = await git(
    thread.worktree.path,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    [0, 1, 128]
  ).catch(() => '')
  if (upstream.trim()) {
    unpushedCommits = Number.parseInt(
      (await git(thread.worktree.path, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(),
      10
    ) || 0
  } else {
    unpushedCommits = Number.parseInt(
      (await git(thread.worktree.path, ['rev-list', '--count', `${thread.worktree.baseCommit}..HEAD`])).trim(),
      10
    ) || 0
  }
  return { dirty, unpushedCommits }
}

export async function getChanges(thread: ThreadRecord): Promise<DiffFile[]> {
  const base = thread.worktree?.baseCommit ?? 'HEAD'
  let raw = ''
  try {
    raw = await git(thread.cwd, ['diff', '--no-ext-diff', '--no-color', '--find-renames', base, '--'])
  } catch {
    const unstaged = await git(thread.cwd, ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--']).catch(() => '')
    const staged = await git(thread.cwd, ['diff', '--cached', '--no-ext-diff', '--no-color', '--find-renames', '--']).catch(() => '')
    raw = `${unstaged}\n${staged}`
  }
  const stagedOutput = await git(thread.cwd, ['diff', '--cached', '--name-only', '-z', '--']).catch(() => '')
  const stagedPaths = new Set(stagedOutput.split('\0').filter(Boolean))
  const stageablePaths = thread.worktree
    ? new Set(
        (await git(thread.cwd, ['diff', '--name-only', '-z', 'HEAD', '--']).catch(() => ''))
          .split('\0')
          .filter(Boolean)
      )
    : undefined
  const tracked = mapDiff(raw, stagedPaths, stageablePaths)
  const known = new Set(tracked.flatMap((file) => [file.from, file.to]).filter(Boolean))
  const untracked = (await git(thread.cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  for (const file of untracked.slice(0, 500)) {
    if (known.has(file)) continue
    const absolute = resolve(thread.cwd, file)
    if (!pathWithin(thread.cwd, absolute)) continue
    const output = await git(thread.cwd, ['diff', '--no-index', '--no-color', '--', gitNullDevice, file], [0, 1]).catch(() => '')
    const parsed = mapDiff(output, stagedPaths)
    for (const item of parsed) {
      if (!item.to) item.to = file
      item.staged = false
      tracked.push(item)
    }
  }
  return tracked
}

export async function setFileStaged(cwd: string, files: string[], staged: boolean): Promise<void> {
  const paths = [...new Set(files.filter(Boolean))]
  if (paths.length === 0) throw new Error('No file was selected')
  for (const file of paths) {
    const absolute = resolve(cwd, file)
    if (!pathWithin(cwd, absolute)) throw new Error('File is outside the working directory')
  }
  if (staged) {
    await git(cwd, ['add', '-A', '--', ...paths])
    return
  }
  try {
    await git(cwd, ['restore', '--staged', '--', ...paths])
  } catch {
    await git(cwd, ['reset', '-q', 'HEAD', '--', ...paths])
  }
}

export async function commitChanges(
  thread: ThreadRecord,
  message: string,
  push: boolean
): Promise<{ commit: string; pushed: boolean }> {
  const staged = (await git(thread.cwd, ['diff', '--cached', '--name-only', '--'])).trim()
  if (!staged) throw new Error('No files are staged. Stage the changes to commit first.')
  await git(thread.cwd, ['commit', '-m', message])
  const commit = (await git(thread.cwd, ['rev-parse', 'HEAD'])).trim()
  if (!push) return { commit, pushed: false }
  const upstream = await git(
    thread.cwd,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    [0, 1, 128]
  ).catch(() => '')
  if (upstream.trim()) await git(thread.cwd, ['push'])
  else await git(thread.cwd, ['push', '--set-upstream', 'origin', 'HEAD'])
  return { commit, pushed: true }
}

export async function applyWorktreeToMain(projectPath: string, thread: ThreadRecord): Promise<void> {
  const worktree = thread.worktree
  if (!worktree) throw new Error('This thread is not using an isolated worktree')
  if ((await git(worktree.path, ['status', '--porcelain'])).trim()) {
    throw new Error('Commit the worktree changes before applying them')
  }
  if ((await git(projectPath, ['status', '--porcelain'])).trim()) {
    throw new Error('The main working tree must be clean before applying changes')
  }
  const mainBranch = (await git(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim()
  if (mainBranch !== worktree.baseBranch) {
    throw new Error(`Switch the main working tree to ${worktree.baseBranch} before applying changes`)
  }
  const commits = (await git(worktree.path, ['rev-list', '--reverse', `${worktree.baseCommit}..${worktree.branch}`]))
    .trim()
    .split('\n')
    .filter(Boolean)
  if (commits.length === 0) return
  const mainHead = (await git(projectPath, ['rev-parse', 'HEAD'])).trim()
  if (mainHead === worktree.baseCommit) {
    await git(projectPath, ['merge', '--ff-only', worktree.branch])
    return
  }
  const unappliedCommits = (await git(worktree.path, ['cherry', worktree.baseBranch, worktree.branch]))
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('+ '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
  if (unappliedCommits.length === 0) return
  try {
    await git(projectPath, ['cherry-pick', ...unappliedCommits])
  } catch (error) {
    await git(projectPath, ['cherry-pick', '--abort']).catch(() => undefined)
    throw error
  }
}

export async function openDirectoryInEditor(directory: string): Promise<void> {
  try {
    await run('code', [directory], directory)
  } catch {
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  }
}
