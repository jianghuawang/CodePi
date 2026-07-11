import { randomUUID } from 'node:crypto'
import type {
  ComposerAttachment,
  OpenThreadResult,
  PiCommand,
  PiModel,
  SessionStats,
  ThinkingLevel,
  ThreadEvent,
  ThreadRecord
} from '../shared/contracts'
import { attachedPathBlock, attachedTextBlock } from '../shared/attachment-context'
import type { PiImageContent } from '../shared/pi-rpc-types'
import { buildPiCapabilitySpawnArgs } from './pi-capabilities'
import { PiRpcClient } from './pi-rpc'
import { environmentForPi } from './pi-validation'
import type { StateStore } from './state-store'

type EventSink = (event: ThreadEvent) => void

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildPrompt(message: string, attachments: ComposerAttachment[]): { message: string; images: PiImageContent[] } {
  const images: PiImageContent[] = []
  const context: string[] = []
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.data) {
      images.push({ type: 'image', data: attachment.data.replace(/^data:[^;]+;base64,/, ''), mimeType: attachment.mimeType })
      continue
    }
    if (attachment.kind === 'text' && attachment.text !== undefined) {
      context.push(attachedTextBlock(attachment.name, attachment.text))
      continue
    }
    if (attachment.path) context.push(attachedPathBlock(attachment.path))
  }
  return { message: context.length ? `${message}\n\n${context.join('\n\n')}` : message, images }
}

export class PiProcessManager {
  private readonly clients = new Map<string, PiRpcClient>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly opening = new Map<string, Promise<OpenThreadResult>>()

  constructor(
    private readonly store: StateStore,
    private readonly emit: EventSink
  ) {}

  has(threadId: string): boolean {
    return this.clients.has(threadId)
  }

  async open(threadId: string): Promise<OpenThreadResult> {
    const pending = this.opening.get(threadId)
    if (pending) return pending
    const operation = this.openOnce(threadId)
    this.opening.set(threadId, operation)
    try {
      return await operation
    } finally {
      if (this.opening.get(threadId) === operation) this.opening.delete(threadId)
    }
  }

  private async openOnce(threadId: string): Promise<OpenThreadResult> {
    const thread = this.getThread(threadId)
    let client = this.clients.get(threadId)
    if (!client) {
      const settings = this.store.snapshot().settings
      const created = new PiRpcClient({
        piPath: settings.piPath,
        cwd: thread.cwd,
        env: environmentForPi(settings.env),
        ...(thread.sessionFile ? { session: thread.sessionFile } : {}),
        ...(!thread.sessionFile && settings.defaultModel ? { model: settings.defaultModel } : {}),
        requestTimeoutMs: 30_000,
        extraArgs: await buildPiCapabilitySpawnArgs(thread, settings)
      })
      client = created
      this.attach(threadId, client)
      this.clients.set(threadId, client)
      this.setStatus(threadId, 'waiting')
      const startup = (async () => {
        await created.start()
      })()
      this.starting.set(threadId, startup)
      try {
        await startup
      } catch (error) {
        this.clients.delete(threadId)
        await client.stop().catch(() => undefined)
        this.setStatus(threadId, 'error', errorMessage(error))
        throw error
      } finally {
        if (this.starting.get(threadId) === startup) this.starting.delete(threadId)
      }
    } else {
      await this.starting.get(threadId)
    }

    try {
      const [state, messages, models, history, commands, stats] = await Promise.all([
        client.getState(),
        client.getMessages(),
        client.getAvailableModels(),
        client.getTree(),
        client.getCommands().catch(() => [] as PiCommand[]),
        client.getSessionStats().catch(() => undefined)
      ])
      state.autoRetryEnabled = thread.autoRetryEnabled
      this.store.update((persisted) => {
        const current = persisted.threads.find((item) => item.id === threadId)
        if (!current) return
        current.status = state.isStreaming ? 'running' : 'idle'
        current.lastError = undefined
        if (state.sessionFile) current.sessionFile = state.sessionFile
        const statsSessionId = stats?.sessionId ?? state.sessionId ?? current.id
        if (stats && current.usageSnapshot?.sessionId !== statsSessionId) {
          current.usageSnapshot = {
            sessionId: statsSessionId,
            tokens: stats.tokens.total,
            cost: stats.cost
          }
        }
      })
      const current = this.getThread(threadId)
      this.emit({ type: 'status', threadId, status: current.status })
      return {
        thread: current,
        state,
        messages,
        models,
        tree: history.tree,
        commands,
        ...(stats ? { stats } : {})
      }
    } catch (error) {
      const stderr = client.stderr.trim()
      const message = stderr ? stderr.slice(-4_000) : errorMessage(error)
      this.setStatus(threadId, 'error', message)
      throw new Error(message, { cause: error })
    }
  }

