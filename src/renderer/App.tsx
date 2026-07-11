import { AlertTriangle, FolderPlus, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentMessage,
  BootstrapData,
  CreateThreadInput,
  DeliveryMode,
  MenuAction,
  OpenThreadResult,
  ProjectRecord,
  SessionState,
  ThinkingLevel,
  ThreadEvent,
  ThreadRecord,
} from '../shared/contracts'
import { ChangesView } from './components/ChangesView'
import { Composer } from './components/Composer'
import { NewThreadSheet } from './components/NewThreadSheet'
import { Onboarding } from './components/Onboarding'
import { Sidebar } from './components/Sidebar'
import { ThreadHeader, type ThreadTab } from './components/ThreadHeader'
import { Transcript } from './components/Transcript'
import { useTheme } from './hooks/useTheme'
import type { LiveSegment, LiveToolSegment, LiveTurn } from './ui-types'

interface ThreadRuntime extends OpenThreadResult {
  live?: LiveTurn
  queuedCount: number
  runtimeError?: string
}

function fallbackState(threadId: string): SessionState {
  return {
    model: null,
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    sessionId: threadId,
    messageCount: 0,
    pendingMessageCount: 0,
  }
}

function messageText(message: AgentMessage): string {
  if (message.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.filter((item) => item.type === 'text').map((item) => item.type === 'text' ? item.text : '').join('\n')
}

function appendMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const duplicate = messages.some((candidate) => {
    if (candidate.role !== message.role) return false
    if (candidate.role === 'toolResult' && message.role === 'toolResult') return candidate.toolCallId === message.toolCallId
    if (candidate.role === 'user' && message.role === 'user') {
      return messageText(candidate) === messageText(message) && Math.abs(candidate.timestamp - message.timestamp) < 8_000
    }
    return candidate.timestamp === message.timestamp
  })
  return duplicate ? messages : [...messages, message]
}

function findToolIndex(segments: Record<number, LiveSegment>, toolCallId?: string, preferred?: number): number {
  if (preferred != null) return preferred
  const found = Object.entries(segments).find(([, segment]) => segment.type === 'tool' && segment.id === toolCallId)
  if (found) return Number(found[0])
  const indexes = Object.keys(segments).map(Number)
  return indexes.length ? Math.max(...indexes) + 1 : 0
}

function makeTool(existing: LiveSegment | undefined, id = '', name = ''): LiveToolSegment {
  if (existing?.type === 'tool') return { ...existing }
  return { type: 'tool', id, name, argsText: '', output: '', isError: false, complete: false }
}

