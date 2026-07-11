import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { exportThreadToPath, renderThreadHtml, renderThreadMarkdown } from '../src/main/export-service'
import type { AgentMessage, ThreadRecord } from '../src/shared/contracts'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const thread: ThreadRecord = {
  id: 'thread-1',
  projectId: 'project-1',
  title: 'Review </title><script>titleAttack()</script>',
  cwd: '/tmp/a & b/<workspace>',
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

const messages: AgentMessage[] = [
  {
    role: 'user',
    content: '<script>alert("user")</script> & question',
    timestamp: Date.UTC(2026, 6, 11, 1, 0, 0),
  },
  {
    role: 'assistant',
    provider: 'provider',
    model: 'model <unsafe>',
    content: [
      { type: 'text', text: 'Answer <b>bold?</b> & complete' },
      { type: 'thinking', thinking: 'Private <reasoning> & detail' },
      { type: 'toolCall', id: 'call-1', name: 'read <file>', arguments: { path: '<img src=x onerror=attack()>' } },
    ],
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: { total: 0.1234 },
    },
    errorMessage: 'Error <img src=x onerror=attack()>',
    timestamp: Date.UTC(2026, 6, 11, 1, 1, 0),
  },
  {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read <file>',
    content: [{ type: 'text', text: '</pre><script>toolAttack()</script>' }],
    isError: true,
    timestamp: Date.UTC(2026, 6, 11, 1, 2, 0),
  },
  {
    role: 'bashExecution',
    command: 'printf "hello"',
    output: 'output with ``` embedded fence',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.UTC(2026, 6, 11, 1, 3, 0),
  },
]

const exportedAt = new Date(Date.UTC(2026, 6, 11, 2, 0, 0))

describe('thread Markdown export', () => {
  it('includes transcript metadata, optional detail, usage, and collision-safe code fences', () => {
    const markdown = renderThreadMarkdown({
      thread,
      messages,
      projectName: 'Project & Docs',
      includeThinking: true,
      includeTools: true,
      exportedAt,
    })

    expect(markdown).toContain('# Review </title><script>titleAttack()</script>')
    expect(markdown).toContain('- Exported: 2026-07-11T02:00:00.000Z')
    expect(markdown).toContain('- Total tokens: 10')
    expect(markdown).toContain('- Total reported cost: $0.1234')
    expect(markdown).toContain('<summary>Thinking</summary>')
    expect(markdown).toContain('<summary>Tool call: read <file></summary>')
    expect(markdown).toContain('Usage: 10 tokens (1 input, 2 output) · $0.1234')
    expect(markdown).toContain('````text\noutput with ``` embedded fence\n````')
  })

  it('omits thinking and tool activity when requested', () => {
    const markdown = renderThreadMarkdown({
      thread,
      messages,
      includeThinking: false,
      includeTools: false,
      exportedAt,
    })

    expect(markdown).not.toContain('Private <reasoning>')
    expect(markdown).not.toContain('Tool call:')
    expect(markdown).not.toContain('Tool result:')
    expect(markdown).not.toContain('Shell command')
    expect(markdown).toContain('Answer <b>bold?</b> & complete')
  })
})

describe('thread HTML export', () => {
  it('escapes transcript-controlled text in every rendered context', () => {
    const html = renderThreadHtml({
      thread,
      messages,
      projectName: '<img src=x onerror=projectAttack()>',
      includeThinking: true,
      includeTools: true,
      exportedAt,
    })

    expect(html).toContain('Review &lt;/title&gt;&lt;script&gt;titleAttack()&lt;/script&gt;')
    expect(html).toContain('&lt;script&gt;alert(&quot;user&quot;)&lt;/script&gt; &amp; question')
    expect(html).toContain('model &lt;unsafe&gt;')
    expect(html).toContain('Answer &lt;b&gt;bold?&lt;/b&gt; &amp; complete')
    expect(html).toContain('Private &lt;reasoning&gt; &amp; detail')
    expect(html).toContain('Tool call: read &lt;file&gt;')
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;toolAttack()&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=projectAttack()&gt;')
    expect(html).not.toContain('<script>titleAttack()</script>')
    expect(html).not.toContain('<script>alert("user")</script>')
    expect(html).not.toContain('<script>toolAttack()</script>')
    expect(html).not.toContain('<img src=x onerror=')
  })

  it('writes the requested format and returns exact byte and usage totals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codepi-export-'))
    temporaryPaths.push(directory)
    const outputPath = join(directory, 'thread.html')

    const result = await exportThreadToPath({
      thread,
      messages,
      projectName: 'Project',
      includeThinking: false,
      includeTools: true,
      exportedAt,
      outputPath,
      format: 'html',
    })
    const written = await readFile(outputPath, 'utf8')

    expect(result).toMatchObject({
      path: outputPath,
      bytes: Buffer.byteLength(written, 'utf8'),
      format: 'html',
      usage: {
        turns: 1,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        cost: 0.1234,
      },
    })
    expect(written).toContain('<!doctype html>')
  })
})
