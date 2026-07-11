import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings, ThreadRecord } from '../src/shared/contracts'
import {
  buildCapabilitySpawnArgs,
  disabledCapabilityIdsForSafeRestart,
  listPiCapabilities,
  parsePiListOutput,
  piCapabilityId
} from '../src/main/pi-capabilities'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function thread(cwd: string): ThreadRecord {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    title: 'Capabilities',
    cwd,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    unread: false,
    tags: [],
    disabledCapabilityIds: [],
    autoRetryEnabled: true
  }
}

describe('Pi capability discovery', () => {
  it('builds an idempotent persistent disable set for safe restart', () => {
    const existing = ['stale-id', 'extension-id']
    const capabilities = [{ id: 'extension-id' }, { id: 'skill-id' }]

    expect(disabledCapabilityIdsForSafeRestart(existing, capabilities)).toEqual([
      'stale-id',
      'extension-id',
      'skill-id'
    ])
    expect(disabledCapabilityIdsForSafeRestart(
      disabledCapabilityIdsForSafeRestart(existing, capabilities),
      capabilities
    )).toEqual(['stale-id', 'extension-id', 'skill-id'])
  })

  it('parses package roots and creates kind-sensitive stable ids', () => {
    expect(parsePiListOutput(`User packages:\n  npm:one\n    /tmp/one\nProject packages:\n  npm:two\n    /tmp/two\n`)).toEqual([
      { source: 'npm:one', scope: 'user', path: '/tmp/one' },
      { source: 'npm:two', scope: 'project', path: '/tmp/two' }
    ])
    expect(piCapabilityId('skill', '/tmp/item')).toBe(piCapabilityId('skill', '/tmp/item'))
    expect(piCapabilityId('skill', '/tmp/item')).not.toBe(piCapabilityId('extension', '/tmp/item'))
  })

  it('discovers native resources and emits an explicit deterministic allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codepi-capabilities-'))
    temporaryPaths.push(root)
    const home = join(root, 'home')
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const packageRoot = join(root, 'package')
    const pi = join(root, 'pi')

    await Promise.all([
      mkdir(join(agentDir, 'extensions'), { recursive: true }),
      mkdir(join(home, '.agents', 'skills', 'global-skill'), { recursive: true }),
      mkdir(join(project, '.pi', 'extensions'), { recursive: true }),
      mkdir(join(project, '.pi', 'skills', 'project-skill'), { recursive: true }),
      mkdir(join(packageRoot, 'extensions'), { recursive: true }),
      mkdir(join(packageRoot, 'skills', 'package-skill'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(agentDir, 'extensions', 'user.ts'), 'export default () => {}\n'),
      writeFile(join(home, '.agents', 'skills', 'global-skill', 'SKILL.md'), '---\nname: global-skill\ndescription: Global test skill\n---\n'),
      writeFile(join(project, '.pi', 'extensions', 'project.ts'), 'export default () => {}\n'),
      writeFile(join(project, '.pi', 'skills', 'project-skill', 'SKILL.md'), '---\nname: project-skill\ndescription: Project test skill\n---\n'),
      writeFile(join(packageRoot, 'extensions', 'enabled.ts'), 'export default () => {}\n'),
      writeFile(join(packageRoot, 'extensions', 'disabled.ts'), 'export default () => {}\n'),
      writeFile(join(packageRoot, 'skills', 'package-skill', 'SKILL.md'), '---\nname: package-skill\ndescription: Package test skill\n---\n'),
      writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'test-package',
          pi: { extensions: ['extensions/*.ts'], skills: ['skills'] }
        })
      ),
      writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          packages: [{ source: packageRoot, extensions: ['-extensions/disabled.ts'] }]
        })
      )
    ])
    await writeFile(
      pi,
      `#!/bin/sh\nprintf '%s\\n' 'User packages:' '  ${packageRoot}' '    ${packageRoot}'\n`
    )
    await chmod(pi, 0o755)

    const settings: AppSettings = {
      piPath: pi,
      defaultModel: '',
      theme: 'system',
      env: { HOME: home, PI_CODING_AGENT_DIR: agentDir }
    }
    const record = thread(project)
    const capabilities = await listPiCapabilities(record, settings)

    expect(capabilities.map((capability) => capability.name)).toEqual([
      'project',
      'user',
      'enabled',
      'project-skill',
      'global-skill',
      'package-skill'
    ])
    expect(capabilities.find((capability) => capability.name === 'disabled')).toBeUndefined()
    expect(capabilities.find((capability) => capability.name === 'package-skill')?.packageName).toBe('test-package')

    const disabled = capabilities.find((capability) => capability.name === 'project-skill')
    expect(disabled).toBeDefined()
    record.disabledCapabilityIds = [disabled!.id]
    const args = await buildCapabilitySpawnArgs(record, settings)
    expect(args.slice(0, 2)).toEqual(['--no-extensions', '--no-skills'])
    expect(args).not.toContain(disabled!.path)
    expect(args.filter((value) => value === '--extension')).toHaveLength(3)
    expect(args.filter((value) => value === '--skill')).toHaveLength(2)
  })
})
