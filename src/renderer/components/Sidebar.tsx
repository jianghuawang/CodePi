import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Folder,
  FolderPlus,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { ProjectRecord, ThreadRecord } from '../../shared/contracts'
import { useRelativeTime } from '../hooks/useRelativeTime'
import { ThreadActionsMenu, type ThreadActionCallbacks } from './ThreadActionsMenu'

export type SidebarFilter = 'all' | 'running' | 'unread'

export interface SidebarProps extends ThreadActionCallbacks {
  projects: ProjectRecord[]
  threads: ThreadRecord[]
  selectedThreadId?: string
  onAddProject: () => void
  onToggleProject: (projectId: string, expanded: boolean) => void
  onSelectThread: (threadId: string) => void
  onNewThread: (projectId: string) => void
  /** Compatibility alias; new integrations should use onTrashThread. */
  onDeleteThread?: (thread: ThreadRecord) => void
  onOpenSettings: () => void
  onOpenCommandPalette?: () => void
  onSearchQueryChange?: (query: string) => void
}

interface ThreadItemProps extends ThreadActionCallbacks {
  thread: ThreadRecord
  projectName?: string
  selected: boolean
  onSelect?: () => void
}

function StatusDot({ status }: { status: ThreadRecord['status'] }): React.JSX.Element {
  return <span className={`status-dot status-${status}`} title={status} aria-label={status} />
}

function ThreadItem({
  thread,
  projectName,
  selected,
  onSelect,
  ...actions
}: ThreadItemProps): React.JSX.Element {
  const relativeTime = useRelativeTime(thread.deletedAt ?? thread.updatedAt)
  const deleted = thread.deletedAt != null

  return (
    <div
      className={[
        'thread-item-wrap',
        selected ? 'is-selected' : '',
        thread.unread ? 'is-unread' : '',
        thread.archived ? 'is-archived' : '',
        deleted ? 'is-trashed' : '',
      ].filter(Boolean).join(' ')}
    >
      <button
        className="thread-item"
        type="button"
        onClick={onSelect}
        disabled={!onSelect}
        aria-current={selected ? 'page' : undefined}
        title={deleted ? `${thread.title} (in Trash)` : thread.title}
      >
        <StatusDot status={thread.status} />
        <span className="thread-item-copy">
          <span className="thread-item-title-row">
            <span className="thread-title">{thread.title}</span>
            {thread.unread ? <span className="thread-unread-dot" aria-label="Unread" /> : null}
          </span>
          {projectName || thread.tags.length > 0 ? (
            <span className="thread-item-meta">
              {projectName ? <span className="thread-project-name">{projectName}</span> : null}
              {thread.tags.slice(0, 2).map((tag) => <span className="thread-tag" key={tag}>{tag}</span>)}
              {thread.tags.length > 2 ? <span className="thread-tag-more">+{thread.tags.length - 2}</span> : null}
            </span>
          ) : null}
        </span>
        <span className="thread-time">{relativeTime}</span>
      </button>
      <ThreadActionsMenu thread={thread} compact {...actions} />
    </div>
  )
}

