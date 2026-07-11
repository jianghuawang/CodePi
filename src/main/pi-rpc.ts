import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import { collapseAttachedContext } from '../shared/attachment-context'
import type {
  AgentMessage,
  AssistantMessage,
  PiCommand,
  PiModel,
  SessionEntry,
  SessionState,
  SessionTreeNode,
  ToolResultMessage
} from '../shared/contracts'
import type {
  PiAbortedEvent,
  PiAgentSettledEvent,
  PiAssistantMessageEvent,
  PiExtensionUiRequest,
  PiImageContent,
  PiProcessCrashEvent,
  PiRpcClientEventMap,
  PiRpcCommand,
  PiRpcErrorEvent,
  PiRpcEvent,
  PiRpcResponse,
  PiRpcSessionState,
  PiRpcSessionStats,
  PiSessionTree,
  PiStreamingBehavior,
  PiThinkingLevel,
  PiToolCall
} from '../shared/pi-rpc-types'

export interface PiRpcClientOptions {
  piPath?: string
  cwd: string
  env?: Record<string, string | undefined>
  session?: string
  sessionDir?: string
  model?: string
  requestTimeoutMs?: number
  extraArgs?: readonly string[]
}

type JsonlChunk = string | Uint8Array

const MAX_STDERR_CHARACTERS = 256 * 1024
const MAX_TOOL_OUTPUT_CHARACTERS = 512 * 1024
const MAX_JSONL_RECORD_CHARACTERS = 64 * 1024 * 1024
const COMPACTION_TIMEOUT_MS = 10 * 60_000

/** Serialize one strict LF-delimited JSONL record. */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/**
 * Stateful, stream-independent strict JSONL decoder.
 *
 * It deliberately recognizes only LF as a record boundary. StringDecoder keeps
 * split UTF-8 code points intact, and a CR immediately before LF is accepted.
 */
export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private ended = false

  constructor(private readonly maxRecordCharacters = MAX_JSONL_RECORD_CHARACTERS) {}

  push(chunk: JsonlChunk): string[] {
    if (this.ended) {
      throw new Error('Cannot push data after the JSONL decoder has ended')
    }

    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk))
    const lines = this.drainCompleteLines()
    this.assertRecordBound()
    return lines
  }

  end(chunk?: JsonlChunk): string[] {
    if (this.ended) return []
    this.ended = true

    if (typeof chunk === 'string') {
      this.buffer += this.decoder.end()
      this.buffer += chunk
    } else {
      this.buffer += this.decoder.end(chunk === undefined ? undefined : Buffer.from(chunk))
    }

    const lines = this.drainCompleteLines()
    if (this.buffer.length > 0) {
      this.assertRecordBound()
      lines.push(stripTrailingCarriageReturn(this.buffer))
      this.buffer = ''
    }
    return lines
  }

  private drainCompleteLines(): string[] {
    const lines: string[] = []
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex === -1) return lines
      if (newlineIndex > this.maxRecordCharacters) {
        throw new Error('Pi RPC JSONL record exceeded its safety limit')
      }

      lines.push(stripTrailingCarriageReturn(this.buffer.slice(0, newlineIndex)))
      this.buffer = this.buffer.slice(newlineIndex + 1)
    }
  }

  private assertRecordBound(): void {
    if (this.buffer.length > this.maxRecordCharacters) {
      throw new Error('Pi RPC JSONL record exceeded its safety limit')
    }
  }
}

/** Pure convenience helper used by tests and file-backed session parsing. */
export function decodeJsonlChunks(chunks: readonly JsonlChunk[]): string[] {
  const decoder = new StrictJsonlDecoder()
  const lines: string[] = []
  for (const chunk of chunks) lines.push(...decoder.push(chunk))
  lines.push(...decoder.end())
  return lines
}