  async restart(threadId: string): Promise<OpenThreadResult> {
    await this.close(threadId)
    return this.open(threadId)
  }

  async send(
    threadId: string,
    message: string,
    mode: 'prompt' | 'steer' | 'followUp',
    attachments: ComposerAttachment[] = []
  ): Promise<void> {
    const client = await this.ensureClient(threadId)
    const prompt = buildPrompt(message, attachments)
    this.store.update((state) => {
      const thread = state.threads.find((item) => item.id === threadId)
      if (thread) thread.updatedAt = Date.now()
    })
    if (mode === 'steer') await client.steer(prompt.message, prompt.images)
    else if (mode === 'followUp') await client.followUp(prompt.message, prompt.images)
    else await client.prompt(prompt.message, prompt.images)
  }

  async abort(threadId: string): Promise<void> {
    const client = this.clients.get(threadId)
    if (client) await client.abort()
  }

  async setModel(threadId: string, provider: string, modelId: string): Promise<PiModel> {
    const client = await this.ensureClient(threadId)
    return client.setModel(provider, modelId)
  }

  async setThinkingLevel(threadId: string, level: ThinkingLevel): Promise<ThinkingLevel> {
    const client = await this.ensureClient(threadId)
    await client.setThinkingLevel(level)
    return level
  }

  async commands(threadId: string): Promise<PiCommand[]> {
    return (await this.ensureClient(threadId)).getCommands()
  }

  async stats(threadId: string): Promise<SessionStats | undefined> {
    return (await this.ensureClient(threadId)).getSessionStats().catch(() => undefined)
  }

  async messages(threadId: string): Promise<Awaited<ReturnType<PiRpcClient['getMessages']>>> {
    return (await this.ensureClient(threadId)).getMessages()
  }

  async compact(threadId: string, customInstructions?: string): Promise<SessionStats | undefined> {
    const client = await this.ensureClient(threadId)
    const state = await client.getState()
    if (state.isStreaming) throw new Error('Stop the running turn before compacting context')
    await client.compact(customInstructions)
    return client.getSessionStats().catch(() => undefined)
  }

  async setAutoCompaction(threadId: string, enabled: boolean): Promise<boolean> {
    const client = await this.ensureClient(threadId)
    await client.setAutoCompaction(enabled)
    await Promise.allSettled(
      [...this.clients.entries()]
        .filter(([id]) => id !== threadId)
        .map(([, sibling]) => sibling.setAutoCompaction(enabled))
    )
    const state = await client.getState().catch(() => undefined)
    return state?.autoCompactionEnabled ?? enabled
  }

  async setAutoRetry(threadId: string, enabled: boolean): Promise<boolean> {
    const client = await this.ensureClient(threadId)
    await client.setAutoRetry(enabled)
    await Promise.allSettled(
      [...this.clients.entries()]
        .filter(([id]) => id !== threadId)
        .map(([, sibling]) => sibling.setAutoRetry(enabled))
    )
    this.store.update((state) => {
      for (const thread of state.threads) thread.autoRetryEnabled = enabled
    })
    return enabled
  }

  async exportHtml(threadId: string, outputPath: string): Promise<{ path: string }> {
    return (await this.ensureClient(threadId)).exportHtml(outputPath)
  }

  async setSessionName(threadId: string, name: string): Promise<void> {
    const client = this.clients.get(threadId)
    if (client) await client.setSessionName(name)
  }

  async history(threadId: string): Promise<{ tree: Awaited<ReturnType<PiRpcClient['getTree']>>['tree']; leafId: string | null }> {
    const client = await this.ensureClient(threadId)
    const history = await client.getTree()
    return { tree: history.tree, leafId: history.leafId }
  }