export function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<BootstrapData>()
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [threads, setThreads] = useState<ThreadRecord[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string>()
  const [runtimes, setRuntimes] = useState<Record<string, ThreadRuntime>>({})
  const [loadingThreadId, setLoadingThreadId] = useState<string>()
  const [fatalError, setFatalError] = useState<string>()
  const [newThreadProjectId, setNewThreadProjectId] = useState<string>()
  const [tabByThread, setTabByThread] = useState<Record<string, ThreadTab>>({})
  const theme = useTheme(bootstrap?.state.settings.theme ?? 'system')

  const loadThread = useCallback(async (threadId: string, restart = false) => {
    setSelectedThreadId(threadId)
    setLoadingThreadId(threadId)
    setFatalError(undefined)
    try {
      await window.codePi.selectThread(threadId)
      const opened = restart ? await window.codePi.restartThread(threadId) : await window.codePi.openThread(threadId)
      setRuntimes((current) => ({ ...current, [threadId]: { ...opened, queuedCount: opened.state.pendingMessageCount } }))
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

  useEffect(() => {
    let cancelled = false
    void window.codePi.bootstrap()
      .then((data) => {
        if (cancelled) return
        setBootstrap(data)
        setProjects(data.state.projects)
        setThreads(data.state.threads)
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
        ? { ...thread, status: event.status, lastError: event.error, updatedAt: now }
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
            const tool = makeTool(live.segments[index], event.toolCallId)
            tool.argsText += event.delta
            return { ...live, segments: { ...live.segments, [index]: tool } }
          })
          break
        case 'tool-call-end':
          withLive((live) => {
            const index = findToolIndex(live.segments, event.toolCallId)
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
          next = { ...runtime, live: undefined, state: { ...runtime.state, isStreaming: false }, queuedCount: 0 }
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
  }), [])

  const addProject = useCallback(async (): Promise<ProjectRecord | undefined> => {
    const project = await window.codePi.addProject()
    if (!project) return undefined
    setProjects((current) => current.some((item) => item.id === project.id) ? current : [...current, project])
    return project
  }, [])

  const beginNewThread = useCallback(async (projectId?: string) => {
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
  }), [addProject, beginNewThread])

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId)
  const runtime = selectedThreadId ? runtimes[selectedThreadId] : undefined
  const selectedProject = projects.find((project) => project.id === selectedThread?.projectId)
  const newThreadProject = projects.find((project) => project.id === newThreadProjectId)
  const selectedTab = selectedThreadId ? tabByThread[selectedThreadId] ?? 'transcript' : 'transcript'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || selectedThread?.status !== 'running') return
      event.preventDefault()
      void window.codePi.abortThread(selectedThread.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedThread])

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
          <p>Give Pi an isolated workspace and let it work while you move on to another task.</p>
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
          <button className="button button-primary" onClick={() => void loadThread(selectedThread.id, true)}>
            <RefreshCw size={13} /> Restart Pi
          </button>
        </div>
      )
    }
    if (!runtime || loadingThreadId === selectedThread.id) {
      return <div className="thread-loading"><span className="spinner" /> Opening {selectedThread.title}…</div>
    }
    return (
      <div className="thread-view">
        <ThreadHeader
          thread={selectedThread}
          tree={runtime.tree}
          isGit={Boolean(selectedProject?.isGit)}
          tab={selectedTab}
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
                  <button className="button button-secondary compact" onClick={() => void loadThread(selectedThread.id, true)}>
                    <RefreshCw size={12} /> Restart
                  </button>
                </div>
              )}
            </div>
            <Transcript messages={runtime.messages} live={runtime.live} theme={theme} running={selectedThread.status === 'running'} />
            <Composer
              status={selectedThread.status}
              queuedCount={runtime.queuedCount}
              model={runtime.state.model}
              models={runtime.models}
              thinkingLevel={runtime.state.thinkingLevel}
              onAbort={() => void window.codePi.abortThread(selectedThread.id)}
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
              onSend={async (text: string, mode: DeliveryMode) => {
                const optimistic = mode !== 'followUp'
                const message: AgentMessage = { role: 'user', content: text, timestamp: Date.now() }
                if (optimistic) {
                  setRuntimes((current) => ({ ...current, [selectedThread.id]: { ...current[selectedThread.id], messages: appendMessage(current[selectedThread.id].messages, message) } }))
                } else {
                  setRuntimes((current) => ({ ...current, [selectedThread.id]: { ...current[selectedThread.id], queuedCount: current[selectedThread.id].queuedCount + 1 } }))
                }
                try {
                  await window.codePi.sendMessage(selectedThread.id, text, mode)
                } catch (reason) {
                  if (optimistic) {
                    setRuntimes((current) => ({ ...current, [selectedThread.id]: { ...current[selectedThread.id], messages: current[selectedThread.id].messages.filter((item) => item !== message) } }))
                  }
                  throw reason
                }
              }}
            />
          </div>
        ) : (
          <ChangesView
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
    loadingThreadId,
    projects.length,
    runtime,
    selectedTab,
    selectedThread,
    theme,
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
        onDeleteThread={(thread) => {
          if (!window.confirm(`Delete “${thread.title}”?${thread.worktree ? '\n\nIts isolated worktree will also be removed.' : ''}`)) return
          void window.codePi.deleteThread(thread.id).then(() => {
            setThreads((current) => current.filter((item) => item.id !== thread.id))
            setRuntimes((current) => {
              const next = { ...current }
              delete next[thread.id]
              return next
            })
            if (selectedThreadId === thread.id) {
              setSelectedThreadId(undefined)
              void window.codePi.selectThread(undefined)
            }
          })
        }}
        onOpenSettings={() => void window.codePi.openSettings()}
      />
      <main className="main-pane">{shell}</main>
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
