import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import type { TerminalEvent, ThreadRecord } from '../shared/contracts'
import { terminalLaunchOptions } from './terminal-platform'

interface Disposable {
  dispose(): void
}

interface PtyExitEvent {
  exitCode: number
  signal?: number
}

interface PtyProcess {
  pid: number
  write(data: string): void
  resize(columns: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: PtyExitEvent) => void): Disposable
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
      encoding: 'utf8'
      handleFlowControl: boolean
    },
  ): PtyProcess
}

interface TerminalSession {
  id: string
  threadId: string
  pty: PtyProcess
  pending: string
  snapshot: string
  flushTimer?: NodeJS.Timeout
  cleanupTimer?: NodeJS.Timeout
  closePromise?: Promise<void>
  dataSubscription: Disposable
  exitSubscription: Disposable
  exited: boolean
  closing: boolean
  exitPromise: Promise<void>
  resolveExit: () => void
}

type ThreadLookup = (threadId: string) => ThreadRecord
type EventSink = (event: TerminalEvent) => void

const requireFromHere = createRequire(import.meta.url)
const MAX_TERMINALS_PER_THREAD = 6
const MAX_TERMINALS_TOTAL = 24
const MAX_INPUT_BYTES = 64 * 1024
const MAX_EVENT_CHARACTERS = 128 * 1024
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const MIN_COLUMNS = 2
const MAX_COLUMNS = 500
const MIN_ROWS = 1
const MAX_ROWS = 300

let nodePty: NodePtyModule | undefined

function loadNodePty(): NodePtyModule {
  if (nodePty) return nodePty
  try {
    nodePty = requireFromHere('node-pty') as NodePtyModule
    return nodePty
  } catch (error) {
    throw new Error('The integrated terminal could not load its native PTY component.', { cause: error })
  }
}

function terminalDimension(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function trimUtf8ToBytes(value: string, maximum: number): string {
  const buffer = Buffer.from(value)
  if (buffer.length <= maximum) return value
  const sliced = buffer.subarray(buffer.length - maximum).toString('utf8')
  return sliced.startsWith('\uFFFD') ? sliced.slice(1) : sliced
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>()

  constructor(
    private readonly getThread: ThreadLookup,
    private readonly emit: EventSink,
  ) {}

  async open(threadId: string, columnsValue: number, rowsValue: number): Promise<{ terminalId: string }> {
    const columns = terminalDimension(columnsValue, MIN_COLUMNS, MAX_COLUMNS, 'columns')
    const rows = terminalDimension(rowsValue, MIN_ROWS, MAX_ROWS, 'rows')
    const activeSessions = [...this.sessions.values()].filter((session) => !session.exited)
    if (activeSessions.length >= MAX_TERMINALS_TOTAL) throw new Error('Too many terminals are already open')
    if (activeSessions.filter((session) => session.threadId === threadId).length >= MAX_TERMINALS_PER_THREAD) {
      throw new Error('This thread already has the maximum number of terminals')
    }

    const thread = this.getThread(threadId)
    const cwdDetails = await stat(thread.cwd)
    if (!cwdDetails.isDirectory()) throw new Error('The thread working directory is unavailable')
    const launch = terminalLaunchOptions(thread.cwd)
    const pty = loadNodePty().spawn(launch.shell, launch.args, {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd: thread.cwd,
      env: launch.env,
      encoding: 'utf8',
      handleFlowControl: true,
    })

    const id = randomUUID()
    let resolveExit = (): void => undefined
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve })
    const session: TerminalSession = {
      id,
      threadId,
      pty,
      pending: '',
      snapshot: '',
      exited: false,
      closing: false,
      exitPromise,
      resolveExit,
      dataSubscription: { dispose: () => {} },
      exitSubscription: { dispose: () => {} },
    }

    this.sessions.set(id, session)
    session.dataSubscription = pty.onData((data) => this.acceptOutput(session, data))
    session.exitSubscription = pty.onExit((event) => this.acceptExit(session, event))
    return { terminalId: id }
  }

  write(terminalId: string, data: string): void {
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) {
      throw new TypeError('Terminal input is too large')
    }
    const session = this.requireSession(terminalId)
    if (session.exited || session.closing) throw new Error('Terminal has exited')
    session.pty.write(data)
  }

  resize(terminalId: string, columnsValue: number, rowsValue: number): void {
    const columns = terminalDimension(columnsValue, MIN_COLUMNS, MAX_COLUMNS, 'columns')
    const rows = terminalDimension(rowsValue, MIN_ROWS, MAX_ROWS, 'rows')
    const session = this.requireSession(terminalId)
    if (session.exited || session.closing) return
    session.pty.resize(columns, rows)
  }

  snapshot(terminalId: string): string {
    return this.requireSession(terminalId).snapshot
  }

  async close(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session) return
    session.closePromise ??= this.closeSession(session)
    await session.closePromise
  }

  private async closeSession(session: TerminalSession): Promise<void> {
    if (!session.exited && !session.closing) {
      session.closing = true
      try {
        session.pty.kill(process.platform === 'win32' ? undefined : 'SIGHUP')
      } catch {
        // The PTY may have exited between the state check and the signal.
      }
      await Promise.race([session.exitPromise, delay(450)])
      if (!session.exited) {
        try {
          session.pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
        } catch {
          // Nothing else can be done if the native PTY has already disappeared.
        }
        await Promise.race([session.exitPromise, delay(100)])
      }
    }
    this.removeSession(session)
  }

  async closeThread(threadId: string): Promise<void> {
    const ids = [...this.sessions.values()]
      .filter((session) => session.threadId === threadId)
      .map((session) => session.id)
    await Promise.allSettled(ids.map((id) => this.close(id)))
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.allSettled(ids.map((id) => this.close(id)))
  }

  private requireSession(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId)
    if (!session) throw new Error('Terminal not found')
    return session
  }

  private acceptOutput(session: TerminalSession, data: string): void {
    if (this.sessions.get(session.id) !== session || !data) return
    session.snapshot = trimUtf8ToBytes(session.snapshot + data, MAX_SNAPSHOT_BYTES)
    session.pending += data
    if (session.pending.length >= MAX_EVENT_CHARACTERS) {
      this.flush(session)
      return
    }
    session.flushTimer ??= setTimeout(() => {
      session.flushTimer = undefined
      this.flush(session)
    }, 16)
    session.flushTimer.unref()
  }

  private flush(session: TerminalSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = undefined
    }
    let pending = session.pending
    session.pending = ''
    while (pending.length > 0) {
      let end = Math.min(MAX_EVENT_CHARACTERS, pending.length)
      if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1])) end -= 1
      const data = pending.slice(0, end)
      pending = pending.slice(end)
      this.emit({ type: 'data', terminalId: session.id, threadId: session.threadId, data })
    }
  }

  private acceptExit(session: TerminalSession, event: PtyExitEvent): void {
    if (session.exited) return
    session.exited = true
    this.flush(session)
    session.resolveExit()
    this.emit({
      type: 'exit',
      terminalId: session.id,
      threadId: session.threadId,
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : 0,
      ...(Number.isInteger(event.signal) ? { signal: event.signal } : {}),
    })
    session.cleanupTimer = setTimeout(() => this.removeSession(session), 5 * 60_000)
    session.cleanupTimer.unref()
  }

  private removeSession(session: TerminalSession): void {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    if (session.flushTimer) clearTimeout(session.flushTimer)
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
    session.dataSubscription.dispose()
    session.exitSubscription.dispose()
    session.resolveExit()
  }
}