function LifecycleSection({
  title,
  icon,
  open,
  threads,
  projectById,
  selectedThreadId,
  onToggle,
  onSelectThread,
  actions,
}: {
  title: string
  icon: React.ReactNode
  open: boolean
  threads: ThreadRecord[]
  projectById: Map<string, ProjectRecord>
  selectedThreadId?: string
  onToggle: () => void
  onSelectThread?: (threadId: string) => void
  actions: ThreadActionCallbacks
}): React.JSX.Element | null {
  if (threads.length === 0) return null

  return (
    <section className={`sidebar-lifecycle-section lifecycle-${title.toLocaleLowerCase()}`}>
      <button className="sidebar-lifecycle-heading" type="button" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        {icon}
        <span>{title}</span>
        <span className="sidebar-section-count">{threads.length}</span>
      </button>
      {open ? (
        <div className="sidebar-lifecycle-list">
          {threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              projectName={projectById.get(thread.projectId)?.name}
              selected={thread.id === selectedThreadId}
              onSelect={onSelectThread && thread.deletedAt == null ? () => onSelectThread(thread.id) : undefined}
              {...actions}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function threadMatches(
  thread: ThreadRecord,
  query: string,
  filter: SidebarFilter,
  projectById: Map<string, ProjectRecord>,
): boolean {
  if (filter === 'running' && thread.status !== 'running') return false
  if (filter === 'unread' && !thread.unread) return false
  if (!query) return true
  const project = projectById.get(thread.projectId)
  const haystack = [thread.title, project?.name, thread.cwd, ...thread.tags].filter(Boolean).join(' ').toLocaleLowerCase()
  return query.split(/\s+/).every((part) => haystack.includes(part))
}

export function Sidebar({
  projects,
  threads,
  selectedThreadId,
  onAddProject,
  onToggleProject,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onOpenSettings,
  onOpenCommandPalette,
  onSearchQueryChange,
  onRenameThread,
  onDuplicateThread,
  onSetThreadArchived,
  onSetThreadPinned,
  onSetThreadUnread,
  onSetThreadTags,
  onExportThread,
  onTrashThread,
  onRestoreThread,
  onPurgeThread,
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SidebarFilter>('all')
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const matching = useMemo(
    () => threads.filter((thread) => threadMatches(thread, deferredQuery, filter, projectById)),
    [deferredQuery, filter, projectById, threads],
  )
  const sorted = useMemo(
    () => [...matching].sort((left, right) => right.updatedAt - left.updatedAt),
    [matching],
  )

  const pinnedThreads = sorted.filter((thread) => thread.pinned && !thread.archived && thread.deletedAt == null)
  const activeThreads = sorted.filter((thread) => !thread.pinned && !thread.archived && thread.deletedAt == null)
  const archivedThreads = sorted.filter((thread) => thread.archived && thread.deletedAt == null)
  const trashedThreads = sorted
    .filter((thread) => thread.deletedAt != null)
    .sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0))
  const searching = deferredQuery.length > 0 || filter !== 'all'

  const actions: ThreadActionCallbacks = {
    onRenameThread,
    onDuplicateThread,
    onSetThreadArchived,
    onSetThreadPinned,
    onSetThreadUnread,
    onSetThreadTags,
    onExportThread,
    onTrashThread: onTrashThread ?? onDeleteThread,
    onRestoreThread,
    onPurgeThread,
  }

  const updateQuery = (value: string) => {
    setQuery(value)
    onSearchQueryChange?.(value)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar drag-region">
        <div className="sidebar-brand">CodePi</div>
        <button className="icon-button no-drag" type="button" onClick={onAddProject} title="Add project" aria-label="Add project">
          <FolderPlus size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-search-row">
        <div className="sidebar-search-field">
          <Search size={12} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) updateQuery('')
            }}
            placeholder="Search threads"
            aria-label="Search threads"
          />
          {query ? (
            <button type="button" onClick={() => updateQuery('')} aria-label="Clear search" title="Clear search">
              <X size={11} aria-hidden="true" />
            </button>
          ) : onOpenCommandPalette ? (
            <button type="button" onClick={onOpenCommandPalette} aria-label="Open command palette" title="Command palette">
              <span className="shortcut">⌘K</span>
            </button>
          ) : null}
        </div>
        <div className="sidebar-filter-tabs" role="group" aria-label="Filter threads">
          {(['all', 'running', 'unread'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : ''}
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
            >
              {value === 'all' ? 'All' : value === 'running' ? 'Running' : 'Unread'}
            </button>
          ))}
        </div>
      </div>

      <nav className="project-list" aria-label="Projects and threads">
        {projects.length === 0 ? (
          <button className="sidebar-empty" type="button" onClick={onAddProject}>
            <Folder size={20} strokeWidth={1.4} aria-hidden="true" />
            <span>Add a project folder</span>
          </button>
        ) : null}

        <LifecycleSection
          title="Pinned"
          icon={<Pin size={12} aria-hidden="true" />}
          open={pinnedOpen || searching}
          threads={pinnedThreads}
          projectById={projectById}
          selectedThreadId={selectedThreadId}
          onToggle={() => setPinnedOpen((current) => !current)}
          onSelectThread={onSelectThread}
          actions={actions}
        />

        <section className="sidebar-projects-section">
          <div className="sidebar-section-heading">
            <span>Projects</span>
            <button className="icon-button" type="button" onClick={onAddProject} title="Add project" aria-label="Add project">
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>

          {projects.map((project) => {
            const projectThreads = activeThreads.filter((thread) => thread.projectId === project.id)
            if (searching && projectThreads.length === 0) return null
            return (
              <section className="project-group" key={project.id}>
                <div className="project-row">
                  <button
                    className="project-toggle"
                    type="button"
                    onClick={() => onToggleProject(project.id, !project.expanded)}
                    title={project.path}
                    aria-expanded={project.expanded || searching}
                  >
                    {project.expanded || searching ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                    <span>{project.name}</span>
                    {projectThreads.some((thread) => thread.status === 'running') ? <CircleDot className="project-running-mark" size={10} aria-label="Has running threads" /> : null}
                  </button>
                  <button
                    className="project-new-thread"
                    type="button"
                    onClick={() => onNewThread(project.id)}
                    title={`New thread in ${project.name}`}
                    aria-label={`New thread in ${project.name}`}
                  >
                    <Plus size={13} aria-hidden="true" />
                  </button>
                </div>
                {project.expanded || searching ? (
                  <div className="thread-list">
                    {projectThreads.map((thread) => (
                      <ThreadItem
                        key={thread.id}
                        thread={thread}
                        selected={thread.id === selectedThreadId}
                        onSelect={() => onSelectThread(thread.id)}
                        {...actions}
                      />
                    ))}
                    {projectThreads.length === 0 && !searching ? (
                      <button className="new-thread-inline" type="button" onClick={() => onNewThread(project.id)}>
                        <Plus size={12} aria-hidden="true" /> New thread
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            )
          })}
        </section>

        <LifecycleSection
          title="Archived"
          icon={<Archive size={12} aria-hidden="true" />}
          open={archivedOpen || searching}
          threads={archivedThreads}
          projectById={projectById}
          selectedThreadId={selectedThreadId}
          onToggle={() => setArchivedOpen((current) => !current)}
          onSelectThread={onSelectThread}
          actions={actions}
        />

        <LifecycleSection
          title="Trash"
          icon={<Trash2 size={12} aria-hidden="true" />}
          open={trashOpen || searching}
          threads={trashedThreads}
          projectById={projectById}
          selectedThreadId={selectedThreadId}
          onToggle={() => setTrashOpen((current) => !current)}
          actions={actions}
        />

        {projects.length > 0 && matching.length === 0 && searching ? (
          <div className="sidebar-no-results" role="status">
            <Search size={15} aria-hidden="true" />
            <span>No matching threads</span>
          </div>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        {onOpenCommandPalette ? (
          <button className="sidebar-footer-button" type="button" onClick={onOpenCommandPalette}>
            <Search size={14} aria-hidden="true" />
            <span>Command Palette</span>
            <span className="shortcut">⌘K</span>
          </button>
        ) : null}
        <button className="sidebar-footer-button" type="button" onClick={onOpenSettings}>
          <Settings size={14} aria-hidden="true" />
          <span>Settings</span>
          <span className="shortcut">⌘,</span>
        </button>
      </div>
    </aside>
  )
}
