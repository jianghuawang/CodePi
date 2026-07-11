import {
  BookOpen,
  Braces,
  Check,
  ChevronRight,
  FileClock,
  FilePlus2,
  Lightbulb,
  ListChecks,
  Paperclip,
  Plus,
  Puzzle,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  TerminalSquare,
  Trash2,
  Wrench
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment,
  OpenThreadResult,
  PiCapability,
  PiCommand,
  PromptTemplate,
  WorkspaceFile
} from '../../shared/contracts'
import { useOutsideClick } from '../hooks/useOutsideClick'

type ContextSection = 'context' | 'commands' | 'capabilities' | 'prompts'

export interface ComposerContextMenuProps {
  threadId: string
  cwd: string
  currentDraft: string
  commands: PiCommand[]
  capabilities: PiCapability[]
  templates: PromptTemplate[]
  onInsert: (text: string) => void
  onAttach: (attachments: ComposerAttachment[]) => void | Promise<void>
  onCapabilitiesChanged: (result: OpenThreadResult) => void | Promise<void>
  onTemplatesChanged: (templates: PromptTemplate[]) => void | Promise<void>
  onClose: () => void
}

const BUILT_IN_PROMPTS = [
  {
    id: 'review',
    title: 'Review changes',
    description: 'Inspect the current work for bugs and regressions.',
    icon: ListChecks,
    prompt: 'Review the current changes for bugs, regressions, security issues, and missing tests. Summarize findings by severity before making changes.'
  },
  {
    id: 'plan',
    title: 'Make a plan',
    description: 'Understand the project before editing files.',
    icon: Lightbulb,
    prompt: 'Inspect the project and create a concise implementation plan. Do not change files until the plan is clear.'
  },
  {
    id: 'fix-tests',
    title: 'Fix tests',
    description: 'Run, diagnose, fix, and verify the relevant tests.',
    icon: Wrench,
    prompt: 'Run the relevant test suite, diagnose the failures, and fix them. Re-run the tests to verify the result.'
  },
  {
    id: 'explain',
    title: 'Explain code',
    description: 'Walk through control flow and likely failure modes.',
    icon: BookOpen,
    prompt: 'Explain the relevant code and behavior clearly, including the main control flow, assumptions, and likely failure modes.'
  }
] as const

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function pathLeaf(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
}

function commandIcon(source: PiCommand['source']): typeof TerminalSquare {
  if (source === 'skill') return Sparkles
  if (source === 'extension') return Puzzle
  return Braces
}

function sourceLabel(capability: PiCapability): string {
  if (capability.packageName) return capability.packageName
  if (capability.source === 'project') return 'Project'
  if (capability.source === 'user') return 'User'
  if (capability.source === 'settings') return 'Settings'
  return 'Package'
}

