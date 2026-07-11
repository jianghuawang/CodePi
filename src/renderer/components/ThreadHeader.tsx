import { Activity, ExternalLink, GitBranch, History, PanelRight, TerminalSquare } from 'lucide-react'
import { useRef, useState } from 'react'
import type { SessionState, SessionStats, SessionTreeNode, ThreadRecord } from '../../shared/contracts'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { UsageDashboardPopover } from './UsageDashboardPopover'

export type ThreadTab = 'transcript' | 'changes'

interface ThreadHeaderProps {
  thread: ThreadRecord
  tree: SessionTreeNode[]
  isGit: boolean
  projectId: string
  state: SessionState
  stats?: SessionStats
  tab: ThreadTab
  workspaceOpen: boolean
  terminalOpen: boolean
  onTabChange: (tab: ThreadTab) => void
  onLoadHistory: () => Promise<void>
  onBranch: (entryId: string) => Promise<void>
  onOpenEditor: () => void
  onToggleWorkspace: () => void
  onToggleTerminal: () => void
  onStateChange: (state: SessionState) => void
  onStatsChange: (stats: SessionStats | undefined) => void
}

function messageLabel(node: SessionTreeNode): string {
  if (node.label) return node.label
  const message = node.entry.message
  if (!message) return node.entry.type.replaceAll('_', ' ')
  if (message.role === 'user') {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.find((item) => item.type === 'text')?.text
    return text?.replace(/\s+/g, ' ').slice(0, 72) || 'User message'
  }
  if (message.role === 'assistant') {
    const text = message.content.find((item) => item.type === 'text')
    return text?.type === 'text' ? text.text.replace(/\s+/g, ' ').slice(0, 72) : 'Assistant response'
  }
  if (message.role === 'toolResult') return `${message.toolName} result`
  if (message.role === 'bashExecution') return message.command
  if (message.role === 'custom') return message.customType || 'Extension message'
  if (message.role === 'branchSummary') return 'Branch summary'
  return 'Compaction summary'
}

function HistoryNode({ node, depth, onBranch }: { node: SessionTreeNode; depth: number; onBranch: (id: string) => void }): React.JSX.Element {
  const canBranch = Boolean(node.entry.message)
  return (
    <>
      <button
        className={`history-node ${canBranch ? '' : 'is-passive'}`}
        style={{ paddingLeft: `${12 + depth * 15}px` }}
        onClick={() => canBranch && onBranch(node.entry.id)}
        disabled={!canBranch}
        title={canBranch ? 'Branch into a new thread from here' : undefined}
      >
        <span className="history-rail" style={{ left: `${15 + depth * 15}px` }} aria-hidden="true" />
        <span className={`history-node-dot ${node.children.length > 1 ? 'is-branch' : ''}`} />
        <span className="history-node-copy">
          <span>{messageLabel(node)}</span>
          {node.labelTimestamp && <time>{node.labelTimestamp}</time>}
        </span>
      </button>
      {node.children.map((child) => (
        <HistoryNode key={child.entry.id} node={child} depth={depth + 1} onBranch={onBranch} />
      ))}
    </>
  )
}

export function ThreadHeader({
  thread,
  tree,
  isGit,
  projectId,
  state,
  stats,
  tab,
  workspaceOpen,
  terminalOpen,
  onTabChange,
  onLoadHistory,
  onBranch,
  onOpenEditor,
  onToggleWorkspace,
  onToggleTerminal,
  onStateChange,
  onStatsChange,
}: ThreadHeaderProps): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string>()
  const [usageOpen, setUsageOpen] = useState(false)
  const historyRef = useRef<HTMLDivElement>(null)
  useOutsideClick(historyRef, () => setHistoryOpen(false), historyOpen)

  const openHistory = async () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (!next) return
    setHistoryError(undefined)
    setHistoryLoading(true)
    try {
      await onLoadHistory()
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryLoading(false)
    }
  }

  const branchFromHistory = async (entryId: string) => {
    setHistoryError(undefined)
    setHistoryLoading(true)
    try {
      await onBranch(entryId)
      setHistoryOpen(false)
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setHistoryLoading(false)
    }
  }

  return (
    <header className="thread-header">
      <div className="thread-titlebar drag-region">
        <div className="thread-heading no-drag">
          <div className="thread-heading-row">
            <h1>{thread.title}</h1>
            {thread.worktree && <span className="worktree-badge"><GitBranch size={11} /> {thread.worktree.branch}</span>}
          </div>
          <div className="thread-cwd" title={thread.cwd}>{thread.cwd}</div>
        </div>
        <div className="thread-actions no-drag">
          <div className="usage-dashboard-wrap">
            <button className={`header-button ${usageOpen ? 'is-active' : ''}`} onClick={() => setUsageOpen((open) => !open)}>
              <Activity size={13} />
              {stats?.contextUsage?.percent == null ? 'Usage' : `${Math.round(stats.contextUsage.percent)}%`}
            </button>
            {usageOpen && (
              <UsageDashboardPopover
                threadId={thread.id}
                projectId={projectId}
                state={state}
                stats={stats}
                onStateChange={onStateChange}
                onStatsChange={onStatsChange}
                onClose={() => setUsageOpen(false)}
              />
            )}
          </div>
          <div className="history-wrap" ref={historyRef}>
            <button className={`header-button ${historyOpen ? 'is-active' : ''}`} onClick={() => void openHistory()}>
              <History size={13} /> History
            </button>
            {historyOpen && (
              <div className="history-popover" role="dialog" aria-label="Session history">
                <div className="popover-heading">
                  <div>
                    <strong>Session history</strong>
                    <span>Choose a prompt to branch from it.</span>
                  </div>
                  <GitBranch size={14} aria-hidden="true" />
                </div>
                <div className="history-tree">
                  {historyError && <div className="popover-error" role="alert">{historyError}</div>}
                  {historyLoading && tree.length === 0 && <div className="popover-empty">Loading history…</div>}
                  {!historyLoading && !historyError && tree.length === 0 && <div className="popover-empty">No earlier messages yet.</div>}
                  {tree.map((node) => (
                    <HistoryNode
                      key={node.entry.id}
                      node={node}
                      depth={0}
                      onBranch={(entryId) => void branchFromHistory(entryId)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="header-button icon-only" onClick={onOpenEditor} title="Open in editor" aria-label="Open in editor">
            <ExternalLink size={14} />
          </button>
          <button className={`header-button icon-only ${terminalOpen ? 'is-active' : ''}`} onClick={onToggleTerminal} title="Terminal" aria-label="Toggle terminal">
            <TerminalSquare size={14} />
          </button>
          <button className={`header-button icon-only ${workspaceOpen ? 'is-active' : ''}`} onClick={onToggleWorkspace} title="Workspace tools" aria-label="Toggle workspace tools">
            <PanelRight size={14} />
          </button>
        </div>
      </div>
      <div className="thread-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'transcript'} className={tab === 'transcript' ? 'is-active' : ''} onClick={() => onTabChange('transcript')}>
          Transcript
        </button>
        {isGit && (
          <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'is-active' : ''} onClick={() => onTabChange('changes')}>
            Changes
          </button>
        )}
      </div>
    </header>
  )
}
