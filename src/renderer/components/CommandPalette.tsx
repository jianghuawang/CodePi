import {
  Archive,
  FileSearch,
  FolderPlus,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectRecord, ThreadRecord, ThreadSearchResult } from '../../shared/contracts'

type ActionResult = unknown | Promise<unknown>

export interface CommandPaletteAction {
  id: string
  label: string
  detail?: string
  keywords?: string[]
  shortcut?: string
  disabled?: boolean
  run: () => ActionResult
}

export interface CommandPaletteProps {
  open: boolean
  projects: ProjectRecord[]
  threads: ThreadRecord[]
  selectedThreadId?: string
  actions?: CommandPaletteAction[]
  searchResults?: ThreadSearchResult[]
  searching?: boolean
  onQueryChange?: (query: string) => void
  onRequestOpen?: () => void
  onClose: () => void
  onSelectThread: (threadId: string) => ActionResult
  onNewThread: (projectId?: string) => ActionResult
  onAddProject: () => ActionResult
  onOpenSettings: () => ActionResult
}

interface PaletteEntry {
  id: string
  group: 'Actions' | 'Threads' | 'Transcript matches'
  label: string
  detail?: string
  searchText: string
  shortcut?: string
  icon: React.ReactNode
  disabled?: boolean
  run: () => ActionResult
}

function scoreMatch(searchText: string, query: string): number {
  if (!query) return 1
  const source = searchText.toLocaleLowerCase()
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  let score = 0
  for (const term of terms) {
    const index = source.indexOf(term)
    if (index < 0) return -1
    score += index === 0 ? 30 : Math.max(2, 18 - index)
  }
  return score
}

