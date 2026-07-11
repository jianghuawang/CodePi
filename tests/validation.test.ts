import { describe, expect, it } from 'vitest'
import {
  parseCreateThreadInput,
  parseThreadUpdate,
  requireRepoPath,
} from '../src/main/validation'
import { ipcChannels } from '../src/shared/ipc-channels'

describe('IPC validation', () => {
  it('requires an explicit worktree choice when creating a thread', () => {
    expect(parseCreateThreadInput({ projectId: 'project-1', isolated: false })).toEqual({
      projectId: 'project-1',
      isolated: false,
    })
    expect(() => parseCreateThreadInput({ projectId: 'project-1' })).toThrow(/isolated/)
  })

  it('normalizes tags and rejects invalid tag payloads', () => {
    expect(parseThreadUpdate({ tags: [' review ', 'Review', 'needs   tests'] })).toEqual({
      tags: ['review', 'needs tests'],
    })
    expect(() => parseThreadUpdate({ tags: 'review' })).toThrow(/Tags are invalid/)
  })

  it('accepts only normalized repository-relative paths', () => {
    expect(requireRepoPath('src/main/index.ts')).toBe('src/main/index.ts')
    expect(requireRepoPath('src\\main\\index.ts')).toBe('src/main/index.ts')
    expect(() => requireRepoPath('../state.json')).toThrow(/invalid/)
    expect(() => requireRepoPath('/tmp/state.json')).toThrow(/relative/)
  })
})

describe('IPC channel allowlist', () => {
  it('uses unique, namespaced channel names', () => {
    const values = Object.values(ipcChannels)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((channel) => channel.startsWith('codepi:'))).toBe(true)
  })
})