export function ComposerContextMenu({
  threadId,
  cwd,
  currentDraft,
  commands,
  capabilities,
  templates,
  onInsert,
  onAttach,
  onCapabilitiesChanged,
  onTemplatesChanged,
  onClose
}: ComposerContextMenuProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [section, setSection] = useState<ContextSection>('context')
  const [query, setQuery] = useState('')
  const [recentFiles, setRecentFiles] = useState<WorkspaceFile[]>([])
  const [recentLoading, setRecentLoading] = useState(true)
  const [capabilityState, setCapabilityState] = useState(capabilities)
  const [templateState, setTemplateState] = useState(templates)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [templateTitle, setTemplateTitle] = useState('')
  const [templatePrompt, setTemplatePrompt] = useState(currentDraft)
  useOutsideClick(rootRef, onClose)

  useEffect(() => setCapabilityState(capabilities), [capabilities])
  useEffect(() => setTemplateState(templates), [templates])

  const loadRecent = useCallback(async () => {
    setRecentLoading(true)
    setError(undefined)
    try {
      setRecentFiles(await window.codePi.getRecentFiles(threadId))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRecentLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredCommands = useMemo(() => commands.filter((command) => {
    if (!normalizedQuery) return true
    return `${command.name} ${command.description ?? ''} ${command.source}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  }), [commands, normalizedQuery])
  const filteredCapabilities = useMemo(() => capabilityState.filter((capability) => {
    if (!normalizedQuery) return true
    return `${capability.name} ${capability.description ?? ''} ${capability.packageName ?? ''} ${capability.kind}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  }), [capabilityState, normalizedQuery])

  const insert = (text: string) => {
    onInsert(text)
    onClose()
  }

  const pickFiles = async () => {
    setBusy('attachments')
    setError(undefined)
    try {
      const attachments = await window.codePi.pickAttachments(threadId)
      if (attachments.length > 0) {
        await onAttach(attachments)
        onClose()
      }
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const toggleCapability = async (capability: PiCapability) => {
    const enabled = !capability.enabled
    setBusy(`capability:${capability.id}`)
    setError(undefined)
    try {
      const result = await window.codePi.setCapabilityEnabled(threadId, capability.id, enabled)
      setCapabilityState((items) => items.map((item) =>
        item.id === capability.id ? { ...item, enabled } : item
      ))
      await onCapabilitiesChanged(result)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const saveTemplate = async () => {
    const title = templateTitle.trim()
    const prompt = templatePrompt.trim()
    if (!title || !prompt) return
    setBusy('save-template')
    setError(undefined)
    try {
      const next = await window.codePi.savePromptTemplate({ title, prompt })
      setTemplateState(next)
      setTemplateTitle('')
      setTemplatePrompt('')
      await onTemplatesChanged(next)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const deleteTemplate = async (templateId: string) => {
    setBusy(`template:${templateId}`)
    setError(undefined)
    try {
      const next = await window.codePi.deletePromptTemplate(templateId)
      setTemplateState(next)
      await onTemplatesChanged(next)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="composer-context-popover" role="dialog" aria-label="Add context" ref={rootRef}>
      <div className="composer-context-heading">
        <div>
          <strong>Add context</strong>
          <span title={cwd}>{pathLeaf(cwd)}</span>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close context menu">×</button>
      </div>

      <div className="composer-context-tabs" role="tablist" aria-label="Context menu sections">
        {([
          ['context', 'Files'],
          ['commands', 'Commands'],
          ['capabilities', 'Agent'],
          ['prompts', 'Prompts']
        ] as const).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={section === value}
            className={section === value ? 'is-active' : ''}
            onClick={() => {
              setSection(value)
              setQuery('')
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {(section === 'commands' || section === 'capabilities') && (
        <label className="composer-context-search">
          <Search size={12} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={section === 'commands' ? 'Search commands' : 'Search extensions and skills'}
            aria-label={section === 'commands' ? 'Search commands' : 'Search extensions and skills'}
          />
        </label>
      )}

      {error && <div className="popover-error" role="alert">{error}</div>}

      <div className="composer-context-content">
        {section === 'context' && (
          <>
            <button className="composer-context-primary" disabled={busy === 'attachments'} onClick={() => void pickFiles()}>
              <span className="context-item-icon"><Paperclip size={14} /></span>
              <span><strong>{busy === 'attachments' ? 'Opening picker…' : 'Attach files or images'}</strong><small>Choose from your Mac</small></span>
              <ChevronRight size={13} aria-hidden="true" />
            </button>
            <div className="context-section-heading">
              <span><FileClock size={12} /> Recent files</span>
              <button className="icon-button" onClick={() => void loadRecent()} disabled={recentLoading} aria-label="Refresh recent files">
                <RefreshCw size={11} className={recentLoading ? 'spin' : ''} />
              </button>
            </div>
            <div className="context-item-list">
              {recentLoading && recentFiles.length === 0 && <div className="popover-empty">Finding recent files…</div>}
              {!recentLoading && recentFiles.length === 0 && <div className="popover-empty">No recent project files.</div>}
              {recentFiles.map((file) => (
                <button key={file.path} className="context-list-item" onClick={() => insert(`@${file.path} `)} title={file.path}>
                  <FilePlus2 size={13} />
                  <span><strong>{file.name}</strong><small>{file.path}</small></span>
                  <Plus size={11} aria-hidden="true" />
                </button>
              ))}
            </div>
          </>
        )}

        {section === 'commands' && (
          <div className="context-item-list command-list">
            {filteredCommands.length === 0 && <div className="popover-empty">No matching Pi commands.</div>}
            {filteredCommands.map((command) => {
              const Icon = commandIcon(command.source)
              return (
                <button key={`${command.source}:${command.name}`} className="context-list-item" onClick={() => insert(`/${command.name} `)}>
                  <Icon size={13} />
                  <span><strong>/{command.name}</strong><small>{command.description ?? `${command.source} command`}</small></span>
                  <span className="context-source-badge">{command.source}</span>
                </button>
              )
            })}
          </div>
        )}

        {section === 'capabilities' && (
          <div className="capability-list">
            {filteredCapabilities.length === 0 && <div className="popover-empty">No matching extensions or skills.</div>}
            {(['extension', 'skill'] as const).map((kind) => {
              const items = filteredCapabilities.filter((capability) => capability.kind === kind)
              if (items.length === 0) return null
              return (
                <section key={kind} className="capability-group">
                  <div className="context-section-heading">
                    <span>{kind === 'extension' ? <Puzzle size={12} /> : <Sparkles size={12} />}{kind === 'extension' ? 'Extensions' : 'Skills'}</span>
                    <small>{items.filter((item) => item.enabled).length}/{items.length} on</small>
                  </div>
                  {items.map((capability) => {
                    const isBusy = busy === `capability:${capability.id}`
                    return (
                      <button
                        key={capability.id}
                        className={`capability-row ${capability.enabled ? 'is-enabled' : ''}`}
                        role="switch"
                        aria-checked={capability.enabled}
                        disabled={Boolean(busy)}
                        onClick={() => void toggleCapability(capability)}
                        title={capability.path}
                      >
                        <span className="capability-copy">
                          <strong>{capability.name}</strong>
                          <small>{capability.description ?? sourceLabel(capability)}</small>
                        </span>
                        <span className={`native-switch ${capability.enabled ? 'is-on' : ''} ${isBusy ? 'is-busy' : ''}`} aria-hidden="true">
                          <span />
                        </span>
                      </button>
                    )
                  })}
                </section>
              )
            })}
            <p className="capability-footnote">Changing a capability restarts this thread’s Pi process.</p>
          </div>
        )}

        {section === 'prompts' && (
          <div className="prompt-library">
            <div className="built-in-prompts">
              {BUILT_IN_PROMPTS.map((prompt) => {
                const Icon = prompt.icon
                return (
                  <button key={prompt.id} className="prompt-card" onClick={() => insert(prompt.prompt)}>
                    <Icon size={14} />
                    <span><strong>{prompt.title}</strong><small>{prompt.description}</small></span>
                  </button>
                )
              })}
            </div>

            <div className="context-section-heading"><span><Save size={12} /> Saved prompts</span></div>
            <div className="context-item-list">
              {templateState.length === 0 && <div className="popover-empty compact">No saved prompts yet.</div>}
              {templateState.map((template) => (
                <div className="saved-prompt-row" key={template.id}>
                  <button className="saved-prompt-use" onClick={() => insert(template.prompt)} title={template.prompt}>
                    <strong>{template.title}</strong>
                    <small>{template.prompt.replace(/\s+/g, ' ').slice(0, 90)}</small>
                  </button>
                  <button
                    className="icon-button"
                    disabled={busy === `template:${template.id}`}
                    onClick={() => void deleteTemplate(template.id)}
                    aria-label={`Delete ${template.title}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>

            <div className="save-prompt-form">
              <div className="save-prompt-heading">
                <strong>Save a reusable prompt</strong>
                {currentDraft && <button onClick={() => setTemplatePrompt(currentDraft)}>Use current draft</button>}
              </div>
              <input
                value={templateTitle}
                onChange={(event) => setTemplateTitle(event.target.value)}
                placeholder="Prompt name"
                aria-label="Prompt name"
                maxLength={120}
              />
              <textarea
                value={templatePrompt}
                onChange={(event) => setTemplatePrompt(event.target.value)}
                placeholder="Prompt text"
                aria-label="Prompt text"
                rows={3}
              />
              <button
                className="button button-secondary compact"
                disabled={!templateTitle.trim() || !templatePrompt.trim() || busy === 'save-template'}
                onClick={() => void saveTemplate()}
              >
                {busy === 'save-template' ? <RefreshCw size={11} className="spin" /> : <Check size={11} />}
                {busy === 'save-template' ? 'Saving…' : 'Save prompt'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
