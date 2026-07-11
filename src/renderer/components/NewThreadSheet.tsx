import { GitBranch, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CreateThreadInput, ProjectRecord } from '../../shared/contracts'

interface NewThreadSheetProps {
  project: ProjectRecord
  onClose: () => void
  onCreate: (input: CreateThreadInput) => Promise<void>
}

export function NewThreadSheet({ project, onClose, onCreate }: NewThreadSheetProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [isolated, setIsolated] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(undefined)
    try {
      await onCreate({ projectId: project.id, title: title.trim() || undefined, isolated: project.isGit && isolated })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="new-thread-sheet" role="dialog" aria-modal="true" aria-labelledby="new-thread-title">
        <div className="sheet-header">
          <div>
            <h2 id="new-thread-title">New thread</h2>
            <p>{project.name}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="thread-name">Name <span>Optional</span></label>
          <input
            id="thread-name"
            ref={inputRef}
            className="text-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What are you working on?"
          />

          {project.isGit && (
            <label className="isolation-option">
              <span className="toggle-copy">
                <span className="toggle-title"><GitBranch size={14} /> Run in isolated worktree</span>
                <span className="toggle-description">Keep changes separate from your current branch.</span>
              </span>
              <input
                type="checkbox"
                checked={isolated}
                onChange={(event) => setIsolated(event.target.checked)}
                aria-label="Run in isolated worktree"
              />
              <span className="switch" aria-hidden="true" />
            </label>
          )}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="sheet-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create thread'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
