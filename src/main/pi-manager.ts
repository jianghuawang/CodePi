import type {
  OpenThreadResult,
  PiModel,
  SessionStats,
  ThinkingLevel,
  ThreadEvent,
  ThreadRecord
} from '../shared/contracts'
import { PiRpcClient } from './pi-rpc'
import { environmentForPi } from './pi-validation'
import type { StateStore } from './state-store'

type EventSink = (event: ThreadEvent) => void

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PiProcessManager {
  private readonly clients = new Map<string, PiRpcClient>()

  constructor(
    private readonly store: StateStore,
    private readonly emit: EventSink
  ) {}

  has(threadId: string): boolean {
    return this.clients.has(threadId)
  }

  async open(threadId: string): Promise<OpenThreadResult> {
    const thread = this.getThread(threadId)
    let client = this.clients.get(threadId)
    if (!client) {
      const settings = this.store.snapshot().settings
      client = new PiRpcClient({
        piPath: settings.piPath,
        cwd: thread.cwd,
        env: environmentForPi(settings.env),
        ...(thread.sessionFile ? { session: thread.sessionFile } : {}),
        ...(!thread.sessionFile && settings.defaultModel ? { model: settings.defaultModel } : {}),
        requestTimeoutMs: 30_000
      })
      this.attach(threadId, client)
      this.clients.set(threadId, client)
      this.setStatus(threadId, 'waiting')
      try {
        await client.start()
      } catch (error) {
        this.clients.delete(threadId)
        await client.stop().catch(() => undefined)
        this.setStatus(threadId, 'error', errorMessage(error))
        throw error
      }
    }

    try {
      const [state, messages, models, history] = await Promise.all([
        client.getState(),
        client.getMessages(),
        client.getAvailableModels(),
        client.getTree()
      ])
      this.store.update((persisted) => {
        const current = persisted.threads.find((item) => item.id === threadId)
        if (!current) return
        current.status = state.isStreaming ? 'running' : 'idle'
        current.lastError = undefined
        current.updatedAt = Date.now()
        if (state.sessionFile) current.sessionFile = state.sessionFile
      })
      const current = this.getThread(threadId)
      this.emit({ type: 'status', threadId, status: current.status })
      return {
        thread: current,
        state,
        messages,
        models,
        tree: history.tree
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

  async send(threadId: string, message: string, mode: 'prompt' | 'steer' | 'followUp'): Promise<void> {
    const client = await this.ensureClient(threadId)
    this.store.update((state) => {
      const thread = state.threads.find((item) => item.id === threadId)
      if (thread) thread.updatedAt = Date.now()
    })
    if (mode === 'steer') await client.steer(message)
    else if (mode === 'followUp') await client.followUp(message)
    else await client.prompt(message)
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

  async history(threadId: string): Promise<{ tree: Awaited<ReturnType<PiRpcClient['getTree']>>['tree']; leafId: string | null }> {
    const client = await this.ensureClient(threadId)
    const history = await client.getTree()
    return { tree: history.tree, leafId: history.leafId }
  }

  async close(threadId: string): Promise<void> {
    const client = this.clients.get(threadId)
    if (!client) return
    this.clients.delete(threadId)
    await client.stop().catch(() => undefined)
    if (this.store.snapshot().threads.some((thread) => thread.id === threadId)) {
      this.setStatus(threadId, 'idle')
    }
  }

  async stopAll(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(clients.map((client) => client.stop()))
  }

  private async ensureClient(threadId: string): Promise<PiRpcClient> {
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
      thread.updatedAt = Date.now()
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
