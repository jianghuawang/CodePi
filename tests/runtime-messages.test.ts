import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../src/shared/contracts'
import { appendMessage, markOptimisticUserMessage } from '../src/renderer/runtime-messages'

function user(content: string, timestamp: number): AgentMessage {
  return { role: 'user', content, timestamp }
}

describe('runtime message reconciliation', () => {
  it('preserves repeated user prompts as distinct actions', () => {
    const first = user('continue', 1)
    const second = user('continue', 2)
    expect(appendMessage([first], second)).toEqual([first, second])
  })

  it('replaces an optimistic user message with its authoritative event', () => {
    const optimistic = user('review this', 1)
    const authoritative = user('review this', 2)
    markOptimisticUserMessage(optimistic)
    expect(appendMessage([optimistic], authoritative)).toEqual([authoritative])
  })

  it('deduplicates tool results by tool-call identity', () => {
    const first: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'first' }],
      isError: false,
      timestamp: 1,
    }
    const repeated: AgentMessage = { ...first, timestamp: 2 }
    expect(appendMessage([first], repeated)).toEqual([first])
  })
})
