import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentMessage, AssistantMessage, ExportFormat, ThreadRecord } from '../shared/contracts'
import { aggregateMessageUsage, type UsageAggregate } from './thread-library'

export type ThreadExportFormat = ExportFormat

export interface ThreadRenderOptions {
  thread: ThreadRecord
  messages: readonly AgentMessage[]
  projectName?: string
  includeThinking?: boolean
  includeTools?: boolean
  exportedAt?: Date
}

export interface ThreadExportOptions extends ThreadRenderOptions {
  outputPath: string
  format: ThreadExportFormat
}

export interface ThreadExportResult {
  path: string
  bytes: number
  format: ThreadExportFormat
  usage: UsageAggregate
}

interface RenderContext {
  includeThinking: boolean
  includeTools: boolean
}

function humanTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'Unknown time'
  return new Date(timestamp).toISOString()
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((item) => {
    if (typeof item !== 'object' || item === null) return ''
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') return record.text
    if (record.type === 'image') return `[Image: ${typeof record.mimeType === 'string' ? record.mimeType : 'image'}]`
    return ''
  }).filter(Boolean).join('\n')
}

function longestBacktickRun(value: string): number {
  let longest = 0
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

function fenced(value: string, language = ''): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(value) + 1))
  return `${fence}${language}\n${value}\n${fence}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function usageLine(message: AssistantMessage): string | undefined {
  if (!message.usage) return undefined
  const usage = message.usage
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  const cost = usage.cost?.total
  return `Usage: ${total.toLocaleString('en-US')} tokens (${usage.input.toLocaleString('en-US')} input, ${usage.output.toLocaleString('en-US')} output)${typeof cost === 'number' ? ` · $${cost.toFixed(4)}` : ''}`
}

function markdownMessage(message: AgentMessage, context: RenderContext): string {
  const timestamp = humanTimestamp(message.timestamp)
  switch (message.role) {
    case 'user':
      return `## You\n\n_${timestamp}_\n\n${messageContentText(message.content) || '_No text content_'}\n`
    case 'assistant': {
      const heading = `## Pi${message.model ? ` · ${message.model}` : ''}`
      const sections: string[] = [`${heading}\n\n_${timestamp}_`]
      for (const content of message.content) {
        if (content.type === 'text') sections.push(content.text)
        else if (content.type === 'thinking' && context.includeThinking) {
          sections.push(`<details>\n<summary>Thinking</summary>\n\n${content.thinking}\n\n</details>`)
        } else if (content.type === 'toolCall' && context.includeTools) {
          sections.push(`<details>\n<summary>Tool call: ${content.name}</summary>\n\n${fenced(safeJson(content.arguments), 'json')}\n\n</details>`)
        }
      }
      const usage = usageLine(message)
      if (usage) sections.push(`_${usage}_`)
      if (message.errorMessage) sections.push(`**Error:** ${message.errorMessage}`)
      return `${sections.join('\n\n')}\n`
    }
    case 'toolResult':
      if (!context.includeTools) return ''
      return `### Tool result: ${message.toolName}${message.isError ? ' (error)' : ''}\n\n_${timestamp}_\n\n${fenced(message.content.map((item) => item.text).join('\n'), 'text')}\n`
    case 'bashExecution':
      if (!context.includeTools) return ''
      return `### Shell command${message.exitCode == null ? '' : ` · exit ${message.exitCode}`}\n\n_${timestamp}_\n\n${fenced(message.command, 'shell')}\n\n${fenced(message.output, 'text')}\n`
    case 'custom':
      if (!message.display) return ''
      return `### ${message.customType || 'Extension'}\n\n_${timestamp}_\n\n${messageContentText(message.content)}\n`
    case 'branchSummary':
      return `<details>\n<summary>Branch context · ${timestamp}</summary>\n\n${message.summary}\n\n</details>\n`
    case 'compactionSummary':
      return `<details>\n<summary>Compacted context · ${timestamp}</summary>\n\n${message.summary}\n\n</details>\n`
    default:
      return ''
  }
}

function markdownHeader(options: ThreadRenderOptions, usage: UsageAggregate): string {
  const exportedAt = (options.exportedAt ?? new Date()).toISOString()
  const lines = [
    `# ${options.thread.title}`,
    '',
    `- Exported: ${exportedAt}`,
    `- Working directory: \`${options.thread.cwd.replaceAll('`', '\\`')}\``,
    ...(options.projectName ? [`- Project: ${options.projectName}`] : []),
    `- Turns with usage: ${usage.turns}`,
    `- Total tokens: ${usage.tokens.total.toLocaleString('en-US')}`,
    `- Total reported cost: $${usage.cost.toFixed(4)}`,
    '',
    '---',
    ''
  ]
  return lines.join('\n')
}

