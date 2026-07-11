import {
  Check,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DiffChunk, DiffFile, ThreadRecord } from '../../shared/contracts'
import { highlightDiffLines } from './Markdown'

interface ChangesViewProps {
  thread: ThreadRecord
  theme: 'light' | 'dark'
  onOpenEditor: () => void
  onApplyToMain: () => Promise<void>
}

function languageForFile(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return ({
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json',
    css: 'css', html: 'html', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
    sh: 'bash', zsh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql',
  } as Record<string, string>)[extension] ?? 'text'
}

function displayLine(content: string): string {
  return /^[+\- ]/.test(content) ? content.slice(1) : content
}

function DiffChunkView({ chunk, path, theme }: { chunk: DiffChunk; path: string; theme: 'light' | 'dark' }): React.JSX.Element {
  const plainLines = useMemo(() => chunk.changes.map((line) => displayLine(line.content)), [chunk])
  const [highlighted, setHighlighted] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    setHighlighted([])
    void highlightDiffLines(plainLines, languageForFile(path), theme).then((lines) => {
      if (!cancelled) setHighlighted(lines)
    })
    return () => { cancelled = true }
  }, [path, plainLines, theme])

  return (
    <div className="diff-chunk">
      <div className="diff-hunk-header">{chunk.content}</div>
      {chunk.changes.map((line, index) => (
        <div className={`diff-line diff-${line.type}`} key={`${index}-${line.oldNumber}-${line.newNumber}`}>
          <span className="diff-number">{line.oldNumber ?? ''}</span>
          <span className="diff-number">{line.newNumber ?? ''}</span>
          <span className="diff-marker">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
          <code
            dangerouslySetInnerHTML={highlighted[index] ? { __html: highlighted[index] } : undefined}
          >{highlighted[index] ? undefined : plainLines[index]}</code>
        </div>
      ))}
    </div>
  )
}

function FileDiff({
  file,
  theme,
  onToggleStaged,
}: {
  file: DiffFile
  theme: 'light' | 'dark'
  onToggleStaged: (staged: boolean) => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [stageBusy, setStageBusy] = useState(false)
  const path = file.to || file.from
  return (
    <section className="file-diff">
      <div className="file-diff-header">
        <button className="file-disclosure" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <ChevronRight size={13} aria-hidden="true" />
          <span className="file-path">{path}</span>
          <span className="diff-stat additions">+{file.additions}</span>
          <span className="diff-stat deletions">−{file.deletions}</span>
        </button>
        <label
          className={`stage-control ${file.stageable ? '' : 'is-disabled'}`}
          title={file.stageable ? file.staged ? 'Unstage file' : 'Stage file' : 'Already committed on this worktree branch'}
        >
          <input
            type="checkbox"
            checked={file.staged}
            disabled={stageBusy || !file.stageable}
            onChange={async (event) => {
              setStageBusy(true)
              try { await onToggleStaged(event.target.checked) } finally { setStageBusy(false) }
            }}
          />
          <span>{file.stageable ? file.staged ? 'Staged' : 'Stage' : 'Committed'}</span>
        </label>
      </div>
      {open && (
        <div className="file-diff-body">
          {file.binary
            ? <div className="binary-notice">Binary file changed</div>
            : file.chunks.map((chunk, index) => <DiffChunkView key={`${chunk.content}-${index}`} chunk={chunk} path={path} theme={theme} />)}
        </div>
      )}
    </section>
  )
}

export function ChangesView({ thread, theme, onOpenEditor, onApplyToMain }: ChangesViewProps): React.JSX.Element {
  const [files, setFiles] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [commitMessage, setCommitMessage] = useState('')
  const [commitBusy, setCommitBusy] = useState<'commit' | 'push'>()
  const [notice, setNotice] = useState<string>()
  const [applying, setApplying] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setFiles(await window.codePi.getChanges(thread.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [thread.id])

  const commit = async (push: boolean) => {
    if (!commitMessage.trim()) return
    setCommitBusy(push ? 'push' : 'commit')
    setError(undefined)
    setNotice(undefined)
    try {
      const result = await window.codePi.commit({ threadId: thread.id, message: commitMessage.trim(), push })
      setNotice(`${result.commit.slice(0, 8)} committed${result.pushed ? ' and pushed' : ''}.`)
      setCommitMessage('')
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCommitBusy(undefined)
    }
  }

  return (
    <div className="changes-view">
      <div className="changes-toolbar">
        <div>
          <h2>Working changes</h2>
          <p>{files.length} changed {files.length === 1 ? 'file' : 'files'}</p>
        </div>
        <div className="toolbar-actions">
          {thread.worktree && (
            <button
              className="button button-secondary"
              disabled={applying}
              onClick={async () => {
                setApplying(true)
                setError(undefined)
                try {
                  await onApplyToMain()
                  setNotice('Changes applied to the main working tree.')
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason))
                } finally {
                  setApplying(false)
                }
              }}
            >
              <GitBranch size={13} /> {applying ? 'Applying…' : 'Apply to main working tree'}
            </button>
          )}
          <button className="icon-button bordered" onClick={() => void load()} title="Refresh changes" aria-label="Refresh changes">
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-button bordered" onClick={onOpenEditor} title="Open in editor" aria-label="Open in editor">
            <ExternalLink size={13} />
          </button>
        </div>
      </div>

      {error && <div className="changes-alert error" role="alert">{error}</div>}
      {notice && <div className="changes-alert success"><Check size={13} /> {notice}</div>}

      <div className="diff-list">
        {loading && files.length === 0 && <div className="changes-loading"><span className="spinner" /> Reading changes…</div>}
        {!loading && files.length === 0 && (
          <div className="clean-state">
            <div className="clean-check"><Check size={23} /></div>
            <h3>Working tree is clean</h3>
            <p>Changes made by Pi will appear here for review.</p>
          </div>
        )}
        {files.map((file, index) => {
          const path = file.to || file.from
          return (
            <FileDiff
              key={`${path}-${index}`}
              file={file}
              theme={theme}
              onToggleStaged={async (staged) => {
                setError(undefined)
                try {
                  await window.codePi.setFileStaged(thread.id, path, staged)
                  setFiles((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, staged } : candidate))
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : String(reason))
                }
              }}
            />
          )
        })}
      </div>

      <div className="commit-panel">
        <label htmlFor="commit-message">Commit message</label>
        <div className="commit-row">
          <input
            id="commit-message"
            className="text-input"
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.metaKey) void commit(false)
            }}
            placeholder={files.length === 0 ? 'No changes to commit' : 'Describe these changes'}
            disabled={files.length === 0}
          />
          <button className="button button-secondary" disabled={files.length === 0 || !commitMessage.trim() || Boolean(commitBusy)} onClick={() => void commit(false)}>
            <GitCommitHorizontal size={13} /> {commitBusy === 'commit' ? 'Committing…' : 'Commit'}
          </button>
          <button className="button button-primary" disabled={files.length === 0 || !commitMessage.trim() || Boolean(commitBusy)} onClick={() => void commit(true)}>
            <Upload size={13} /> {commitBusy === 'push' ? 'Pushing…' : 'Commit & Push'}
          </button>
        </div>
      </div>
    </div>
  )
}
