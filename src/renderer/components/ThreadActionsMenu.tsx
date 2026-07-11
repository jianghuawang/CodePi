import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  MoreHorizontal,
  Pin,
  PinOff,
  RotateCcw,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ExportFormat, ThreadRecord } from '../../shared/contracts'
import { normalizeTagInput } from '../../shared/tags'

type ActionResult = unknown | Promise<unknown>

export interface ThreadActionCallbacks {
  onRenameThread?: (thread: ThreadRecord, title: string) => ActionResult
  onDuplicateThread?: (thread: ThreadRecord) => ActionResult
  onSetThreadArchived?: (thread: ThreadRecord, archived: boolean) => ActionResult
  onSetThreadPinned?: (thread: ThreadRecord, pinned: boolean) => ActionResult
  onSetThreadUnread?: (thread: ThreadRecord, unread: boolean) => ActionResult
  onSetThreadTags?: (thread: ThreadRecord, tags: string[]) => ActionResult
  onExportThread?: (thread: ThreadRecord, format: ExportFormat) => ActionResult
  onTrashThread?: (thread: ThreadRecord) => ActionResult
  onRestoreThread?: (thread: ThreadRecord) => ActionResult
  onPurgeThread?: (thread: ThreadRecord) => ActionResult
}

interface ThreadActionsMenuProps extends ThreadActionCallbacks {
  thread: ThreadRecord
  align?: 'start' | 'end'
  compact?: boolean
}

type EditorMode = 'rename' | 'tags'

export function ThreadActionsMenu({
  thread,
  align = 'end',
  compact = false,
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
}: ThreadActionsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [editor, setEditor] = useState<EditorMode>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (editor) setEditor(undefined)
        else setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [editor, open])

  useEffect(() => {
    if (editor) inputRef.current?.focus()
  }, [editor])

  const run = async (action: () => ActionResult, closeAfter = true): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      if (closeAfter) setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const beginEdit = (mode: EditorMode) => {
    setEditor(mode)
    setDraft(mode === 'rename' ? thread.title : thread.tags.join(', '))
    setError(undefined)
  }

  const submitEditor = async (): Promise<void> => {
    if (editor === 'rename') {
      const title = draft.trim()
      if (!title || !onRenameThread) return
      await run(() => onRenameThread(thread, title))
      return
    }
    if (editor === 'tags' && onSetThreadTags) {
      await run(() => onSetThreadTags(thread, normalizeTagInput(draft)))
    }
  }

  const hasPrimaryActions = Boolean(
    onRenameThread
    || onDuplicateThread
    || onSetThreadArchived
    || onSetThreadPinned
    || onSetThreadUnread
    || onSetThreadTags,
  )

  const hasExport = Boolean(onExportThread)
  const deleted = thread.deletedAt != null

  return (
    <div className={`thread-actions ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        className={`thread-more ${compact ? 'is-compact' : ''}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
          setEditor(undefined)
          setError(undefined)
        }}
        onContextMenu={(event) => event.preventDefault()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${thread.title}`}
        title="Thread actions"
      >
        <MoreHorizontal size={13} aria-hidden="true" />
      </button>

      {open ? (
        <div
          className={`thread-actions-popover align-${align}`}
          role="menu"
          aria-label={`Actions for ${thread.title}`}
          onClick={(event) => event.stopPropagation()}
        >
          {editor ? (
            <form
              className="thread-action-editor"
              onSubmit={(event) => {
                event.preventDefault()
                void submitEditor()
              }}
            >
              <div className="thread-action-editor-heading">
                <span>{editor === 'rename' ? 'Rename thread' : 'Edit tags'}</span>
                <button className="menu-icon-button" type="button" onClick={() => setEditor(undefined)} aria-label="Cancel">
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
              <input
                ref={inputRef}
                className="thread-action-input"
                value={draft}
                maxLength={editor === 'rename' ? 120 : 240}
                placeholder={editor === 'rename' ? 'Thread name' : 'frontend, bug, follow-up'}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={editor === 'rename' ? 'Thread name' : 'Comma-separated tags'}
              />
              {editor === 'tags' ? <span className="thread-action-hint">Separate tags with commas</span> : null}
              {error ? <span className="thread-action-error" role="alert">{error}</span> : null}
              <button
                className="thread-action-save"
                type="submit"
                disabled={busy || (editor === 'rename' && !draft.trim())}
              >
                <Check size={12} aria-hidden="true" />
                Save
              </button>
            </form>
          ) : deleted ? (
            <>
              {onRestoreThread ? (
                <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onRestoreThread(thread))}>
                  <RotateCcw size={13} aria-hidden="true" /> Restore
                </button>
              ) : null}
              {onPurgeThread ? (
                <button className="thread-action-item is-destructive" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onPurgeThread(thread))}>
                  <Trash2 size={13} aria-hidden="true" /> Delete permanently…
                </button>
              ) : null}
              {error ? <span className="thread-action-error" role="alert">{error}</span> : null}
            </>
          ) : (
            <>
              {hasPrimaryActions ? (
                <div className="thread-action-group">
                  {onRenameThread ? (
                    <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => beginEdit('rename')}>
                      <Edit3 size={13} aria-hidden="true" /> Rename
                    </button>
                  ) : null}
                  {onDuplicateThread ? (
                    <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onDuplicateThread(thread))}>
                      <Copy size={13} aria-hidden="true" /> Duplicate
                    </button>
                  ) : null}
                  {onSetThreadPinned ? (
                    <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onSetThreadPinned(thread, !thread.pinned))}>
                      {thread.pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
                      {thread.pinned ? 'Unpin' : 'Pin'}
                    </button>
                  ) : null}
                  {onSetThreadUnread ? (
                    <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onSetThreadUnread(thread, !thread.unread))}>
                      {thread.unread ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}
                      {thread.unread ? 'Mark as read' : 'Mark as unread'}
                    </button>
                  ) : null}
                  {onSetThreadTags ? (
                    <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => beginEdit('tags')}>
                      <Tag size={13} aria-hidden="true" /> Edit tags
                    </button>
                  ) : null}
                  {onSetThreadArchived ? (
                    <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onSetThreadArchived(thread, !thread.archived))}>
                      {thread.archived ? <ArchiveRestore size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
                      {thread.archived ? 'Unarchive' : 'Archive'}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {hasExport ? (
                <div className="thread-action-group">
                  <div className="thread-action-label">Export</div>
                  <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onExportThread!(thread, 'markdown'))}>
                    <Download size={13} aria-hidden="true" /> Markdown…
                  </button>
                  <button className="thread-action-item" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onExportThread!(thread, 'html'))}>
                    <Download size={13} aria-hidden="true" /> HTML…
                  </button>
                </div>
              ) : null}

              {onTrashThread ? (
                <div className="thread-action-group">
                  <button className="thread-action-item is-destructive" type="button" role="menuitem" disabled={busy} onClick={() => void run(() => onTrashThread(thread))}>
                    <Trash2 size={13} aria-hidden="true" /> Move to Trash
                  </button>
                </div>
              ) : null}
              {error ? <span className="thread-action-error" role="alert">{error}</span> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
