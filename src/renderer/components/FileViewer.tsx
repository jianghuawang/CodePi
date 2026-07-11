import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw, Search } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceFile, WorkspaceFilePreview } from '../../shared/contracts'

export interface FileViewerProps {
  threadId: string
  initialPath?: string
  onSelectPath?: (path: string) => void
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(value < 10 * 1_024 ? 1 : 0)} KB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

function directoryFor(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function ancestorsOf(path: string): string[] {
  const ancestors: string[] = []
  let directory = directoryFor(path)
  while (directory) {
    ancestors.push(directory)
    directory = directoryFor(directory)
  }
  return ancestors
}

interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  files: WorkspaceFile[]
}

function buildTree(files: WorkspaceFile[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [] }
  const folderByPath = new Map<string, TreeFolder>([['', root]])
  const folderFor = (path: string): TreeFolder => {
    const existing = folderByPath.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const folder: TreeFolder = { name: slash < 0 ? path : path.slice(slash + 1), path, folders: [], files: [] }
    folderFor(slash < 0 ? '' : path.slice(0, slash)).folders.push(folder)
    folderByPath.set(path, folder)
    return folder
  }
  files.forEach((file) => folderFor(directoryFor(file.path)).files.push(file))
  const sortFolder = (folder: TreeFolder): void => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name))
    folder.files.sort((a, b) => a.name.localeCompare(b.name))
    folder.folders.forEach(sortFolder)
  }
  sortFolder(root)
  return root
}

interface FolderRowsProps {
  folder: TreeFolder
  depth: number
  expanded: Set<string>
  selectedPath?: string
  onToggleFolder: (path: string) => void
  onOpenFile: (path: string) => void
}