export function renderThreadMarkdown(options: ThreadRenderOptions): string {
  const usage = aggregateMessageUsage(options.messages)
  const context: RenderContext = {
    includeThinking: options.includeThinking === true,
    includeTools: options.includeTools !== false
  }
  const body = options.messages.map((message) => markdownMessage(message, context)).filter(Boolean).join('\n---\n\n')
  return `${markdownHeader(options, usage)}${body}${body ? '\n' : ''}`
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function htmlText(value: string): string {
  return `<pre class="content">${escapeHtml(value)}</pre>`
}

function htmlDetails(summary: string, body: string, className = ''): string {
  return `<details${className ? ` class="${className}"` : ''}><summary>${escapeHtml(summary)}</summary>${body}</details>`
}

function htmlMessage(message: AgentMessage, context: RenderContext): string {
  const timestamp = escapeHtml(humanTimestamp(message.timestamp))
  switch (message.role) {
    case 'user':
      return `<section class="message user"><header><h2>You</h2><time>${timestamp}</time></header>${htmlText(messageContentText(message.content) || 'No text content')}</section>`
    case 'assistant': {
      const blocks: string[] = []
      for (const content of message.content) {
        if (content.type === 'text') blocks.push(htmlText(content.text))
        else if (content.type === 'thinking' && context.includeThinking) {
          blocks.push(htmlDetails('Thinking', htmlText(content.thinking), 'thinking'))
        } else if (content.type === 'toolCall' && context.includeTools) {
          blocks.push(htmlDetails(`Tool call: ${content.name}`, htmlText(safeJson(content.arguments)), 'tool'))
        }
      }
      const usage = usageLine(message)
      const footer = [
        usage ? `<div class="usage">${escapeHtml(usage)}</div>` : '',
        message.errorMessage ? `<div class="error">${escapeHtml(message.errorMessage)}</div>` : ''
      ].join('')
      return `<section class="message assistant"><header><h2>Pi${message.model ? ` · ${escapeHtml(message.model)}` : ''}</h2><time>${timestamp}</time></header>${blocks.join('')}${footer}</section>`
    }
    case 'toolResult':
      if (!context.includeTools) return ''
      return `<section class="message tool-result${message.isError ? ' error-result' : ''}"><header><h2>Tool result · ${escapeHtml(message.toolName)}</h2><time>${timestamp}</time></header>${htmlText(message.content.map((item) => item.text).join('\n'))}</section>`
    case 'bashExecution':
      if (!context.includeTools) return ''
      return `<section class="message tool-result"><header><h2>Shell command${message.exitCode == null ? '' : ` · exit ${message.exitCode}`}</h2><time>${timestamp}</time></header>${htmlDetails('Command', htmlText(message.command), 'tool')}${htmlText(message.output)}</section>`
    case 'custom':
      if (!message.display) return ''
      return `<section class="message custom"><header><h2>${escapeHtml(message.customType || 'Extension')}</h2><time>${timestamp}</time></header>${htmlText(messageContentText(message.content))}</section>`
    case 'branchSummary':
      return `<section class="message summary">${htmlDetails(`Branch context · ${humanTimestamp(message.timestamp)}`, htmlText(message.summary))}</section>`
    case 'compactionSummary':
      return `<section class="message summary">${htmlDetails(`Compacted context · ${humanTimestamp(message.timestamp)}`, htmlText(message.summary))}</section>`
    default:
      return ''
  }
}

export function renderThreadHtml(options: ThreadRenderOptions): string {
  const usage = aggregateMessageUsage(options.messages)
  const context: RenderContext = {
    includeThinking: options.includeThinking === true,
    includeTools: options.includeTools !== false
  }
  const messages = options.messages.map((message) => htmlMessage(message, context)).filter(Boolean).join('\n')
  const title = escapeHtml(options.thread.title)
  const project = options.projectName ? `<span>${escapeHtml(options.projectName)}</span>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · CodePi export</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbfc;--surface:#fff;--muted:#6e6e73;--text:#1d1d1f;--border:rgba(0,0,0,.12);--tool:#f4f4f5;--accent:#0a6ee8;--error:#c93129} @media(prefers-color-scheme:dark){:root{--bg:#1d1d1f;--surface:#262628;--muted:#a1a1a6;--text:#f5f5f7;--border:rgba(255,255,255,.13);--tool:#2c2c2e;--accent:#58a9ff;--error:#ff6961}} *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif} main{width:min(860px,calc(100% - 40px));margin:42px auto 80px} .document-header{padding-bottom:24px;border-bottom:1px solid var(--border)} h1{margin:0;font-size:28px;letter-spacing:-.025em} .meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;color:var(--muted);font-size:12px} .message{padding:24px 0;border-bottom:1px solid var(--border)} header{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:10px} h2{margin:0;font-size:13px} time{color:var(--muted);font-size:11px} .content{margin:0 0 12px;padding:0;overflow:auto;background:transparent;color:inherit;font:13px/1.6 "SF Mono",ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word} details{margin:10px 0;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--tool)} summary{color:var(--muted);cursor:pointer;font-size:12px} details .content{margin:9px 0 0;font-size:12px} .user{margin-left:auto;width:min(82%,680px);padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--surface)} .assistant+.assistant{padding-top:12px} .tool-result{padding:15px;margin:14px 0;border:1px solid var(--border);border-radius:8px;background:var(--tool)} .usage{margin-top:10px;color:var(--muted);font-size:11px}.error,.error-result h2{color:var(--error)} .summary{border-bottom:0;padding:8px 0}
</style>
</head>
<body>
<main>
<section class="document-header"><h1>${title}</h1><div class="meta">${project}<span>${escapeHtml(options.thread.cwd)}</span><span>${usage.tokens.total.toLocaleString('en-US')} tokens</span><span>$${usage.cost.toFixed(4)}</span><span>Exported ${escapeHtml((options.exportedAt ?? new Date()).toISOString())}</span></div></section>
${messages}
</main>
</body>
</html>
`
}

export async function exportThreadToPath(options: ThreadExportOptions): Promise<ThreadExportResult> {
  if (typeof options.outputPath !== 'string' || options.outputPath.includes('\0') || !options.outputPath.trim()) {
    throw new TypeError('Export path is invalid')
  }
  if (options.format !== 'markdown' && options.format !== 'html') throw new TypeError('Export format is invalid')
  const outputPath = resolve(options.outputPath)
  const content = options.format === 'markdown'
    ? renderThreadMarkdown(options)
    : renderThreadHtml(options)
  await writeFile(outputPath, content, { encoding: 'utf8', mode: 0o600 })
  return {
    path: outputPath,
    bytes: Buffer.byteLength(content, 'utf8'),
    format: options.format,
    usage: aggregateMessageUsage(options.messages)
  }
}
