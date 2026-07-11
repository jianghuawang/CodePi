import {
  ChevronDown,
  CornerDownLeft,
  FileText,
  Image,
  Paperclip,
  Plus,
  Send,
  Square,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment,
  DeliveryMode,
  OpenThreadResult,
  PiCapability,
  PiCommand,
  PiModel,
  PromptTemplate,
  ThinkingLevel,
  ThreadStatus,
  WorkspaceFile
} from '../../shared/contracts'
import { ComposerContextMenu } from './ComposerContextMenu'

interface ComposerProps {
  threadId: string
  cwd: string
  status: ThreadStatus
  queuedCount: number
  model: PiModel | null
  models: PiModel[]
  thinkingLevel: ThinkingLevel
  commands: PiCommand[]
  capabilities: PiCapability[]
  templates: PromptTemplate[]
  onSend: (text: string, mode: DeliveryMode, attachments: ComposerAttachment[]) => Promise<void>
  onAbort: () => void
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onRuntimeChanged: (result: OpenThreadResult) => void
  onTemplatesChanged: (templates: PromptTemplate[]) => void
}

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
]

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read file'))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

function looksText(file: File): boolean {
  return file.type.startsWith('text/') || /\.(?:md|mdx|txt|json|ya?ml|toml|csv|html?|css|s[ac]ss|[cm]?[jt]sx?|py|go|rs|java|swift|sh|zsh|sql)$/i.test(file.name)
}

async function attachmentFromFile(file: File): Promise<ComposerAttachment> {
  const id = window.crypto.randomUUID()
  const mimeType = file.type || 'application/octet-stream'
  if (mimeType.startsWith('image/')) {
    if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} is larger than 15 MB`)
    return { id, name: file.name, mimeType, size: file.size, kind: 'image', data: await fileDataUrl(file) }
  }
  if (looksText(file) && file.size <= 1_500_000) {
    return { id, name: file.name, mimeType, size: file.size, kind: 'text', text: await file.text() }
  }
  if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than 25 MB`)
  return { id, name: file.name, mimeType, size: file.size, kind: 'file', data: await fileDataUrl(file) }
}

function tokenMatch(value: string, marker: '@' | '/'): RegExpMatchArray | null {
  return marker === '@' ? value.match(/(?:^|\s)@([^\s@]*)$/) : value.match(/^\/([^\s/]*)$/)
}