  async close(threadId: string): Promise<void> {
    await this.opening.get(threadId)?.catch(() => undefined)
    const client = this.clients.get(threadId)
    if (!client) return
    this.clients.delete(threadId)
    this.starting.delete(threadId)
    await client.stop().catch(() => undefined)
    if (this.store.snapshot().threads.some((thread) => thread.id === threadId)) {
      this.setStatus(threadId, 'idle')
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.opening.values()])
    const clients = [...this.clients.values()]
    this.clients.clear()
    this.starting.clear()
    this.opening.clear()
    await Promise.allSettled(clients.map((client) => client.stop()))
  }

  private async ensureClient(threadId: string): Promise<PiRpcClient> {
    await this.opening.get(threadId)
    const existing = this.clients.get(threadId)
    if (existing) return existing
    await this.open(threadId)
    const client = this.clients.get(threadId)
    if (!client) throw new Error('Pi process did not start')
    return client
  }

  private getThread(threadId: string): ThreadRecord {
    const thread = this.store.snapshot().threads.find((item) => item.id === threadId)
    if (!thread) throw new Error('Thread not found')
    return thread
  }

  private setStatus(threadId: string, status: ThreadRecord['status'], error?: string): void {
    this.store.update((state) => {
      const thread = state.threads.find((item) => item.id === threadId)
      if (!thread) return
      thread.status = status
      thread.lastError = error
    })
    this.emit({ type: 'status', threadId, status, ...(error ? { error } : {}) })
  }

  private attach(threadId: string, client: PiRpcClient): void {
    client.on('agent-start', () => {
      this.setStatus(threadId, 'running')
      this.emit({ type: 'agent-start', threadId })
    })
    client.on('text-delta', (event) => this.emit({ type: 'text-delta', threadId, ...event }))
    client.on('thinking-delta', (event) => this.emit({ type: 'thinking-delta', threadId, ...event }))
    client.on('tool-call-start', (event) => this.emit({ type: 'tool-call-start', threadId, ...event }))
    client.on('tool-call-args', (event) => this.emit({ type: 'tool-call-args', threadId, ...event }))
    client.on('tool-call-end', (event) => this.emit({ type: 'tool-call-end', threadId, ...event }))
    client.on('tool-execution-start', (event) => {
      this.emit({
        type: 'tool-call-start',
        threadId,
        toolCallId: event.toolCallId,
        toolName: event.toolName
      })
    })
    client.on('tool-output', (event) => this.emit({ type: 'tool-output', threadId, ...event }))
    client.on('message-end', (message) => this.emit({ type: 'message-end', threadId, message }))
    client.on('turn-end', (event) => {
      this.store.update((state) => {
        const thread = state.threads.find((item) => item.id === threadId)
        if (thread) thread.updatedAt = Date.now()
      })
      this.emit({ type: 'turn-end', threadId, ...event })
    })
    client.on('queue', (event) => this.emit({ type: 'queue', threadId, ...event }))
    client.on('aborted', () => {
      this.setStatus(threadId, 'idle')
      this.emit({ type: 'aborted', threadId })
    })
    client.on('agent-settled', () => {
      setTimeout(() => {
        void Promise.allSettled([client.getState(), client.getSessionStats()]).then(([stateResult, statsResult]) => {
          if (this.clients.get(threadId) !== client) return
          const currentState = stateResult.status === 'fulfilled' ? stateResult.value : undefined
          const stats = statsResult.status === 'fulfilled' ? statsResult.value : undefined
          const sessionFile = stats?.sessionFile ?? currentState?.sessionFile
          this.store.update((state) => {
            const thread = state.threads.find((item) => item.id === threadId)
            if (!thread) return
            if (sessionFile) thread.sessionFile = sessionFile
            thread.updatedAt = Date.now()
            thread.unread = state.selectedThreadId !== threadId
            if (stats) {
              const sameSession = thread.usageSnapshot?.sessionId === (stats.sessionId ?? currentState?.sessionId)
              const previousTokens = sameSession ? thread.usageSnapshot?.tokens ?? 0 : 0
              const previousCost = sameSession ? thread.usageSnapshot?.cost ?? 0 : 0
              const tokens = Math.max(0, stats.tokens.total - previousTokens)
              const cost = Math.max(0, stats.cost - previousCost)
              if (tokens > 0 || cost > 0) {
                state.usageLedger.push({
                  id: randomUUID(),
                  projectId: thread.projectId,
                  threadId,
                  timestamp: Date.now(),
                  tokens,
                  cost
                })
                if (state.usageLedger.length > 20_000) state.usageLedger.splice(0, state.usageLedger.length - 20_000)
              }
              thread.usageSnapshot = {
                sessionId: stats.sessionId ?? currentState?.sessionId ?? thread.id,
                tokens: stats.tokens.total,
                cost: stats.cost
              }
            }
          })
          // Older Pi versions only emit agent_end. Avoid reporting a false
          // idle transition when a retry or compaction is already under way.
          if (currentState?.isStreaming || currentState?.isCompacting) return
          this.setStatus(threadId, 'idle')
          this.emit({
            type: 'settled',
            threadId,
            ...(stats ? { stats: stats as SessionStats } : {})
          })
        })
      }, 200)
    })
    client.on('error', (event) => {
      this.emit({ type: 'error', threadId, message: event.message, recoverable: event.recoverable })
    })
    client.on('process-crash', (event) => {
      if (this.clients.get(threadId) === client) this.clients.delete(threadId)
      const details = event.stderr.trim()
      const message = details
        ? `Pi stopped unexpectedly: ${details.slice(-2_000)}`
        : `Pi stopped unexpectedly (${event.signal ?? event.code ?? 'unknown'})`
      this.setStatus(threadId, 'error', message)
    })
  }
}
