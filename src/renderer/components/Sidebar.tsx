import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react'
import type { ProjectRecord, ThreadRecord } from '../../shared/contracts'
import { useRelativeTime } from '../hooks/useRelativeTime'

interface SidebarProps {
  projects: ProjectRecord[]
  threads: ThreadRecord[]
  selectedThreadId?: string
  onAddProject: () => void
  onToggleProject: (projectId: string, expanded: boolean) => void
  onSelectThread: (threadId: string) => void
  onNewThread: (projectId: string) => void
  onDeleteThread: (thread: ThreadRecord) => void
  onOpenSettings: () => void
}

function StatusDot({ status }: { status: ThreadRecord['status'] }): React.JSX.Element {
  return <span className={`status-dot status-${status}`} title={status} aria-label={status} />
}

function ThreadItem({
  thread,
  selected,
  onSelect,
  onDelete,
}: {
  thread: ThreadRecord
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}): React.JSX.Element {
  const relativeTime = useRelativeTime(thread.updatedAt)
  return (
    <div className={`thread-item-wrap ${selected ? 'is-selected' : ''}`}>
      <button className="thread-item" onClick={onSelect} aria-current={selected ? 'page' : undefined}>
        <StatusDot status={thread.status} />
        <span className="thread-title">{thread.title}</span>
        <span className="thread-time">{relativeTime}</span>
      </button>
      <button className="thread-more" onClick={onDelete} aria-label={`Delete ${thread.title}`} title="Delete thread">
        <Trash2 size={12} aria-hidden="true" />
      </button>
    </div>
  )
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
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar drag-region">
        <div className="sidebar-brand">CodePi</div>
        <button className="icon-button no-drag" onClick={onAddProject} title="Add project" aria-label="Add project">
          <FolderPlus size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="sidebar-section-heading">
        <span>Projects</span>
        <button className="icon-button" onClick={onAddProject} title="Add project" aria-label="Add project">
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      <nav className="project-list" aria-label="Projects and threads">
        {projects.length === 0 && (
          <button className="sidebar-empty" onClick={onAddProject}>
            <Folder size={20} strokeWidth={1.4} aria-hidden="true" />
            <span>Add a project folder</span>
          </button>
        )}
        {projects.map((project) => {
          const projectThreads = threads
            .filter((thread) => thread.projectId === project.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)
          return (
            <section className="project-group" key={project.id}>
              <div className="project-row">
                <button
                  className="project-toggle"
                  onClick={() => onToggleProject(project.id, !project.expanded)}
                  title={project.path}
                  aria-expanded={project.expanded}
                >
                  {project.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{project.name}</span>
                </button>
                <button
                  className="project-new-thread"
                  onClick={() => onNewThread(project.id)}
                  title={`New thread in ${project.name}`}
                  aria-label={`New thread in ${project.name}`}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              </div>
              {project.expanded && (
                <div className="thread-list">
                  {projectThreads.map((thread) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      selected={thread.id === selectedThreadId}
                      onSelect={() => onSelectThread(thread.id)}
                      onDelete={() => onDeleteThread(thread)}
                    />
                  ))}
                  {projectThreads.length === 0 && (
                    <button className="new-thread-inline" onClick={() => onNewThread(project.id)}>
                      <Plus size={12} aria-hidden="true" /> New thread
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-footer-button" onClick={onOpenSettings}>
          <Settings size={14} aria-hidden="true" />
          <span>Settings</span>
          <span className="shortcut">⌘,</span>
        </button>
      </div>
    </aside>
  )
}
