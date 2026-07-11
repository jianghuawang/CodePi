import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionMessages } from '../src/main/sessions'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function sessionFile(lines: string[], trailingNewline = true): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codepi-session-'))
  temporaryPaths.push(directory)
  const file = join(directory, 'session.jsonl')
  await writeFile(file, `${lines.join('\n')}${trailingNewline ? '\n' : ''}`, 'utf8')
  return file
}

const header = JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp/project' })
const message = JSON.stringify({
  type: 'message',
  id: 'message-1',
  parentId: null,
  message: { role: 'user', content: 'hello', timestamp: 1 },
})

describe('Pi session parsing', () => {
  it('rejects malformed records before the end of a session', async () => {
    const file = await sessionFile([header, message, '{broken', message])
    await expect(readSessionMessages(file)).rejects.toThrow(/line 3/)
  })

  it('tolerates only an interrupted final JSONL record', async () => {
    const file = await sessionFile([header, message, '{partial'], false)
    await expect(readSessionMessages(file)).resolves.toEqual([
      { role: 'user', content: 'hello', timestamp: 1 },
    ])
  })
})
