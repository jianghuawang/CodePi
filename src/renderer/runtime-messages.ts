import type { AgentMessage } from '../shared/contracts'

const optimisticUserMessages = new WeakSet<object>()

function messageText(message: AgentMessage): string {
  if (message.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((item) => item.type === 'text')
        .map((item) => item.type === 'text' ? item.text : '')
        .join('\n')
}

export function markOptimisticUserMessage(message: AgentMessage): void {
  if (message.role !== 'user') throw new TypeError('Only user messages can be optimistic')
  optimisticUserMessages.add(message)
}

export function appendMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  if (message.role === 'user') {
    const authoritativeText = messageText(message)
    const optimisticIndex = messages.findIndex((candidate) => {
      if (candidate.role !== 'user' || !optimisticUserMessages.has(candidate)) return false
      const draft = messageText(candidate)
      return Math.abs(candidate.timestamp - message.timestamp) < 5 * 60_000 &&
        (authoritativeText === draft ||
          authoritativeText.startsWith(`${draft}\n\nAttached`) ||
          authoritativeText.startsWith(`${draft}\n\n📎`))
    })
    if (optimisticIndex >= 0) {
      optimisticUserMessages.delete(messages[optimisticIndex])
      const next = [...messages]
      next[optimisticIndex] = message
      return next
    }
  }

  const duplicate = messages.some((candidate) => {
    if (candidate.role !== message.role) return false
    if (candidate.role === 'toolResult' && message.role === 'toolResult') {
      return candidate.toolCallId === message.toolCallId
    }
    return candidate.timestamp === message.timestamp
  })
  return duplicate ? messages : [...messages, message]
}