/** Attach a strict LF-only JSONL decoder to a Node readable stream. */
export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void,
  onDecodeError?: (error: Error) => void
): () => void {
  const decoder = new StrictJsonlDecoder()
  let failed = false
  const fail = (reason: unknown): void => {
    if (failed) return
    failed = true
    const error = reason instanceof Error ? reason : new Error(String(reason))
    stream.off('data', onData)
    stream.off('end', onEnd)
    if (onDecodeError) onDecodeError(error)
    else stream.destroy(error)
  }
  const onData = (chunk: JsonlChunk): void => {
    try {
      for (const line of decoder.push(chunk)) onLine(line)
    } catch (error) {
      fail(error)
    }
  }
  const onEnd = (): void => {
    try {
      for (const line of decoder.end()) onLine(line)
    } catch (error) {
      fail(error)
    }
  }

  stream.on('data', onData)
  stream.on('end', onEnd)
  return () => {
    failed = true
    stream.off('data', onData)
    stream.off('end', onEnd)
  }
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export class PiRpcCommandError extends Error {
  readonly command: string

  constructor(command: string, message: string) {
    super(message)
    this.name = 'PiRpcCommandError'
    this.command = command
  }
}

export class PiRpcProcessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiRpcProcessError'
  }
}

interface PendingRequest {
  command: string
  resolve(value: unknown): void
  reject(reason: Error): void
  timer?: ReturnType<typeof setTimeout>
}

interface ActiveToolExecution {
  toolName: string
  args: Record<string, unknown>
  output: string
}

/** One PiRpcClient owns exactly one `pi --mode rpc` subprocess/session. */
export class PiRpcClient extends EventEmitter<PiRpcClientEventMap> {
  private readonly options: PiRpcClientOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private detachStdoutReader: (() => void) | null = null
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly activeTools = new Map<string, ActiveToolExecution>()
  private requestSequence = 0
  private stderrBuffer = ''
  private stopping = false
  private runGeneration = 0
  private abortEmittedGeneration = -1
  private settledEmittedGeneration = -1
  private agentEndMessages: AgentMessage[] = []
  private settledFallback: ReturnType<typeof setTimeout> | null = null
  private pendingAgentEnd = false
  private retryInProgress = false
  private compactionInProgress = false

