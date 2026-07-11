import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, TerminalSquare } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentMessage,
  AssistantMessage,
  PiUsage,
  ToolResultMessage,
} from '../../shared/contracts'
import { collapseAttachedContext } from '../../shared/attachment-context'
import type { LiveSegment, LiveToolSegment, LiveTurn } from '../ui-types'
import { Markdown } from './Markdown'

interface TranscriptProps {
  messages: AgentMessage[]
  live?: LiveTurn
  theme: 'light' | 'dark'
  running: boolean
}

function formatCompactNumber(value: number | undefined): string | undefined {
  if (value == null) return undefined
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : value.toLocaleString()
}

function UsageLine({ usage }: { usage?: PiUsage }): React.JSX.Element | null {
  if (!usage) return null
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  const cost = usage.cost?.total
  const parts = [
    `${formatCompactNumber(total)} tokens`,
    `${formatCompactNumber(usage.input)} in`,
    `${formatCompactNumber(usage.output)} out`,
  ]
  if (cost != null) parts.push(`$${cost.toFixed(cost < 0.01 ? 4 : 2)}`)
  return <div className="usage-line">{parts.join(' · ')}</div>
}

function Disclosure({
  title,
  children,
  subtle = false,
}: {
  title: string
  children: React.ReactNode
  subtle?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`disclosure ${subtle ? 'disclosure-subtle' : ''} ${open ? 'is-open' : ''}`}>
      <button className="disclosure-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ChevronRight size={13} aria-hidden="true" />
        <span>{title}</span>
      </button>
      {open && <div className="disclosure-content">{children}</div>}
    </div>
  )
}

function summarizeArguments(args: Record<string, unknown> | undefined, raw = ''): string {
  if (!args) return raw.trim().slice(0, 90)
  const preferred = ['command', 'path', 'file', 'query', 'pattern', 'url']
  for (const key of preferred) {
    const value = args[key]
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 100)
  }
  const keys = Object.keys(args)
  return keys.length ? keys.slice(0, 4).join(', ') : 'No arguments'
}

interface ToolCardProps {
  name: string
  args?: Record<string, unknown>
  rawArgs?: string
  output?: string
  isError?: boolean
  complete?: boolean
}

function ToolCard({ name, args, rawArgs = '', output = '', isError, complete = true }: ToolCardProps): React.JSX.Element {
  const [open, setOpen] = useState(Boolean(isError))
  const [expandedOutput, setExpandedOutput] = useState(false)
  return (
    <section className={`tool-card ${isError ? 'tool-card-error' : ''} ${!complete ? 'is-running' : ''}`}>
      <button className="tool-card-header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-icon"><TerminalSquare size={13} aria-hidden="true" /></span>
        <span className="tool-name">{name || 'Tool call'}</span>
        <span className="tool-summary">{summarizeArguments(args, rawArgs)}</span>
        {!complete && <span className="mini-spinner" aria-label="Running" />}
        <ChevronRight className="tool-chevron" size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="tool-card-body">
          {(args || rawArgs) && (
            <div className="tool-section">
              <div className="tool-section-label">Arguments</div>
              <pre>{args ? JSON.stringify(args, null, 2) : rawArgs}</pre>
            </div>
          )}
          {output && (
            <div className="tool-section">
              <div className="tool-section-label">{isError ? 'Error output' : 'Output'}</div>
              <pre className={expandedOutput ? 'is-expanded' : ''}>{output}</pre>
              {output.split('\n').length > 12 && (
                <button className="inline-action" onClick={() => setExpandedOutput((value) => !value)}>
                  {expandedOutput ? 'Collapse output' : 'Expand output'}
                </button>
              )}
            </div>
          )}
          {!output && complete && <div className="tool-empty-output">No output</div>}
        </div>
      )}
    </section>
  )
}

function assistantContent(
  message: AssistantMessage,
  results: Map<string, ToolResultMessage>,
  theme: 'light' | 'dark',
): React.ReactNode {
  return message.content.map((content, index) => {
    if (content.type === 'text') return <Markdown key={index} theme={theme}>{content.text}</Markdown>
    if (content.type === 'thinking') {
      return (
        <Disclosure key={index} title="Thinking" subtle>
          <Markdown theme={theme}>{content.thinking}</Markdown>
        </Disclosure>
      )
    }
    const result = results.get(content.id)
    return (
      <ToolCard
        key={content.id}
        name={content.name}
        args={content.arguments}
        output={result?.content.map((item) => item.text).join('\n')}
        isError={result?.isError}
      />
    )
  })
}

function renderUserContent(message: Extract<AgentMessage, { role: 'user' }>): string {
  if (typeof message.content === 'string') return collapseAttachedContext(message.content)
  return message.content
    .map((content) => content.type === 'text' ? collapseAttachedContext(content.text) : `[${content.mimeType ?? 'image'}]`)
    .join('\n')
}

function renderCustomContent(message: Extract<AgentMessage, { role: 'custom' }>): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((content) => content.type === 'text' ? content.text : `[${content.mimeType ?? 'image'}]`)
    .join('\n')
}

