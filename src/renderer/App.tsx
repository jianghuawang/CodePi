import { AlertTriangle, FolderPlus, Plus, RefreshCw, ShieldOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentMessage,
  BootstrapData,
  ComposerAttachment,
  CreateThreadInput,
  DeliveryMode,
  MenuAction,
  OpenThreadResult,
  PiCapability,
  PromptTemplate,
  ProjectRecord,
  ThinkingLevel,
  ThreadEvent,
  ThreadRecord,
  ThreadSearchResult,
} from '../shared/contracts'
import { ChangesView } from './components/ChangesView'
import { CommandPalette, type CommandPaletteAction } from './components/CommandPalette'
import { Composer } from './components/Composer'
import { NewThreadSheet } from './components/NewThreadSheet'
import { Onboarding } from './components/Onboarding'
import { Sidebar } from './components/Sidebar'
import { TerminalPane } from './components/TerminalPane'
import { ThreadHeader, type ThreadTab } from './components/ThreadHeader'
import { Transcript } from './components/Transcript'
import { WorkspaceDock, type WorkspaceDockTab } from './components/WorkspaceDock'
import { useTheme } from './hooks/useTheme'
import { appendMessage, markOptimisticUserMessage } from './runtime-messages'
import type { LiveSegment, LiveToolSegment, LiveTurn } from './ui-types'

interface ThreadRuntime extends OpenThreadResult {
  live?: LiveTurn
  queuedCount: number
  capabilities: PiCapability[]
  runtimeError?: string
}

interface DockState {
  open: boolean
  tab: WorkspaceDockTab
}

const closedDockState: DockState = { open: false, tab: 'files' }

function findToolIndex(segments: Record<number, LiveSegment>, toolCallId?: string, preferred?: number): number {
  if (preferred != null) return preferred
  const found = Object.entries(segments).find(([, segment]) => segment.type === 'tool' && segment.id === toolCallId)
  if (found) return Number(found[0])
  const indexes = Object.keys(segments).map(Number)
  return indexes.length ? Math.max(...indexes) + 1 : 0
}

function makeTool(existing: LiveSegment | undefined, id = '', name = ''): LiveToolSegment {
  if (existing?.type === 'tool') {
    return { ...existing, id: id || existing.id, name: name || existing.name }
  }
  return { type: 'tool', id, name, argsText: '', output: '', isError: false, complete: false }
}