export function Composer({
  threadId,
  cwd,
  status,
  queuedCount,
  model,
  models,
  thinkingLevel,
  commands,
  capabilities,
  templates,
  onSend,
  onAbort,
  onSetModel,
  onSetThinkingLevel,
  onRuntimeChanged,
  onTemplatesChanged,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [contextOpen, setContextOpen] = useState(false)
  const [fileSuggestions, setFileSuggestions] = useState<WorkspaceFile[]>([])
  const [sending, setSending] = useState(false)
  const [controlBusy, setControlBusy] = useState<'model' | 'thinking'>()
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const suggestionRequest = useRef(0)
  const running = status === 'running'
  const currentModel = model ? `${model.provider}::${model.id}` : ''
  const fileToken = tokenMatch(value, '@')
  const fileQuery = fileToken?.[1]
  const commandToken = tokenMatch(value, '/')
  const commandSuggestions = useMemo(() => {
    if (!commandToken) return []
    const query = (commandToken[1] ?? '').toLocaleLowerCase()
    return commands.filter((command) => command.name.toLocaleLowerCase().includes(query)).slice(0, 8)
  }, [commandToken, commands])

  const resize = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(180, Math.max(42, textarea.scrollHeight))}px`
  }

  useEffect(resize, [value])
  useEffect(() => {
    const requestId = ++suggestionRequest.current
    if (fileQuery === undefined) {
      setFileSuggestions([])
      return
    }
    const timer = window.setTimeout(() => {
      const request = fileQuery
        ? window.codePi.searchProjectFiles(threadId, fileQuery, 8)
        : window.codePi.getRecentFiles(threadId)
      void request.then((files) => {
        if (requestId === suggestionRequest.current) setFileSuggestions(files.slice(0, 8))
      }).catch(() => {
        if (requestId === suggestionRequest.current) setFileSuggestions([])
      })
    }, 100)
    return () => window.clearTimeout(timer)
  }, [fileQuery, threadId])

  const addAttachments = async (next: ComposerAttachment[]) => {
    setError(undefined)
    setAttachments((current) => {
      const known = new Set(current.map((item) => item.id))
      return [...current, ...next.filter((item) => !known.has(item.id))].slice(0, 12)
    })
  }

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return
    try {
      const next = await Promise.all(files.slice(0, 12 - attachments.length).map(attachmentFromFile))
      await addAttachments(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const insertAtCursor = (text: string) => {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? value.length
    const end = textarea?.selectionEnd ?? value.length
    setValue((current) => `${current.slice(0, start)}${text}${current.slice(end)}`)
    window.requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  const replaceToken = (match: RegExpMatchArray, replacement: string) => {
    const index = match.index ?? 0
    const prefixLength = match[0].length - (match[1]?.length ?? 0) - 1
    setValue(`${value.slice(0, index + prefixLength)}${replacement}${value.slice(index + match[0].length)}`)
    textareaRef.current?.focus()
  }

  const send = async (mode?: DeliveryMode) => {
    const message = value.trim() || (attachments.length ? 'Please inspect the attached context.' : '')
    if (!message || sending) return
    const deliveryMode = mode ?? (running ? 'steer' : 'prompt')
    setSending(true)
    setError(undefined)
    try {
      await onSend(message, deliveryMode, attachments)
      setValue('')
      setAttachments([])
      textareaRef.current?.focus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="composer-area">
      <div
        className={`composer ${running ? 'is-running' : ''} ${dragging ? 'is-dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void addFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {dragging && <div className="composer-drop-target"><Paperclip size={16} /> Drop files to add context</div>}
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attachments">
            {attachments.map((attachment) => (
              <span className="composer-attachment" key={attachment.id} title={attachment.name}>
                {attachment.kind === 'image' ? <Image size={11} /> : <FileText size={11} />}
                <span>{attachment.name}</span>
                <button onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={`Remove ${attachment.name}`}>
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-input-wrap">
          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            placeholder={running ? 'Steer Pi while it works…' : 'Ask Pi to make a change…'}
            aria-label="Message Pi"
            onChange={(event) => setValue(event.target.value)}
            onPaste={(event) => {
              const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
              if (images.length) {
                event.preventDefault()
                void addFiles(images)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && running) {
                event.preventDefault()
                event.stopPropagation()
                onAbort()
                return
              }
              if (event.key !== 'Enter') return
              if (event.altKey) {
                event.preventDefault()
                void send(running ? 'followUp' : 'prompt')
                return
              }
              if (event.metaKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          {(fileToken || commandToken) && (fileSuggestions.length > 0 || commandSuggestions.length > 0) && (
            <div className="composer-autocomplete" role="listbox" aria-label={fileToken ? 'File suggestions' : 'Command suggestions'}>
              {fileToken && fileSuggestions.map((file) => (
                <button key={file.path} onMouseDown={(event) => event.preventDefault()} onClick={() => replaceToken(fileToken, `@${file.path} `)}>
                  <FileText size={12} /><span><strong>{file.name}</strong><small>{file.path}</small></span>
                </button>
              ))}
              {commandToken && commandSuggestions.map((command) => (
                <button key={`${command.source}:${command.name}`} onMouseDown={(event) => event.preventDefault()} onClick={() => replaceToken(commandToken, `/${command.name} `)}>
                  <span className="autocomplete-slash">/</span><span><strong>{command.name}</strong><small>{command.description ?? command.source}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="composer-footer">
          <div className="composer-controls">
            <div className="composer-context-wrap">
              <button
                className={`composer-add-context ${contextOpen ? 'is-active' : ''}`}
                onClick={() => setContextOpen((open) => !open)}
                title="Add files, commands, extensions, skills, or prompts"
                aria-label="Add context"
              >
                <Plus size={12} /> Context
              </button>
              {contextOpen && (
                <ComposerContextMenu
                  threadId={threadId}
                  cwd={cwd}
                  currentDraft={value}
                  commands={commands}
                  capabilities={capabilities}
                  templates={templates}
                  onInsert={insertAtCursor}
                  onAttach={addAttachments}
                  onCapabilitiesChanged={onRuntimeChanged}
                  onTemplatesChanged={onTemplatesChanged}
                  onClose={() => setContextOpen(false)}
                />
              )}
            </div>
            <label className={`composer-select ${controlBusy === 'model' ? 'is-busy' : ''}`} title="Model">
              <span>Model</span>
              <select
                aria-label="Model"
                value={currentModel}
                disabled={controlBusy !== undefined || models.length === 0}
                onChange={async (event) => {
                  const [provider, ...modelParts] = event.target.value.split('::')
                  if (!provider || modelParts.length === 0) return
                  setControlBusy('model')
                  setError(undefined)
                  try {
                    await onSetModel(provider, modelParts.join('::'))
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : String(reason))
                  } finally {
                    setControlBusy(undefined)
                  }
                }}
              >
                {!currentModel && <option value="">Select</option>}
                {models.map((item) => (
                  <option key={`${item.provider}::${item.id}`} value={`${item.provider}::${item.id}`}>
                    {item.name || item.id} · {item.provider}
                  </option>
                ))}
              </select>
              <ChevronDown size={10} aria-hidden="true" />
            </label>
            <label className={`composer-select thinking-select ${controlBusy === 'thinking' ? 'is-busy' : ''}`} title="Thinking level">
              <span>Thinking</span>
              <select
                aria-label="Thinking level"
                value={thinkingLevel}
                disabled={controlBusy !== undefined}
                onChange={async (event) => {
                  const level = event.target.value as ThinkingLevel
                  setControlBusy('thinking')
                  setError(undefined)
                  try {
                    await onSetThinkingLevel(level)
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : String(reason))
                  } finally {
                    setControlBusy(undefined)
                  }
                }}
              >
                {THINKING_LEVELS.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}
              </select>
              <ChevronDown size={10} aria-hidden="true" />
            </label>
          </div>
          <div className="composer-hint">
            {queuedCount > 0
              ? `${queuedCount} follow-up${queuedCount === 1 ? '' : 's'} queued`
              : running ? '⌥↵ queue follow-up · esc stop' : '⌘↵ send'}
          </div>
          {running && (
            <button className="abort-button" onClick={onAbort} title="Stop (Esc)" aria-label="Stop Pi">
              <Square size={10} fill="currentColor" />
            </button>
          )}
          <button
            className="send-button"
            onClick={() => void send()}
            disabled={(!value.trim() && attachments.length === 0) || sending}
            title={running ? 'Steer Pi (⌘↵)' : 'Send (⌘↵)'}
          >
            {running ? <><CornerDownLeft size={13} /> Steer</> : <><Send size={13} /> Send</>}
          </button>
        </div>
      </div>
      {error && <div className="composer-error" role="alert">{error}</div>}
    </div>
  )
}