  constructor(options: PiRpcClientOptions) {
    super()
    this.options = { ...options }

    // EventEmitter treats an unhandled `error` event as an exception. The
    // default listener guarantees malformed output or a child crash can never
    // take down Electron's main process; consumers can still add listeners.
    this.on('error', () => undefined)
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get stderr(): string {
    return this.stderrBuffer
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    this.stopping = false
    this.stderrBuffer = ''
    this.activeTools.clear()
    this.clearSettledFallback()
    this.pendingAgentEnd = false
    this.retryInProgress = false
    this.compactionInProgress = false

    const child = spawn(this.options.piPath ?? 'pi', this.buildArguments(), {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.detachStdoutReader = attachJsonlLineReader(
      child.stdout,
      (line) => this.handleLine(line),
      (error) => {
        this.emitError({
          message: `Pi RPC framing failed: ${error.message}`,
          recoverable: true,
          source: 'framing',
          cause: error
        })
        terminateChild(child, false)
      }
    )

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = keepTextTail(this.stderrBuffer + chunk, MAX_STDERR_CHARACTERS)
      this.emit('stderr', keepTextTail(chunk, MAX_STDERR_CHARACTERS))
    })

    child.stdin.on('error', (error) => this.handleStreamError('stdin', error))
    child.stdout.on('error', (error) => this.handleStreamError('stdout', error))
    child.stderr.on('error', (error) => this.handleStreamError('stderr', error))

    await new Promise<void>((resolve, reject) => {
      let spawned = false

      child.once('spawn', () => {
        spawned = true
        resolve()
      })
      child.once('error', (error) => {
        if (!spawned) reject(error)
        this.emitError({
          message: `Unable to start Pi: ${error.message}`,
          recoverable: true,
          source: 'process',
          cause: error
        })
      })
      child.once('close', (code, signal) => this.handleClose(child, code, signal))
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return

    this.stopping = true
    this.clearSettledFallback()
    this.rejectPending(new PiRpcProcessError('Pi RPC client stopped'))

    if (child.exitCode !== null || child.killed) {
      if (this.child === child) this.child = null
      this.detachReader()
      return
    }

    await new Promise<void>((resolve) => {
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        clearTimeout(forceKillTimer)
        resolve()
      }
      const forceKillTimer = setTimeout(() => {
        terminateChild(child, true)
        finish()
      }, 1_500)

      child.once('close', finish)
      terminateChild(child, false)
    })

    if (this.child === child) this.child = null
    this.detachReader()
  }

  async request<T = void>(command: PiRpcCommand, timeoutMs = this.options.requestTimeoutMs): Promise<T> {
    const child = this.child
    if (!child || !this.isRunning || !child.stdin.writable) {
      throw new PiRpcProcessError('Pi RPC process is not running')
    }

    const id = command.id ?? `codepi-${++this.requestSequence}`
    if (this.pendingRequests.has(id)) {
      throw new PiRpcCommandError(command.type, `Duplicate RPC request id: ${id}`)
    }

    const response = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { command: command.type, resolve, reject }
      if (timeoutMs && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pendingRequests.delete(id)) {
            reject(new PiRpcCommandError(command.type, `Pi RPC request timed out: ${command.type}`))
          }
        }, timeoutMs)
      }
      this.pendingRequests.set(id, pending)
    })

    const failWrite = (error: Error): void => {
      const pending = this.pendingRequests.get(id)
      if (!pending) return
      this.pendingRequests.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new PiRpcProcessError(`Failed to write Pi RPC command: ${error.message}`))
    }

    const payload = { ...command, id }
    try {
      child.stdin.write(serializeJsonLine(payload), 'utf8', (error) => {
        if (error) failWrite(error)
      })
    } catch (error) {
      failWrite(error instanceof Error ? error : new Error(String(error)))
    }

    return (await response) as T
  }

  async prompt(
    message: string,
    images?: PiImageContent[],
    streamingBehavior?: PiStreamingBehavior
  ): Promise<void> {
    await this.request({ type: 'prompt', message, images, streamingBehavior })
  }

  async steer(message: string, images?: PiImageContent[]): Promise<void> {
    await this.request({ type: 'steer', message, images })
  }

  async followUp(message: string, images?: PiImageContent[]): Promise<void> {
    await this.request({ type: 'follow_up', message, images })
  }

  async abort(): Promise<void> {
    await this.request({ type: 'abort' })
    this.emitAborted({ source: 'command' })
  }

  async getState(): Promise<SessionState> {
    const state = await this.request<PiRpcSessionState>({ type: 'get_state' })
    return { ...state, model: state.model ?? null }
  }

  async getMessages(): Promise<AgentMessage[]> {
    const data = await this.request<{ messages: AgentMessage[] }>({ type: 'get_messages' })
    return data.messages.map(limitAgentMessage)
  }

  async getAvailableModels(): Promise<PiModel[]> {
    const data = await this.request<{ models: PiModel[] }>({ type: 'get_available_models' })
    return data.models
  }

  async getCommands(): Promise<PiCommand[]> {
    const data = await this.request<{ commands: PiCommand[] }>({ type: 'get_commands' })
    return Array.isArray(data.commands) ? data.commands : []
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    return this.request<PiModel>({ type: 'set_model', provider, modelId })
  }

  async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
    await this.request({ type: 'set_thinking_level', level })
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.request(
      { type: 'compact', ...(customInstructions ? { customInstructions } : {}) },
      COMPACTION_TIMEOUT_MS
    )
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: 'set_auto_compaction', enabled })
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.request({ type: 'set_auto_retry', enabled })
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.request({ type: 'export_html', ...(outputPath ? { outputPath } : {}) })
  }

  async setSessionName(name: string): Promise<void> {
    await this.request({ type: 'set_session_name', name })
  }

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return this.request({ type: 'fork', entryId })
  }

  async getSessionStats(): Promise<PiRpcSessionStats> {
    return this.request({ type: 'get_session_stats' })
  }

  async getTree(): Promise<PiSessionTree> {
    const state = await this.getState()
    if (!state.sessionFile) return { tree: [], leafId: null }

    try {
      const contents = await readFile(state.sessionFile)
      return { ...parseSessionTree(contents), sessionFile: state.sessionFile }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { tree: [], leafId: null, sessionFile: state.sessionFile }
      }
      throw error
    }
  }

  private buildArguments(): string[] {
    const args = ['--mode', 'rpc']
    if (this.options.session) args.push('--session', this.options.session)
    if (this.options.sessionDir) args.push('--session-dir', this.options.sessionDir)
    if (this.options.model) args.push('--model', this.options.model)
    if (this.options.extraArgs) args.push(...this.options.extraArgs)
    return args
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return

    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      this.emitError({
        message: `Pi emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
        source: 'framing',
        cause: error
      })
      return
    }

    if (!isObject(value) || typeof value.type !== 'string') {
      this.emitError({
        message: 'Pi emitted a JSONL record without a string type field',
        recoverable: true,
        source: 'framing',
        cause: value
      })
      return
    }

    if (value.type === 'response') {
      this.handleResponse(value as unknown as PiRpcResponse)
      return
    }

    const event = value as PiRpcEvent
    this.emit('raw-event', event)
    this.normalizeEvent(event)
  }

  private handleResponse(response: PiRpcResponse): void {
    if (!response.id) {
      this.emitError({
        message: `Received uncorrelated Pi RPC response for ${response.command}`,
        recoverable: true,
        source: 'command',
        cause: response
      })
      return
    }

    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      this.emitError({
        message: `Received Pi RPC response for unknown request id ${response.id}`,
        recoverable: true,
        source: 'command',
        cause: response
      })
      return
    }

    this.pendingRequests.delete(response.id)
    if (pending.timer) clearTimeout(pending.timer)

    if (!response.success) {
      pending.reject(new PiRpcCommandError(response.command, response.error))
      return
    }
    pending.resolve(response.data)
  }

  private normalizeEvent(event: PiRpcEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.runGeneration += 1
        this.agentEndMessages = []
        this.clearSettledFallback()
        this.pendingAgentEnd = false
        this.retryInProgress = false
        this.compactionInProgress = false
        this.emit('agent-start')
        return
      case 'agent_end':
        this.agentEndMessages = Array.isArray(event.messages) ? event.messages.map(limitAgentMessage) : []
        this.pendingAgentEnd = true
        this.scheduleSettledFallback()
        return
      case 'turn_start':
        this.emit('turn-start')
        return
      case 'turn_end':
        this.emit('turn-end', {
          message: limitAgentMessage(event.message) as AssistantMessage,
          toolResults: Array.isArray(event.toolResults)
            ? event.toolResults.map((message) => limitAgentMessage(message) as ToolResultMessage)
            : []
        })
        return
      case 'message_update':
        this.normalizeAssistantUpdate(event.assistantMessageEvent)
        return
      case 'message_end':
        this.emit('message-end', limitAgentMessage(event.message))
        return
      case 'tool_execution_start': {
        const args = asRecord(event.args)
        this.activeTools.set(event.toolCallId, { toolName: event.toolName, args, output: '' })
        this.emit('tool-execution-start', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args
        })
        return
      }
      case 'tool_execution_update': {
        const output = extractToolOutput(event.partialResult)
        const active = this.activeTools.get(event.toolCallId) ?? {
          toolName: event.toolName,
          args: asRecord(event.args),
          output: ''
        }
        active.output = output
        this.activeTools.set(event.toolCallId, active)
        this.emit('tool-output', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output,
          complete: false
        })
        return
      }
      case 'tool_execution_end': {
        const active = this.activeTools.get(event.toolCallId)
        const output = extractToolOutput(event.result) || active?.output || ''
        this.activeTools.delete(event.toolCallId)
        this.emit('tool-output', {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output,
          isError: Boolean(event.isError),
          complete: true
        })
        return
      }
      case 'queue_update':
        this.emit('queue', {
          steering: Array.isArray(event.steering) ? event.steering : [],
          followUp: Array.isArray(event.followUp) ? event.followUp : []
        })
        return
      case 'extension_error':
        this.emitError({
          message: event.error || 'A Pi extension failed',
          recoverable: true,
          source: 'extension',
          cause: event
        })
        return
      case 'extension_ui_request':
        this.handleExtensionUiRequest(event)
        return
      case 'auto_retry_start':
        this.retryInProgress = true
        this.clearSettledFallback()
        return
      case 'auto_retry_end':
        this.retryInProgress = false
        if (!event.success) {
          this.emitError({
            message: event.finalError || 'Pi exhausted its automatic retries',
            recoverable: true,
            source: 'agent',
            cause: event
          })
          this.scheduleSettledFallback()
        } else {
          // A successful retry produces a fresh agent_end; do not settle from
          // the failed attempt that originally started the retry.
          this.pendingAgentEnd = false
          this.clearSettledFallback()
        }
        return
      case 'compaction_start':
        this.compactionInProgress = true
        this.clearSettledFallback()
        return
      case 'compaction_end':
        this.compactionInProgress = false
        if (!event.aborted && event.errorMessage) {
          this.emitError({
            message: event.errorMessage,
            recoverable: true,
            source: 'agent',
            cause: event
          })
        }
        if (event.willRetry) {
          this.pendingAgentEnd = false
          this.clearSettledFallback()
        } else {
          this.scheduleSettledFallback()
        }
        return
      default:
        return
    }
  }

  private normalizeAssistantUpdate(update: PiAssistantMessageEvent): void {
    switch (update.type) {
      case 'text_delta':
        this.emit('text-delta', { delta: update.delta, contentIndex: update.contentIndex })
        return
      case 'thinking_delta':
        this.emit('thinking-delta', { delta: update.delta, contentIndex: update.contentIndex })
        return
      case 'toolcall_start': {
        const partial = getPartialToolCall(update)
        this.emit('tool-call-start', {
          contentIndex: update.contentIndex,
          toolCallId: partial?.id,
          toolName: partial?.name
        })
        return
      }
      case 'toolcall_delta': {
        const partial = getPartialToolCall(update)
        this.emit('tool-call-args', {
          contentIndex: update.contentIndex,
          delta: update.delta,
          toolCallId: partial?.id,
          toolName: partial?.name
        })
        return
      }
      case 'toolcall_end':
        this.emit('tool-call-end', {
          contentIndex: update.contentIndex,
          toolCallId: update.toolCall.id,
          toolName: update.toolCall.name,
          args: asRecord(update.toolCall.arguments)
        })
        return
      case 'error':
        if (update.reason === 'aborted') {
          this.emitAborted({ source: 'agent', message: update.error })
        } else {
          this.emitError({
            message: getAssistantError(update.error),
            recoverable: true,
            source: 'agent',
            cause: update.error
          })
        }
        return
      default:
        return
    }
  }

  private scheduleSettledFallback(): void {
    this.clearSettledFallback()
    if (!this.pendingAgentEnd || this.retryInProgress || this.compactionInProgress) return
    const generation = this.runGeneration
    this.settledFallback = setTimeout(() => {
      this.settledFallback = null
      if (
        generation !== this.runGeneration ||
        !this.pendingAgentEnd ||
        this.retryInProgress ||
        this.compactionInProgress
      ) return
      this.pendingAgentEnd = false
      this.emitSettled({ messages: this.agentEndMessages, source: 'agent_end' })
    }, 750)
  }

  private handleExtensionUiRequest(event: PiExtensionUiRequest): void {
    if (typeof event.id !== 'string' || typeof event.method !== 'string') {
      this.emitError({
        message: 'Pi emitted an invalid extension UI request',
        recoverable: true,
        source: 'framing',
        cause: event
      })
      return
    }
    const blockingMethods = new Set(['select', 'confirm', 'input', 'editor'])
    if (!blockingMethods.has(event.method)) return

    const child = this.child
    if (child && this.isRunning && child.stdin.writable) {
      child.stdin.write(
        serializeJsonLine({ type: 'extension_ui_response', id: event.id, cancelled: true }),
        'utf8',
        (error) => {
          if (!error) return
          this.emitError({
            message: `Failed to cancel Pi extension UI request: ${error.message}`,
            recoverable: true,
            source: 'extension',
            cause: error
          })
        }
      )
    }
    const label = event.title || event.message || event.method
    this.emitError({
        message: `Pi extension UI request cancelled because CodePi does not yet support “${label}”.`,
      recoverable: true,
      source: 'extension',
      cause: event
    })
  }

  private emitSettled(event: PiAgentSettledEvent): void {
    if (this.settledEmittedGeneration === this.runGeneration) return
    this.settledEmittedGeneration = this.runGeneration
    this.emit('agent-settled', event)
  }

  private emitAborted(event: PiAbortedEvent): void {
    if (this.abortEmittedGeneration === this.runGeneration) return
    this.abortEmittedGeneration = this.runGeneration
    this.emit('aborted', event)
  }

  private emitError(event: PiRpcErrorEvent): void {
    this.emit('error', event)
  }

  private handleStreamError(stream: string, error: Error): void {
    if (this.stopping) return
    this.emitError({
      message: `Pi RPC ${stream} stream failed: ${error.message}`,
      recoverable: true,
      source: 'process',
      cause: error
    })
  }

  private handleClose(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.child !== child) return

    this.child = null
    this.detachReader()
    this.clearSettledFallback()
    this.activeTools.clear()
    this.pendingAgentEnd = false
    this.retryInProgress = false
    this.compactionInProgress = false

    const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
    this.rejectPending(new PiRpcProcessError(`Pi RPC process exited with ${detail}`))

    if (!this.stopping) {
      const crash: PiProcessCrashEvent = { code, signal, stderr: this.stderrBuffer }
      this.emit('process-crash', crash)
      this.emitError({
        message: `Pi stopped unexpectedly (${detail})`,
        recoverable: true,
        source: 'process',
        cause: crash
      })
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private clearSettledFallback(): void {
    if (!this.settledFallback) return
    clearTimeout(this.settledFallback)
    this.settledFallback = null
  }

  private detachReader(): void {
    this.detachStdoutReader?.()
    this.detachStdoutReader = null
  }
}

/** Parse Pi's append-only session JSONL into its id/parentId tree. */
export function parseSessionTree(contents: Uint8Array | string): Omit<PiSessionTree, 'sessionFile'> {
  const lines = decodeJsonlChunks([contents])
  const entries: SessionEntry[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue

    try {
      const value: unknown = JSON.parse(line)
      if (isSessionEntry(value)) {
        entries.push(value.message ? { ...value, message: limitAgentMessage(value.message) } : value)
      }
    } catch (error) {
      // A concurrent session append can leave only the final snapshot record
      // incomplete. Earlier corruption is surfaced instead of silently hidden.
      if (index !== lines.length - 1) throw error
    }
  }

  const labels = new Map<string, { label?: string; timestamp?: string }>()
  for (const entry of entries) {
    if (entry.type !== 'label') continue
    const targetId = typeof entry.targetId === 'string' ? entry.targetId : undefined
    if (!targetId) continue
    labels.set(targetId, {
      label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : undefined,
      timestamp: entry.timestamp
    })
  }

  const nodes = new Map<string, SessionTreeNode>()
  for (const entry of entries) {
    const label = labels.get(entry.id)
    nodes.set(entry.id, {
      entry,
      children: [],
      label: label?.label,
      labelTimestamp: label?.timestamp
    })
  }

  const roots: SessionTreeNode[] = []
  for (const entry of entries) {
    const node = nodes.get(entry.id)
    if (!node) continue
    const parent = entry.parentId ? nodes.get(entry.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }

  sortSessionNodes(roots)
  return { tree: roots, leafId: entries.at(-1)?.id ?? null }
}

function sortSessionNodes(nodes: SessionTreeNode[]): void {
  nodes.sort((left, right) => {
    const leftTime = left.entry.timestamp ?? ''
    const rightTime = right.entry.timestamp ?? ''
    return leftTime.localeCompare(rightTime)
  })
  for (const node of nodes) sortSessionNodes(node.children)
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return (
    isObject(value) &&
    value.type !== 'session' &&
    typeof value.type === 'string' &&
    typeof value.id === 'string' &&
    (typeof value.parentId === 'string' || value.parentId === null)
  )
}

function getPartialToolCall(
  update: Extract<PiAssistantMessageEvent, { type: 'toolcall_start' | 'toolcall_delta' }>
): Partial<PiToolCall> | undefined {
  const content = update.partial?.content
  if (!Array.isArray(content)) return undefined
  const block = content[update.contentIndex]
  return block?.type === 'toolCall' ? block : undefined
}

function extractToolOutput(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.content)) return ''
  const output = result.content
    .map((part) => {
      if (typeof part === 'string') return part
      if (isObject(part) && part.type === 'text' && typeof part.text === 'string') return part.text
      return ''
    })
    .join('')
  return truncateDisplayText(output)
}

function truncateDisplayText(value: string, maximum = MAX_TOOL_OUTPUT_CHARACTERS): string {
  if (value.length <= maximum) return value
  const tailLength = Math.floor(maximum / 4)
  const headLength = maximum - tailLength
  return `${value.slice(0, headLength)}\n\n[CodePi truncated ${value.length - maximum} characters]\n\n${value.slice(-tailLength)}`
}

function limitUserText(value: string): string {
  return truncateDisplayText(collapseAttachedContext(value), 2 * 1024 * 1024)
}

/** Keep the renderer payload bounded without modifying Pi's session on disk. */
function limitAgentMessage(message: AgentMessage): AgentMessage {
  // Events arrive as unvalidated JSON from the Pi subprocess; a missing or
  // unrecognized message must pass through rather than throw mid-stream.
  if (!isObject(message)) return message
  switch (message.role) {
    case 'user':
      return {
        ...message,
        content: typeof message.content === 'string'
          ? limitUserText(message.content)
          : message.content.map((part) => part.type === 'text'
            ? { ...part, text: limitUserText(part.text) }
            : { type: 'image' as const, ...(part.mimeType ? { mimeType: part.mimeType } : {}) })
      }
    case 'assistant':
      return {
        ...message,
        content: message.content.map((part) => part.type === 'text'
          ? { ...part, text: truncateDisplayText(part.text, 2 * 1024 * 1024) }
          : part.type === 'thinking'
            ? { ...part, thinking: truncateDisplayText(part.thinking, 2 * 1024 * 1024) }
            : part)
      }
    case 'toolResult':
      return { ...message, content: message.content.map((part) => ({ ...part, text: truncateDisplayText(part.text) })) }
    case 'bashExecution':
      return { ...message, output: truncateDisplayText(message.output) }
    case 'custom':
      return {
        ...message,
        content: typeof message.content === 'string'
          ? truncateDisplayText(message.content)
          : message.content.map((part) => part.type === 'text'
            ? { ...part, text: truncateDisplayText(part.text) }
            : { type: 'image' as const, ...(part.mimeType ? { mimeType: part.mimeType } : {}) })
      }
    case 'branchSummary':
    case 'compactionSummary':
      return { ...message, summary: truncateDisplayText(message.summary, 2 * 1024 * 1024) }
    default:
      return message
  }
}

function keepTextTail(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(-maximum)
}

function getAssistantError(message: AssistantMessage): string {
  const errorMessage = (message as AssistantMessage & { errorMessage?: string }).errorMessage
  return errorMessage || 'Pi failed while generating a response'
}

function asRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function terminateChild(child: ChildProcessWithoutNullStreams, force: boolean): void {
  // Kept in one helper so a future Windows process-tree implementation is
  // isolated from the protocol client.
  child.kill(force ? 'SIGKILL' : 'SIGTERM')
}