export function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<BootstrapData>()
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [threads, setThreads] = useState<ThreadRecord[]>([])
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string>()
  const [runtimes, setRuntimes] = useState<Record<string, ThreadRuntime>>({})
  const [dockByThread, setDockByThread] = useState<Record<string, DockState>>({})
  // Presence of a key means the terminal pane stays mounted (keeping its PTY alive);
  // the value controls whether the drawer is visible.
  const [terminalByThread, setTerminalByThread] = useState<Record<string, boolean>>({})
  const [loadingThreadId, setLoadingThreadId] = useState<string>()
  const [fatalError, setFatalError] = useState<string>()
  const [newThreadProjectId, setNewThreadProjectId] = useState<string>()
  const [tabByThread, setTabByThread] = useState<Record<string, ThreadTab>>({})
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [threadSearchResults, setThreadSearchResults] = useState<ThreadSearchResult[]>([])
  const [threadSearchPending, setThreadSearchPending] = useState(false)
  const searchRequest = useRef(0)
  const theme = useTheme(bootstrap?.state.settings.theme ?? 'system')

  const loadThread = useCallback(async (threadId: string, restart = false) => {
    setSelectedThreadId(threadId)
    setLoadingThreadId(threadId)
    setFatalError(undefined)
    try {
      await window.codePi.selectThread(threadId)
      const opened = restart ? await window.codePi.restartThread(threadId) : await window.codePi.openThread(threadId)
      const capabilities = await window.codePi.getCapabilities(threadId).catch(() => [] as PiCapability[])
      setRuntimes((current) => ({
        ...current,
        [threadId]: { ...opened, capabilities, queuedCount: opened.state.pendingMessageCount }
      }))
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...opened.thread, unread: false } : thread))
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setThreads((current) => current.map((thread) => thread.id === threadId
        ? thread.status === 'error' && thread.lastError
          ? thread
          : { ...thread, status: 'error', lastError: message }
        : thread))
    } finally {
      setLoadingThreadId((current) => current === threadId ? undefined : current)
    }
  }, [])

  const loadThreadWithoutCapabilities = useCallback(async (threadId: string) => {
    setSelectedThreadId(threadId)
    setLoadingThreadId(threadId)
    setFatalError(undefined)
    try {
      await window.codePi.selectThread(threadId)
      const opened = await window.codePi.restartThreadWithoutCapabilities(threadId)
      const capabilities = await window.codePi.getCapabilities(threadId).catch(() => [] as PiCapability[])
      setRuntimes((current) => ({
        ...current,
        [threadId]: { ...opened, capabilities, queuedCount: opened.state.pendingMessageCount }
      }))
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...opened.thread, unread: false } : thread))
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setThreads((current) => current.map((thread) => thread.id === threadId
        ? { ...thread, status: 'error', lastError: message }
        : thread))
    } finally {
      setLoadingThreadId((current) => current === threadId ? undefined : current)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.codePi.bootstrap()
      .then((data) => {
        if (cancelled) return
        setBootstrap(data)
        setProjects(data.state.projects)
        setThreads(data.state.threads)
        setTemplates(data.state.promptLibrary)
        setSelectedThreadId(data.state.selectedThreadId)
        if (data.pi.available && data.state.selectedThreadId) void loadThread(data.state.selectedThreadId)
      })
      .catch((reason) => !cancelled && setFatalError(reason instanceof Error ? reason.message : String(reason)))
    return () => { cancelled = true }
  }, [loadThread])

  useEffect(() => {
    const refreshSettingsAndAvailability = () => {
      void window.codePi.bootstrap().then(setBootstrap).catch(() => undefined)
    }
    window.addEventListener('focus', refreshSettingsAndAvailability)
    return () => window.removeEventListener('focus', refreshSettingsAndAvailability)
  }, [])

  useEffect(() => window.codePi.onThreadEvent((event: ThreadEvent) => {
    const now = Date.now()
    if (event.type === 'status') {
      setThreads((current) => current.map((thread) => thread.id === event.threadId
        ? { ...thread, status: event.status, lastError: event.error }
        : thread))
    }
    if (event.type === 'settled') {
      setThreads((current) => current.map((thread) => thread.id === event.threadId
        ? { ...thread, status: 'idle', unread: event.threadId !== selectedThreadId, updatedAt: now }
        : thread))
    }

    setRuntimes((current) => {
      const runtime = current[event.threadId]
      if (!runtime) return current
      let next: ThreadRuntime = runtime
      const withLive = (updater: (live: LiveTurn) => LiveTurn) => {
        next = { ...next, live: updater(next.live ?? { segments: {} }) }
      }

      switch (event.type) {
        case 'agent-start':
          next = { ...runtime, live: { segments: {} }, runtimeError: undefined, state: { ...runtime.state, isStreaming: true } }
          break
        case 'text-delta':
          withLive((live) => {
            const existing = live.segments[event.contentIndex]
            const text = existing?.type === 'text' ? existing.text : ''
            return { ...live, segments: { ...live.segments, [event.contentIndex]: { type: 'text', text: text + event.delta } } }
          })
          break
        case 'thinking-delta':
          withLive((live) => {
            const existing = live.segments[event.contentIndex]
            const text = existing?.type === 'thinking' ? existing.text : ''
            return { ...live, segments: { ...live.segments, [event.contentIndex]: { type: 'thinking', text: text + event.delta } } }
          })
          break
        case 'tool-call-start':
          withLive((live) => {
            const index = findToolIndex(live.segments, event.toolCallId, event.contentIndex)
            return { ...live, segments: { ...live.segments, [index]: makeTool(live.segments[index], event.toolCallId, event.toolName) } }
          })
          break
        case 'tool-call-args':
          withLive((live) => {
            const index = findToolIndex(live.segments, event.toolCallId, event.contentIndex)
            const tool = makeTool(live.segments[index], event.toolCallId, event.toolName)
            tool.argsText += event.delta
            return { ...live, segments: { ...live.segments, [index]: tool } }
          })
          break
        case 'tool-call-end':
          withLive((live) => {
            const index = findToolIndex(live.segments, event.toolCallId, event.contentIndex)
            const tool = makeTool(live.segments[index], event.toolCallId, event.toolName)
            tool.name = event.toolName
            tool.args = event.args
            return { ...live, segments: { ...live.segments, [index]: tool } }
          })
          break
        case 'tool-output':
          withLive((live) => {
            const index = findToolIndex(live.segments, event.toolCallId)
            const tool = makeTool(live.segments[index], event.toolCallId, event.toolName)
            tool.name = event.toolName
            tool.output = event.output
            tool.complete = event.complete
            tool.isError = Boolean(event.isError)
            return { ...live, segments: { ...live.segments, [index]: tool } }
          })
          break
        case 'message-end': {
          const messages = appendMessage(runtime.messages, event.message)
          let live = runtime.live
          if (event.message.role === 'assistant') live = undefined
          if (event.message.role === 'toolResult' && live) {
            const toolCallId = event.message.toolCallId
            live = { ...live, segments: Object.fromEntries(Object.entries(live.segments).filter(([, segment]) => segment.type !== 'tool' || segment.id !== toolCallId)) }
          }
          const runtimeError = event.message.role === 'assistant' && event.message.stopReason === 'error'
            ? event.message.errorMessage || 'Pi failed while generating this response.'
            : runtime.runtimeError
          next = { ...runtime, messages, live, runtimeError }
          break
        }
        case 'turn-end': {
          let messages = appendMessage(runtime.messages, event.message)
          event.toolResults.forEach((result) => { messages = appendMessage(messages, result) })
          const runtimeError = event.message.stopReason === 'error'
            ? event.message.errorMessage || 'Pi failed while generating this response.'
            : runtime.runtimeError
          next = { ...runtime, messages, live: undefined, runtimeError, state: { ...runtime.state, isStreaming: false } }
          break
        }
        case 'queue':
          next = { ...runtime, queuedCount: event.steering.length + event.followUp.length }
          break
        case 'settled':
          next = {
            ...runtime,
            live: undefined,
            state: { ...runtime.state, isStreaming: false },
            queuedCount: 0,
            ...(event.stats ? { stats: event.stats } : {})
          }
          break
        case 'aborted':
          next = { ...runtime, live: undefined, state: { ...runtime.state, isStreaming: false } }
          break
        case 'error':
          next = { ...runtime, runtimeError: event.message }
          break
      }
      return next === runtime ? current : { ...current, [event.threadId]: next }
    })
  }), [selectedThreadId])

  const addProject = useCallback(async (): Promise<ProjectRecord | undefined> => {
    const project = await window.codePi.addProject()
    if (!project) return undefined
    setProjects((current) => current.some((item) => item.id === project.id) ? current : [...current, project])
    return project
  }, [])

  const beginNewThread = useCallback(async (projectId?: string) => {
    if (selectedThreadId) {
      await window.codePi.closePreview(selectedThreadId).catch(() => undefined)
    }
    let target = projectId ? projects.find((project) => project.id === projectId) : undefined
    if (!target && selectedThreadId) {
      const selected = threads.find((thread) => thread.id === selectedThreadId)
      target = projects.find((project) => project.id === selected?.projectId)
    }
    target ??= projects[0]
    target ??= await addProject()
    if (target) setNewThreadProjectId(target.id)
  }, [addProject, projects, selectedThreadId, threads])

  useEffect(() => window.codePi.onMenuAction((action: MenuAction) => {
    if (action === 'settings') void window.codePi.openSettings()
    if (action === 'new-project') void addProject()
    if (action === 'new-thread') void beginNewThread()
    if (action === 'command-palette') setCommandPaletteOpen(true)
  }), [addProject, beginNewThread])

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId)
  const runtime = selectedThreadId ? runtimes[selectedThreadId] : undefined
  const selectedProject = projects.find((project) => project.id === selectedThread?.projectId)
  const newThreadProject = projects.find((project) => project.id === newThreadProjectId)
  const selectedTab = selectedThreadId ? tabByThread[selectedThreadId] ?? 'transcript' : 'transcript'
  const selectedDock = selectedThreadId
    ? dockByThread[selectedThreadId] ?? closedDockState
    : undefined
  const terminalThreadIds = useMemo(() => Object.keys(terminalByThread), [terminalByThread])
  const terminalOpen = selectedThreadId ? terminalByThread[selectedThreadId] ?? false : false

  const toggleTerminal = useCallback((threadId: string) => {
    setTerminalByThread((current) => ({ ...current, [threadId]: !(current[threadId] ?? false) }))
  }, [])

  useEffect(() => {
    if (!commandPaletteOpen || !selectedThreadId) return
    void window.codePi.closePreview(selectedThreadId).catch(() => undefined)
    setDockByThread((current) => {
      const dock = current[selectedThreadId]
      if (!dock || dock.tab !== 'preview') return current
      return { ...current, [selectedThreadId]: { ...dock, tab: 'files' } }
    })
  }, [commandPaletteOpen, selectedThreadId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || selectedThread?.status !== 'running') return
      if (event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"]')) return
      if (event.target instanceof Element && event.target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      event.preventDefault()
      void window.codePi.abortThread(selectedThread.id).catch(() => undefined)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedThread])

  const updateManagedThread = useCallback(async (
    thread: ThreadRecord,
    update: Parameters<typeof window.codePi.updateThread>[1]
  ): Promise<ThreadRecord> => {
    const updated = await window.codePi.updateThread(thread.id, update)
    setThreads((current) => current.map((item) => item.id === updated.id ? updated : item))
    if (updated.archived) {
      setTerminalByThread((current) => {
        if (!(updated.id in current)) return current
        const next = { ...current }
        delete next[updated.id]
        return next
      })
    }
    if (updated.archived && selectedThreadId === updated.id) {
      setSelectedThreadId(undefined)
      await window.codePi.selectThread(undefined)
    }
    return updated
  }, [selectedThreadId])

  const trashManagedThread = useCallback(async (thread: ThreadRecord): Promise<void> => {
    await window.codePi.deleteThread(thread.id)
    setThreads((current) => current.map((item) => item.id === thread.id
      ? { ...item, deletedAt: Date.now(), status: 'idle', unread: false }
      : item))
    setDockByThread((current) => {
      const next = { ...current }
      delete next[thread.id]
      return next
    })
    setTerminalByThread((current) => {
      const next = { ...current }
      delete next[thread.id]
      return next
    })
    if (selectedThreadId === thread.id) {
      setSelectedThreadId(undefined)
      setRuntimes((current) => {
        const next = { ...current }
        delete next[thread.id]
        return next
      })
    }
  }, [selectedThreadId])

  const searchAllThreads = useCallback((query: string) => {
    const request = ++searchRequest.current
    if (!query.trim()) {
      setThreadSearchPending(false)
      setThreadSearchResults([])
      return
    }
    setThreadSearchPending(true)
    void window.codePi.searchThreads(query).then((results) => {
      if (request === searchRequest.current) setThreadSearchResults(results)
    }).catch(() => {
      if (request === searchRequest.current) setThreadSearchResults([])
    }).finally(() => {
      if (request === searchRequest.current) setThreadSearchPending(false)
    })
  }, [])

  const paletteActions: CommandPaletteAction[] = selectedThread ? [
    {
      id: 'workspace-files',
      label: 'Open Files',
      detail: selectedThread.title,
      keywords: ['workspace', 'file viewer'],
      run: () => setDockByThread((current) => ({ ...current, [selectedThread.id]: { ...(current[selectedThread.id] ?? {}), open: true, tab: 'files' } }))
    },
    {
      id: 'workspace-terminal',
      label: 'Open Terminal',
      detail: selectedThread.cwd,
      keywords: ['shell', 'workspace'],
      run: () => setTerminalByThread((current) => ({ ...current, [selectedThread.id]: true }))
    },
    {
      id: 'workspace-preview',
      label: 'Open App Preview',
      detail: 'Localhost only',
      keywords: ['browser', 'localhost', 'workspace'],
      run: () => setDockByThread((current) => ({ ...current, [selectedThread.id]: { ...(current[selectedThread.id] ?? {}), open: true, tab: 'preview' } }))
    },
    ...(selectedProject?.isGit ? [{
      id: 'show-changes',
      label: 'Show Changes',
      detail: selectedThread.title,
      keywords: ['git', 'diff'],
      run: () => setTabByThread((current) => ({ ...current, [selectedThread.id]: 'changes' }))
    }] : [])
  ] : []

  const shell = useMemo(() => {
    if (!bootstrap) return null
    if (!bootstrap.pi.available) {
      return <Onboarding path={bootstrap.pi.path} error={bootstrap.pi.error} onOpenSettings={() => void window.codePi.openSettings()} />
    }
    if (!selectedThread) {
      return (
        <div className="no-thread-view">
          <div className="empty-project-art"><span>π</span></div>
          <h1>Start a thread</h1>
          <p>Choose a project, hand Pi a task, and keep working while it runs.</p>
          <div className="empty-actions">
            <button className="button button-primary" onClick={() => void beginNewThread()}><Plus size={14} /> New thread</button>
            {projects.length === 0 && <button className="button button-secondary" onClick={() => void addProject()}><FolderPlus size={14} /> Add project</button>}
          </div>
        </div>
      )
    }
    if (!runtime && selectedThread.status === 'error' && loadingThreadId !== selectedThread.id) {
      return (
        <div className="thread-open-failure" role="alert">
          <AlertTriangle size={22} />
          <h1>Pi couldn’t open this thread</h1>
          <pre>{selectedThread.lastError ?? 'The Pi process exited before its session was ready.'}</pre>
          <div className="empty-actions">
            <button className="button button-primary" onClick={() => void loadThread(selectedThread.id, true)}>
              <RefreshCw size={13} /> Restart Pi
            </button>
            <button className="button button-secondary" onClick={() => void loadThreadWithoutCapabilities(selectedThread.id)}>
                        <ShieldOff size={13} /> Restart with extensions &amp; skills off
            </button>
          </div>
        </div>
      )
    }
    if (!runtime || loadingThreadId === selectedThread.id) {
      return <div className="thread-loading"><span className="spinner" /> Opening {selectedThread.title}…</div>
    }
    return (
      <div className="thread-view">
        <ThreadHeader
          key={selectedThread.id}
          thread={selectedThread}
          tree={runtime.tree}
          isGit={Boolean(selectedProject?.isGit)}
          projectId={selectedThread.projectId}
          state={runtime.state}
          stats={runtime.stats}
          tab={selectedTab}
          workspaceOpen={Boolean(selectedDock?.open)}
          terminalOpen={terminalOpen}
          onTabChange={(tab) => setTabByThread((current) => ({ ...current, [selectedThread.id]: tab }))}
          onLoadHistory={async () => {
            const history = await window.codePi.getHistory(selectedThread.id)
            setRuntimes((current) => ({ ...current, [selectedThread.id]: { ...current[selectedThread.id], tree: history.tree } }))
          }}
          onBranch={async (entryId) => {
            const thread = await window.codePi.branchThread(selectedThread.id, entryId)
            setThreads((current) => [...current, thread])
            await loadThread(thread.id)
          }}
          onOpenEditor={() => void window.codePi.openInEditor(selectedThread.id)}
          onToggleTerminal={() => toggleTerminal(selectedThread.id)}
          onToggleWorkspace={() => setDockByThread((current) => ({
            ...current,
            [selectedThread.id]: {
              ...(current[selectedThread.id] ?? { tab: 'files' }),
              open: !(current[selectedThread.id]?.open ?? false)
            }
          }))}
          onStateChange={(state) => setRuntimes((current) => ({
            ...current,
            [selectedThread.id]: { ...current[selectedThread.id], state }
          }))}
          onStatsChange={(stats) => setRuntimes((current) => ({
            ...current,
            [selectedThread.id]: { ...current[selectedThread.id], stats }
          }))}
        />
        {selectedTab === 'transcript' ? (
          <div className="conversation-pane">
            <div className="conversation-alerts">
              {runtime.runtimeError && selectedThread.status !== 'error' && (
                <div className="agent-error-banner" role="alert">
                  <AlertTriangle size={14} />
                  <div><strong>Pi reported an error</strong><span>{runtime.runtimeError}</span></div>
                </div>
              )}
              {selectedThread.status === 'error' && (
                <div className="thread-error-banner" role="alert">
                  <AlertTriangle size={15} />
                  <div><strong>Pi stopped unexpectedly</strong><span>{selectedThread.lastError ?? 'The agent process exited.'}</span></div>
                  <div className="thread-error-actions">
                    <button className="button button-secondary compact" onClick={() => void loadThread(selectedThread.id, true)}>
                      <RefreshCw size={12} /> Restart
                    </button>
                    <button className="button button-secondary compact" onClick={() => void loadThreadWithoutCapabilities(selectedThread.id)} title="Disable all extensions and skills for this thread, then restart">
                      <ShieldOff size={12} /> Safe restart
                    </button>
                  </div>
                </div>
              )}
            </div>
            <Transcript
              key={selectedThread.id}
              messages={runtime.messages}
              live={runtime.live}
              theme={theme}
              running={selectedThread.status === 'running'}
            />
            {selectedThread.archived ? (
              <div className="archived-thread-notice">
                <span>This thread is archived and read-only.</span>
                <button className="button button-secondary compact" onClick={() => void updateManagedThread(selectedThread, { archived: false })}>
                  Unarchive
                </button>
              </div>
            ) : <Composer
              key={selectedThread.id}
              threadId={selectedThread.id}
              cwd={selectedThread.cwd}
              status={selectedThread.status}
              queuedCount={runtime.queuedCount}
              model={runtime.state.model}
              models={runtime.models}
              thinkingLevel={runtime.state.thinkingLevel}
              commands={runtime.commands}
              capabilities={runtime.capabilities}
              templates={templates}
              onAbort={() => void window.codePi.abortThread(selectedThread.id)}
              onRuntimeChanged={(opened) => {
                setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? opened.thread : thread))
                setRuntimes((current) => ({
                  ...current,
                  [selectedThread.id]: {
                    ...opened,
                    capabilities: current[selectedThread.id]?.capabilities ?? [],
                    queuedCount: opened.state.pendingMessageCount
                  }
                }))
                void window.codePi.getCapabilities(selectedThread.id).then((capabilities) => {
                  setRuntimes((current) => ({
                    ...current,
                    [selectedThread.id]: { ...current[selectedThread.id], capabilities }
                  }))
                }).catch(() => undefined)
              }}
              onTemplatesChanged={setTemplates}
              onSetModel={async (provider, modelId) => {
                const model = await window.codePi.setModel(selectedThread.id, provider, modelId)
                setRuntimes((current) => ({
                  ...current,
                  [selectedThread.id]: {
                    ...current[selectedThread.id],
                    state: { ...current[selectedThread.id].state, model },
                  },
                }))
              }}
              onSetThinkingLevel={async (level: ThinkingLevel) => {
                const thinkingLevel = await window.codePi.setThinkingLevel(selectedThread.id, level)
                setRuntimes((current) => ({
                  ...current,
                  [selectedThread.id]: {
                    ...current[selectedThread.id],
                    state: { ...current[selectedThread.id].state, thinkingLevel },
                  },
                }))
              }}
              onSend={async (text: string, mode: DeliveryMode, attachments: ComposerAttachment[]) => {
                const optimistic = mode !== 'followUp'
                const message: AgentMessage = { role: 'user', content: text, timestamp: Date.now() }
                setThreads((current) => current.map((thread) => thread.id === selectedThread.id
                  ? { ...thread, updatedAt: message.timestamp }
                  : thread))
                if (optimistic) {
                  markOptimisticUserMessage(message)
                  setRuntimes((current) => ({ ...current, [selectedThread.id]: { ...current[selectedThread.id], messages: appendMessage(current[selectedThread.id].messages, message) } }))
                } else {
                  setRuntimes((current) => ({ ...current, [selectedThread.id]: { ...current[selectedThread.id], queuedCount: current[selectedThread.id].queuedCount + 1 } }))
                }
                try {
                  await window.codePi.sendMessage(selectedThread.id, text, mode, attachments)
                } catch (reason) {
                  if (optimistic) {
                    setRuntimes((current) => ({ ...current, [selectedThread.id]: { ...current[selectedThread.id], messages: current[selectedThread.id].messages.filter((item) => item !== message) } }))
                  }
                  throw reason
                }
              }}
            />}
          </div>
        ) : (
          <ChangesView
            key={selectedThread.id}
            thread={selectedThread}
            theme={theme}
            onOpenEditor={() => void window.codePi.openInEditor(selectedThread.id)}
            onApplyToMain={() => window.codePi.applyToMain(selectedThread.id)}
          />
        )}
      </div>
    )
  }, [
    addProject,
    beginNewThread,
    bootstrap,
    loadThread,
    loadThreadWithoutCapabilities,
    loadingThreadId,
    projects.length,
    runtime,
    selectedDock,
    selectedProject?.isGit,
    selectedTab,
    selectedThread,
    templates,
    terminalOpen,
    theme,
    toggleTerminal,
    updateManagedThread,
  ])

  if (!bootstrap && !fatalError) return <div className="app-loading"><div className="pi-loader">π</div><span>Starting CodePi…</span></div>
  if (fatalError) return <div className="fatal-screen"><AlertTriangle size={22} /><h1>CodePi couldn’t start</h1><p>{fatalError}</p></div>

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        threads={threads}
        selectedThreadId={selectedThreadId}
        onAddProject={() => void addProject()}
        onToggleProject={(projectId, expanded) => {
          setProjects((current) => current.map((project) => project.id === projectId ? { ...project, expanded } : project))
          void window.codePi.toggleProject(projectId, expanded)
        }}
        onSelectThread={(threadId) => void loadThread(threadId)}
        onNewThread={(projectId) => void beginNewThread(projectId)}
        onRenameThread={(thread, title) => updateManagedThread(thread, { title })}
        onDuplicateThread={async (thread) => {
          const copy = await window.codePi.duplicateThread(thread.id)
          setThreads((current) => [copy, ...current])
          await loadThread(copy.id)
        }}
        onSetThreadArchived={(thread, archived) => updateManagedThread(thread, { archived })}
        onSetThreadPinned={(thread, pinned) => updateManagedThread(thread, { pinned })}
        onSetThreadUnread={(thread, unread) => updateManagedThread(thread, { unread })}
        onSetThreadTags={(thread, tags) => updateManagedThread(thread, { tags })}
        onExportThread={(thread, format) => window.codePi.exportThread(thread.id, format)}
        onTrashThread={trashManagedThread}
        onRestoreThread={async (thread) => {
          const restored = await window.codePi.restoreThread(thread.id)
          setThreads((current) => current.map((item) => item.id === restored.id ? restored : item))
        }}
        onPurgeThread={async (thread) => {
          await window.codePi.purgeThread(thread.id)
          setThreads((current) => current.filter((item) => item.id !== thread.id))
          setRuntimes((current) => {
            const next = { ...current }
            delete next[thread.id]
            return next
          })
        }}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenSettings={() => void window.codePi.openSettings()}
      />
      <main className={`main-pane ${selectedDock?.open ? 'has-workspace-dock' : ''}`}>
        <div className="main-content">
          {shell}
          {terminalThreadIds.length > 0 && (
            <div className="thread-terminal-drawer" hidden={!selectedThread || !terminalOpen}>
              {terminalThreadIds.map((threadId) => (
                <div className="thread-terminal-session" key={threadId} hidden={threadId !== selectedThread?.id}>
                  <TerminalPane
                    threadId={threadId}
                    theme={theme}
                    active={threadId === selectedThread?.id && terminalOpen}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {selectedThread && selectedDock?.open && (
          <WorkspaceDock
            key={selectedThread.id}
            threadId={selectedThread.id}
            activeTab={selectedDock.tab}
            onTabChange={(tab) => setDockByThread((current) => ({
              ...current,
              [selectedThread.id]: { ...(current[selectedThread.id] ?? {}), open: true, tab }
            }))}
            onClose={() => {
              void window.codePi.closePreview(selectedThread.id).catch(() => undefined)
              setDockByThread((current) => ({
                ...current,
                [selectedThread.id]: { ...(current[selectedThread.id] ?? { tab: 'files' }), open: false }
              }))
            }}
          />
        )}
      </main>
      <CommandPalette
        open={commandPaletteOpen}
        projects={projects}
        threads={threads}
        selectedThreadId={selectedThreadId}
        actions={paletteActions}
        searchResults={threadSearchResults}
        searching={threadSearchPending}
        onQueryChange={searchAllThreads}
        onRequestOpen={() => setCommandPaletteOpen(true)}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectThread={(threadId) => loadThread(threadId)}
        onNewThread={(projectId) => beginNewThread(projectId)}
        onAddProject={addProject}
        onOpenSettings={() => window.codePi.openSettings()}
      />
      {newThreadProject && (
        <NewThreadSheet
          project={newThreadProject}
          onClose={() => setNewThreadProjectId(undefined)}
          onCreate={async (input: CreateThreadInput) => {
            const thread = await window.codePi.createThread(input)
            setThreads((current) => [...current, thread])
            setProjects((current) => current.map((project) => project.id === input.projectId ? { ...project, expanded: true } : project))
            setNewThreadProjectId(undefined)
            await loadThread(thread.id)
          }}
        />
      )}
    </div>
  )
}