export function CommandPalette({
  open,
  projects,
  threads,
  selectedThreadId,
  actions = [],
  searchResults = [],
  searching = false,
  onQueryChange,
  onRequestOpen,
  onClose,
  onSelectThread,
  onNewThread,
  onAddProject,
  onOpenSettings,
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const deferredQuery = useDeferredValue(query.trim())

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        if (open) onClose()
        else onRequestOpen?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, onRequestOpen, open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setError(undefined)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (open) onQueryChange?.(deferredQuery)
  }, [deferredQuery, onQueryChange, open])

  const entries = useMemo(() => {
    const selectedThread = threads.find((thread) => thread.id === selectedThreadId)
    const selectedProjectId = selectedThread?.projectId ?? projects[0]?.id
    const projectById = new Map(projects.map((project) => [project.id, project]))

    const actionEntries: PaletteEntry[] = [
      {
        id: 'action:new-thread',
        group: 'Actions',
        label: 'New thread',
        detail: selectedProjectId ? `in ${projectById.get(selectedProjectId)?.name ?? 'current project'}` : undefined,
        searchText: 'new thread task conversation',
        shortcut: '⌘N',
        icon: <Plus size={14} aria-hidden="true" />,
        run: () => onNewThread(selectedProjectId),
      },
      {
        id: 'action:add-project',
        group: 'Actions',
        label: 'Add project folder',
        searchText: 'new add open project folder workspace',
        shortcut: '⇧⌘N',
        icon: <FolderPlus size={14} aria-hidden="true" />,
        run: onAddProject,
      },
      {
        id: 'action:settings',
        group: 'Actions',
        label: 'Open Settings',
        searchText: 'preferences settings configuration',
        shortcut: '⌘,',
        icon: <Settings size={14} aria-hidden="true" />,
        run: onOpenSettings,
      },
      ...actions.map((action): PaletteEntry => ({
        id: `custom:${action.id}`,
        group: 'Actions',
        label: action.label,
        detail: action.detail,
        searchText: [action.label, action.detail, ...(action.keywords ?? [])].filter(Boolean).join(' '),
        shortcut: action.shortcut,
        icon: <Sparkles size={14} aria-hidden="true" />,
        disabled: action.disabled,
        run: action.run,
      })),
      ...projects.map((project): PaletteEntry => ({
        id: `project:${project.id}`,
        group: 'Actions',
        label: `New thread in ${project.name}`,
        detail: project.path,
        searchText: `new thread project ${project.name} ${project.path}`,
        icon: <Plus size={14} aria-hidden="true" />,
        run: () => onNewThread(project.id),
      })),
    ]

    const threadEntries = threads
      .filter((thread) => thread.deletedAt == null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((thread): PaletteEntry => {
        const project = projectById.get(thread.projectId)
        const state = thread.archived ? 'Archived' : thread.status === 'running' ? 'Running' : undefined
        return {
          id: `thread:${thread.id}`,
          group: 'Threads',
          label: thread.title,
          detail: [project?.name, state, ...thread.tags].filter(Boolean).join(' · '),
          searchText: [thread.title, project?.name, thread.cwd, state, ...thread.tags].filter(Boolean).join(' '),
          icon: thread.archived
            ? <Archive size={14} aria-hidden="true" />
            : <MessageSquare size={14} aria-hidden="true" />,
          run: () => onSelectThread(thread.id),
        }
      })

    const remoteEntries = deferredQuery.length < 2
      ? []
      : searchResults.map((result): PaletteEntry => ({
        id: `search:${result.threadId}:${result.timestamp}`,
        group: 'Transcript matches',
        label: result.title,
        detail: result.snippet,
        searchText: `${result.title} ${result.snippet}`,
        icon: <FileSearch size={14} aria-hidden="true" />,
        run: () => onSelectThread(result.threadId),
      }))

    const groupOrder: Record<PaletteEntry['group'], number> = { Actions: 0, Threads: 1, 'Transcript matches': 2 }
    return [...actionEntries, ...threadEntries, ...remoteEntries]
      .map((entry, order) => ({ entry, order, score: scoreMatch(entry.searchText, deferredQuery) }))
      .filter(({ score }) => score >= 0)
      .sort((left, right) => groupOrder[left.entry.group] - groupOrder[right.entry.group] || right.score - left.score || left.order - right.order)
      .map(({ entry }) => entry)
      .slice(0, 60)
  }, [actions, deferredQuery, onAddProject, onNewThread, onOpenSettings, onSelectThread, projects, searchResults, selectedThreadId, threads])

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(entries.length - 1, 0)))
  }, [entries.length])

  if (!open) return null

  const execute = async (entry: PaletteEntry | undefined): Promise<void> => {
    if (!entry || entry.disabled) return
    try {
      await entry.run()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  let previousGroup: PaletteEntry['group'] | undefined

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-palette-input-row">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search threads or run a command"
            aria-label="Search threads or run a command"
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
              setError(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((current) => entries.length ? (current + 1) % entries.length : 0)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((current) => entries.length ? (current - 1 + entries.length) % entries.length : 0)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                void execute(entries[activeIndex])
              }
            }}
          />
          <kbd>esc</kbd>
        </div>

        <div className="command-palette-results" role="listbox" aria-label="Commands and threads">
          {entries.map((entry, index) => {
            const showGroup = entry.group !== previousGroup
            previousGroup = entry.group
            return (
              <div className="command-palette-entry-wrap" key={entry.id}>
                {showGroup ? <div className="command-palette-group-label">{entry.group}</div> : null}
                <button
                  className={`command-palette-entry ${index === activeIndex ? 'is-active' : ''}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  disabled={entry.disabled}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => void execute(entry)}
                >
                  <span className="command-palette-entry-icon">{entry.icon}</span>
                  <span className="command-palette-entry-copy">
                    <span className="command-palette-entry-title">{entry.label}</span>
                    {entry.detail ? <span className="command-palette-entry-detail">{entry.detail}</span> : null}
                  </span>
                  {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
                </button>
              </div>
            )
          })}

          {entries.length === 0 ? (
            <div className="command-palette-empty" role="status">
              {searching ? <span className="spinner" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
              <span>{searching ? 'Searching transcripts…' : 'No threads or commands found'}</span>
            </div>
          ) : null}
        </div>

        {error ? <div className="command-palette-error" role="alert">{error}</div> : null}
        <footer className="command-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
        </footer>
      </section>
    </div>
  )
}
