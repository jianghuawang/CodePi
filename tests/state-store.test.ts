import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { makeDefaultState, StateStore } from '../src/main/state-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codepi-state-'))
  temporaryPaths.push(path)
  return path
}

describe('StateStore migrations', () => {
  it('normalizes v1 threads to v2 metadata and preserves the original file as a backup', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'state.json')
    const legacyState = {
      version: 1,
      projects: [
        {
          id: 'project-1',
          name: 'Example',
          path: '/tmp/example',
          isGit: true,
          expanded: false,
          createdAt: 10,
        },
      ],
      threads: [
        {
          id: 'thread-1',
          projectId: 'project-1',
          title: 'Legacy thread',
          cwd: '/tmp/example',
          status: 'running',
          createdAt: 20,
          updatedAt: 30,
        },
      ],
      selectedThreadId: 'thread-1',
      windowBounds: { width: 800, height: 9_000, x: 15, y: 'invalid' },
      settings: {
        piPath: '/usr/local/bin/pi',
        defaultModel: 'provider/model',
        theme: 'light',
        env: { VALID_KEY: 'secret', 'invalid-key': 'discard me' },
      },
    }
    const original = `${JSON.stringify(legacyState, null, 2)}\n`
    await writeFile(filePath, original)

    const store = await StateStore.open(directory)
    const state = store.snapshot()

    expect(state.version).toBe(2)
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0]).toMatchObject({
      id: 'thread-1',
      status: 'idle',
      pinned: false,
      archived: false,
      unread: false,
      tags: [],
      disabledCapabilityIds: [],
      autoRetryEnabled: true,
    })
    expect(state.promptLibrary).toEqual([])
    expect(state.usageLedger).toEqual([])
    expect(state.windowBounds).toEqual({ width: 900, height: 4_000, x: 15 })
    expect(state.settings.env).toEqual({ VALID_KEY: 'secret' })
    await expect(readFile(`${filePath}.v1.bak`, 'utf8')).resolves.toBe(original)

    await store.flush()
  })

  it('rejects a state file from a newer application version', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 3 }))

    await expect(StateStore.open(directory)).rejects.toThrow(/newer than this app supports/)
  })

  it('preserves corrupt state instead of silently replacing it with defaults', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'state.json')
    await writeFile(filePath, '{"version":2,"projects":[')

    await expect(StateStore.open(directory)).rejects.toThrow(/not valid JSON/)
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"version":2,"projects":[')
    expect((await readdir(directory)).some((name) => name.startsWith('state.json.corrupt-') && name.endsWith('.bak'))).toBe(true)
  })
})

describe('StateStore persistence', () => {
  it('flushes the latest queued state as valid JSON and leaves no temporary file behind', async () => {
    const directory = await temporaryDirectory()
    const store = await StateStore.open(directory)

    store.update((state) => {
      state.projects.push({
        id: 'project-1',
        name: 'First name',
        path: '/tmp/project',
        isGit: false,
        expanded: true,
        createdAt: 1,
      })
    })
    store.update((state) => {
      state.projects[0].name = 'Latest name'
      state.settings.theme = 'dark'
    })
    await store.flush()

    const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
    expect(persisted).toMatchObject({
      version: 2,
      projects: [{ id: 'project-1', name: 'Latest name' }],
      settings: { theme: 'dark' },
    })
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('returns independent default state values', () => {
    const first = makeDefaultState()
    const second = makeDefaultState()

    first.windowBounds.width = 999
    first.settings.theme = 'dark'
    first.promptLibrary.push({ id: 'x', title: 'x', prompt: 'x', createdAt: 1, updatedAt: 1 })

    expect(second).toEqual({
      version: 2,
      projects: [],
      threads: [],
      promptLibrary: [],
      usageLedger: [],
      windowBounds: { width: 1240, height: 820 },
      settings: { piPath: 'pi', defaultModel: '', theme: 'system', env: {} },
    })
  })
})