function FolderRows({ folder, depth, expanded, selectedPath, onToggleFolder, onOpenFile }: FolderRowsProps): React.JSX.Element {
  const indent = 6 + depth * 12
  return (
    <>
      {folder.folders.map((child) => {
        const isOpen = expanded.has(child.path)
        return (
          <div key={child.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-expanded={isOpen}
              className="workspace-file-row is-tree is-folder"
              style={{ paddingLeft: `${indent}px` }}
              title={child.path}
              onClick={() => onToggleFolder(child.path)}
            >
              {isOpen ? <ChevronDown size={11} className="workspace-tree-chevron" aria-hidden="true" /> : <ChevronRight size={11} className="workspace-tree-chevron" aria-hidden="true" />}
              {isOpen ? <FolderOpen size={12} aria-hidden="true" /> : <Folder size={12} aria-hidden="true" />}
              <span className="workspace-file-name">{child.name}</span>
            </button>
            {isOpen && (
              <FolderRows
                folder={child}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggleFolder={onToggleFolder}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        )
      })}
      {folder.files.map((file) => (
        <button
          key={file.path}
          type="button"
          role="treeitem"
          aria-selected={selectedPath === file.path}
          className={`workspace-file-row is-tree ${selectedPath === file.path ? 'is-selected' : ''}`}
          style={{ paddingLeft: `${indent + 15}px` }}
          title={file.path}
          onClick={() => onOpenFile(file.path)}
        >
          <FileText size={12} aria-hidden="true" />
          <span className="workspace-file-name">{file.name}</span>
          {file.status && <span className="workspace-file-status">{file.status}</span>}
        </button>
      ))}
    </>
  )
}

export function FileViewer({ threadId, initialPath, onSelectPath }: FileViewerProps): React.JSX.Element {
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [query, setQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState(initialPath)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [preview, setPreview] = useState<WorkspaceFilePreview>()
  const [loadingFiles, setLoadingFiles] = useState(true)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [error, setError] = useState<string>()
  const requestId = useRef(0)
  const previewRequestId = useRef(0)
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())

  const loadFiles = useCallback(async () => {
    const request = ++requestId.current
    setLoadingFiles(true)
    setError(undefined)
    try {
      const next = await window.codePi.listWorkspaceFiles(threadId)
      if (request !== requestId.current) return
      setFiles(next)
      setSelectedPath((current) => current && next.some((file) => file.path === current) ? current : undefined)
    } catch (reason) {
      if (request === requestId.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (request === requestId.current) setLoadingFiles(false)
    }
  }, [threadId])

  useEffect(() => {
    setFiles([])
    setSelectedPath(initialPath)
    setExpanded(new Set())
    setPreview(undefined)
    setQuery('')
    void loadFiles()
    return () => {
      requestId.current += 1
      previewRequestId.current += 1
    }
  }, [initialPath, loadFiles, threadId])

  const openFile = useCallback(async (path: string) => {
    const request = ++previewRequestId.current
    setSelectedPath(path)
    setLoadingPreview(true)
    setPreview(undefined)
    setError(undefined)
    onSelectPath?.(path)
    try {
      const next = await window.codePi.readWorkspaceFile(threadId, path)
      if (request === previewRequestId.current) setPreview(next)
    } catch (reason) {
      if (request === previewRequestId.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (request === previewRequestId.current) setLoadingPreview(false)
    }
  }, [onSelectPath, threadId])

  useEffect(() => {
    if (initialPath && files.some((file) => file.path === initialPath)) void openFile(initialPath)
  }, [files, initialPath, openFile])

  // Keep the selected file visible in the tree, e.g. after opening it from a filter match.
  useEffect(() => {
    if (!selectedPath) return
    setExpanded((current) => {
      const ancestors = ancestorsOf(selectedPath)
      if (ancestors.every((path) => current.has(path))) return current
      const next = new Set(current)
      ancestors.forEach((path) => next.add(path))
      return next
    })
  }, [selectedPath])

  const toggleFolder = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const tree = useMemo(() => buildTree(files), [files])
  const filteredFiles = useMemo(() => {
    if (!deferredQuery) return []
    return files.filter((file) => file.path.toLocaleLowerCase().includes(deferredQuery))
  }, [deferredQuery, files])
  const visibleFiles = filteredFiles.slice(0, 600)

  return (
    <section className="workspace-file-viewer" aria-label="Workspace files">
      <aside className="workspace-file-sidebar">
        <div className="workspace-file-toolbar">
          <label className="workspace-file-search">
            <Search size={12} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Filter files"
              aria-label="Filter workspace files"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            className="workspace-icon-button"
            type="button"
            onClick={() => void loadFiles()}
            title="Refresh files"
            aria-label="Refresh files"
          >
            <RefreshCw size={13} className={loadingFiles ? 'is-spinning' : ''} />
          </button>
        </div>
        <div className="workspace-file-list" role={deferredQuery ? 'listbox' : 'tree'} aria-label="Files">
          {loadingFiles && files.length === 0 && <div className="workspace-pane-status">Loading files…</div>}
          {!loadingFiles && files.length === 0 && !error && <div className="workspace-pane-status">No source files found.</div>}
          {!deferredQuery && (
            <FolderRows
              folder={tree}
              depth={0}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggleFolder={toggleFolder}
              onOpenFile={(path) => void openFile(path)}
            />
          )}
          {deferredQuery && visibleFiles.map((file) => (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={selectedPath === file.path}
              className={`workspace-file-row ${selectedPath === file.path ? 'is-selected' : ''}`}
              title={file.path}
              onClick={() => void openFile(file.path)}
            >
              <FileText size={12} aria-hidden="true" />
              <span className="workspace-file-copy">
                <span className="workspace-file-name">{file.name}</span>
                {directoryFor(file.path) && <span className="workspace-file-directory">{directoryFor(file.path)}</span>}
              </span>
              {file.status && <span className="workspace-file-status">{file.status}</span>}
            </button>
          ))}
          {deferredQuery && !loadingFiles && files.length > 0 && filteredFiles.length === 0 && (
            <div className="workspace-pane-status">No files match “{query.trim()}”.</div>
          )}
          {filteredFiles.length > visibleFiles.length && (
            <div className="workspace-pane-status">Showing the first {visibleFiles.length.toLocaleString()} matches.</div>
          )}
        </div>
      </aside>
      <div className="workspace-file-preview">
        {error && <div className="workspace-pane-error" role="alert">{error}</div>}
        {loadingPreview && <div className="workspace-pane-status">Opening file…</div>}
        {!loadingPreview && !preview && !error && (
          <div className="workspace-pane-empty">
            <FileText size={20} aria-hidden="true" />
            <span>Select a file to preview it.</span>
          </div>
        )}
        {preview && (
          <>
            <header className="workspace-preview-header">
              <div>
                <strong>{preview.path}</strong>
                <span>{formatBytes(preview.size)} · {preview.language}</span>
              </div>
              {preview.truncated && <span className="workspace-preview-badge">First 2 MB</span>}
            </header>
            {preview.binary
              ? <div className="workspace-pane-empty">Binary files are not rendered inside CodePi.</div>
              : <pre className="workspace-source-preview" data-language={preview.language}>{preview.content}</pre>}
          </>
        )}
      </div>
    </section>
  )
}
