import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadRecord } from '../src/shared/contracts'
import { normalizeThreadRelativePath, resolveThreadPath } from '../src/main/thread-path'
import { terminalLaunchOptions } from '../src/main/terminal-platform'
import { WorkspaceService } from '../src/main/workspace-service'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

function threadAt(cwd: string): ThreadRecord {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    title: 'Test thread',
    cwd,
    status: 'idle',
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

describe('thread workspace paths', () => {
  it('rejects traversal and absolute paths', () => {
    expect(() => normalizeThreadRelativePath('../secret')).toThrow(/unsafe/)
    expect(() => normalizeThreadRelativePath('/tmp/secret')).toThrow(/relative/)
    expect(() => normalizeThreadRelativePath('C:\\secret')).toThrow(/relative/)
    expect(() => normalizeThreadRelativePath('src//file.ts')).toThrow(/unsafe/)
  })

  it('rejects symlinks whose real target is outside the thread', async () => {
    const root = await temporaryDirectory('codepi-root-')
    const outside = await temporaryDirectory('codepi-outside-')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    await expect(resolveThreadPath(threadAt(root), 'escape.txt')).rejects.toThrow(/outside/)
  })
})

describe('WorkspaceService', () => {
  it('lists, searches, and previews only safe workspace files', async () => {
    const root = await temporaryDirectory('codepi-files-')
    const outside = await temporaryDirectory('codepi-external-')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(join(root, 'src', 'App.tsx'), 'export const App = () => <main />\n')
    await writeFile(join(root, 'node_modules', 'ignored', 'index.js'), 'ignored')
    await writeFile(join(outside, 'outside.ts'), 'outside')
    await symlink(join(outside, 'outside.ts'), join(root, 'outside.ts'))

    const thread = threadAt(root)
    const service = new WorkspaceService(() => thread)
    await expect(service.listFiles(thread.id)).resolves.toEqual([
      { path: 'src/App.tsx', name: 'App.tsx' },
    ])
    await expect(service.searchFiles(thread.id, 'app')).resolves.toEqual([
      { path: 'src/App.tsx', name: 'App.tsx' },
    ])
    await expect(service.readFile(thread.id, 'src/App.tsx')).resolves.toMatchObject({
      path: 'src/App.tsx',
      content: 'export const App = () => <main />\n',
      language: 'tsx',
      binary: false,
      truncated: false,
    })
  })

  it('does not expose binary bytes as renderer text', async () => {
    const root = await temporaryDirectory('codepi-binary-')
    await writeFile(join(root, 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]))
    const thread = threadAt(root)
    const preview = await new WorkspaceService(() => thread).readFile(thread.id, 'asset.bin')
    expect(preview.binary).toBe(true)
    expect(preview.content).toBe('')
  })
})

describe('terminal platform settings', () => {
  it('uses a login shell without leaking Electron renderer variables', () => {
    const launch = terminalLaunchOptions('/tmp/project', {
      SHELL: '/bin/zsh',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      PATH: '/usr/bin',
    }, 'darwin')
    expect(launch.shell).toBe('/bin/zsh')
    expect(launch.args).toEqual(['-l'])
    expect(launch.env.PWD).toBe('/tmp/project')
    expect(launch.env.ELECTRON_RENDERER_URL).toBeUndefined()
    expect(launch.env.TERM).toBe('xterm-256color')
  })
})
