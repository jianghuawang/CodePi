import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { RefreshCw, TerminalSquare, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TerminalEvent } from '../../shared/contracts'
import '@xterm/xterm/css/xterm.css'

export interface TerminalPaneProps {
  threadId: string
  theme: 'light' | 'dark'
  active?: boolean
}

function terminalTheme(theme: 'light' | 'dark'): ITheme {
  return theme === 'dark'
    ? {
        background: '#18181a',
        foreground: '#e7e7e9',
        cursor: '#5aa7ff',
        cursorAccent: '#18181a',
        selectionBackground: '#355b8659',
        black: '#242428',
        brightBlack: '#72727a',
        red: '#ff6b6b',
        green: '#75c98d',
        yellow: '#e6bd68',
        blue: '#6ea8fe',
        magenta: '#c996e8',
        cyan: '#6dc9c8',
        white: '#e7e7e9',
      }
    : {
        background: '#ffffff',
        foreground: '#26262a',
        cursor: '#1677d2',
        cursorAccent: '#ffffff',
        selectionBackground: '#1677d22b',
        black: '#323237',
        brightBlack: '#77777e',
        red: '#c83f49',
        green: '#35844d',
        yellow: '#9a6818',
        blue: '#1268bd',
        magenta: '#8353a6',
        cyan: '#217e82',
        white: '#f4f4f5',
      }
}

function exitLabel(event: Extract<TerminalEvent, { type: 'exit' }>): string {
  if (event.signal) return `Process exited after signal ${event.signal}`
  return `Process exited with code ${event.exitCode}`
}

export function TerminalPane({ threadId, theme, active = true }: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const terminalIdRef = useRef<string | undefined>(undefined)
  const activeRef = useRef(active)
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState<string>()
  const [exited, setExited] = useState(false)

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(theme)
  }, [theme])

  useEffect(() => {
    activeRef.current = active
    if (!active || !terminalRef.current || !fitRef.current || !hostRef.current) return
    const frame = window.requestAnimationFrame(() => {
      if (!hostRef.current || hostRef.current.clientWidth < 20 || hostRef.current.clientHeight < 20) return
      try {
        fitRef.current?.fit()
        const terminal = terminalRef.current
        const terminalId = terminalIdRef.current
        if (terminal && terminalId) void window.codePi.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
      } catch {
        // The pane may have become hidden during the animation frame.
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let resizeFrame: number | undefined
    const bufferedEvents = new Map<string, TerminalEvent[]>()
    setError(undefined)
    setExited(false)
    terminalIdRef.current = undefined

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"SF Mono", ui-monospace, Menlo, Monaco, monospace',
      fontSize: 12,
      fontWeight: '400',
      lineHeight: 1.25,
      scrollback: 5_000,
      smoothScrollDuration: 80,
      theme: terminalTheme(theme),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit

    const applyEvent = (event: TerminalEvent): void => {
      if (event.type === 'data') terminal.write(event.data)
      else {
        terminal.writeln(`\r\n\x1b[90m[${exitLabel(event)}]\x1b[0m`)
        if (!disposed) setExited(true)
      }
    }
    const unsubscribe = window.codePi.onTerminalEvent((event) => {
      if (event.threadId !== threadId) return
      const terminalId = terminalIdRef.current
      if (terminalId === event.terminalId) {
        applyEvent(event)
        return
      }
      if (!terminalId) {
        const pending = bufferedEvents.get(event.terminalId) ?? []
        if (pending.length < 32) pending.push(event)
        bufferedEvents.set(event.terminalId, pending)
      }
    })

    const fitAndResize = (): void => {
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined
        if (!activeRef.current || disposed || host.clientWidth < 20 || host.clientHeight < 20) return
        try {
          fit.fit()
          const terminalId = terminalIdRef.current
          if (terminalId) void window.codePi.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(() => undefined)
        } catch {
          // FitAddon can throw while its element is transitioning to display:none.
        }
      })
    }
    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)
    fitAndResize()
    const input = terminal.onData((data) => {
      const terminalId = terminalIdRef.current
      if (!terminalId || disposed) return
      void window.codePi.writeTerminal(terminalId, data).catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      })
    })

    const start = async (): Promise<void> => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      if (disposed) return
      if (host.clientWidth >= 20 && host.clientHeight >= 20) {
        try { fit.fit() } catch { /* The dock may still be laying out. */ }
      }
      try {
        const opened = await window.codePi.openTerminal(
          threadId,
          Math.max(2, terminal.cols || 80),
          Math.max(1, terminal.rows || 24),
        )
        if (disposed) {
          await window.codePi.closeTerminal(opened.terminalId).catch(() => undefined)
          return
        }
        terminalIdRef.current = opened.terminalId
        bufferedEvents.get(opened.terminalId)?.forEach(applyEvent)
        bufferedEvents.clear()
        terminal.focus()
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    void start()

    return () => {
      disposed = true
      unsubscribe()
      observer.disconnect()
      input.dispose()
      if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
      const terminalId = terminalIdRef.current
      terminalIdRef.current = undefined
      terminalRef.current = undefined
      fitRef.current = undefined
      terminal.dispose()
      if (terminalId) void window.codePi.closeTerminal(terminalId).catch(() => undefined)
    }
    // A generation increment intentionally creates a fresh PTY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, threadId])

  return (
    <section className={`workspace-terminal-pane ${active ? 'is-active' : ''}`} aria-label="Terminal">
      <header className="workspace-terminal-toolbar">
        <span><TerminalSquare size={12} aria-hidden="true" /> Terminal</span>
        <div>
          <button
            type="button"
            className="workspace-icon-button"
            title="Clear terminal"
            aria-label="Clear terminal"
            onClick={() => terminalRef.current?.clear()}
          >
            <Trash2 size={12} />
          </button>
          {(exited || error) && (
            <button
              type="button"
              className="workspace-text-button"
              onClick={() => setGeneration((value) => value + 1)}
            >
              <RefreshCw size={12} /> Restart
            </button>
          )}
        </div>
      </header>
      {error && <div className="workspace-pane-error" role="alert">{error}</div>}
      <div ref={hostRef} className="workspace-terminal-host" onClick={() => terminalRef.current?.focus()} />
    </section>
  )
}