function MessageRow({
  message,
  results,
  theme,
}: {
  message: AgentMessage
  results: Map<string, ToolResultMessage>
  theme: 'light' | 'dark'
}): React.JSX.Element | null {
  if (message.role === 'user') {
    return (
      <article className="message message-user">
        <div className="message-label">You</div>
        <div className="user-bubble">{renderUserContent(message)}</div>
      </article>
    )
  }
  if (message.role === 'assistant') {
    return (
      <article className="message message-assistant">
        <div className="message-label">Pi</div>
        <div className="assistant-content">{assistantContent(message, results, theme)}</div>
        {message.errorMessage && <div className="assistant-error" role="alert">{message.errorMessage}</div>}
        <UsageLine usage={message.usage} />
      </article>
    )
  }
  if (message.role === 'custom') {
    if (!message.display) return null
    return (
      <article className="message message-assistant message-custom">
        <div className="message-label">{message.customType || 'Extension'}</div>
        <div className="assistant-content"><Markdown theme={theme}>{renderCustomContent(message)}</Markdown></div>
      </article>
    )
  }
  if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
    const title = message.role === 'branchSummary' ? 'Branch context' : 'Compacted context'
    return (
      <article className="message message-assistant message-summary">
        <Disclosure title={title} subtle>
          <Markdown theme={theme}>{message.summary}</Markdown>
        </Disclosure>
      </article>
    )
  }
  if (message.role === 'bashExecution') {
    return (
      <article className="message message-tool-result">
        <ToolCard
          name="bash"
          args={{ command: message.command }}
          output={message.output}
          isError={message.exitCode != null && message.exitCode !== 0}
          complete={!message.cancelled}
        />
      </article>
    )
  }
  return (
    <article className="message message-tool-result">
      <ToolCard
        name={message.toolName}
        output={message.content.map((item) => item.text).join('\n')}
        isError={message.isError}
      />
    </article>
  )
}

function LiveSegmentView({ segment, theme }: { segment: LiveSegment; theme: 'light' | 'dark' }): React.JSX.Element {
  if (segment.type === 'text') return <Markdown theme={theme}>{segment.text}</Markdown>
  if (segment.type === 'thinking') {
    return (
      <Disclosure title="Thinking" subtle>
        <Markdown theme={theme}>{segment.text}</Markdown>
      </Disclosure>
    )
  }
  const tool = segment as LiveToolSegment
  return (
    <ToolCard
      name={tool.name}
      args={tool.args}
      rawArgs={tool.argsText}
      output={tool.output}
      isError={tool.isError}
      complete={tool.complete}
    />
  )
}

function LiveMessage({ live, theme, running }: { live: LiveTurn; theme: 'light' | 'dark'; running: boolean }): React.JSX.Element {
  const segments = Object.entries(live.segments).sort(([a], [b]) => Number(a) - Number(b))
  return (
    <article className="message message-assistant live-message">
      <div className="message-label">Pi</div>
      <div className="assistant-content">
        {segments.map(([index, segment]) => <LiveSegmentView key={index} segment={segment} theme={theme} />)}
        {running && <span className="stream-caret" aria-label="Pi is responding" />}
      </div>
      {live.stats && (
        <div className="usage-line">
          {formatCompactNumber(live.stats.tokens.total)} tokens · ${live.stats.cost.toFixed(4)}
        </div>
      )}
    </article>
  )
}

export function Transcript({ messages, live, theme, running }: TranscriptProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const isPinnedRef = useRef(true)
  const results = useMemo(() => {
    const map = new Map<string, ToolResultMessage>()
    messages.forEach((message) => {
      if (message.role === 'toolResult') map.set(message.toolCallId, message)
    })
    return map
  }, [messages])
  const groupedToolCallIds = useMemo(() => {
    const ids = new Set<string>()
    messages.forEach((message) => {
      if (message.role !== 'assistant') return
      message.content.forEach((content) => {
        if (content.type === 'toolCall') ids.add(content.id)
      })
    })
    return ids
  }, [messages])
  const rows = useMemo(
    () => messages.filter((message) => message.role !== 'toolResult' || !groupedToolCallIds.has(message.toolCallId)),
    [groupedToolCallIds, messages],
  )
  const count = rows.length + (live ? 1 : 0)
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.role === 'user' ? 88 : 150,
    overscan: 6,
    measureElement: (element) => element.getBoundingClientRect().height,
  })

  const liveSignature = live
    ? Object.values(live.segments).map((segment) => segment.type === 'tool' ? segment.output.length + segment.argsText.length : segment.text.length).join(':')
    : ''

  useEffect(() => {
    if (!isPinnedRef.current || count === 0) return
    const frame = window.requestAnimationFrame(() => virtualizer.scrollToIndex(count - 1, { align: 'end' }))
    return () => window.cancelAnimationFrame(frame)
  }, [count, liveSignature, virtualizer])

  if (count === 0) {
    return (
      <div className="transcript-empty">
        <div className="pi-mark" aria-hidden="true">π</div>
        <h2>Ready when you are.</h2>
        <p>Describe a change, ask about the codebase, or hand Pi a problem to investigate.</p>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="transcript-scroll"
      onScroll={(event) => {
        const element = event.currentTarget
        isPinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 180
      }}
    >
      <div className="transcript-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const isLive = virtualRow.index >= rows.length
          return (
            <div
              key={isLive ? 'live' : `${rows[virtualRow.index].role}-${rows[virtualRow.index].timestamp}-${virtualRow.index}`}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="virtual-row"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {isLive && live
                ? <LiveMessage live={live} theme={theme} running={running} />
                : <MessageRow message={rows[virtualRow.index]} results={results} theme={theme} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
