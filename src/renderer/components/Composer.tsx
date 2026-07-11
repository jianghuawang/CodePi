import { ChevronDown, CornerDownLeft, Send, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DeliveryMode, PiModel, ThinkingLevel, ThreadStatus } from '../../shared/contracts'

interface ComposerProps {
  status: ThreadStatus
  queuedCount: number
  model: PiModel | null
  models: PiModel[]
  thinkingLevel: ThinkingLevel
  onSend: (text: string, mode: DeliveryMode) => Promise<void>
  onAbort: () => void
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
]

export function Composer({
  status,
  queuedCount,
  model,
  models,
  thinkingLevel,
  onSend,
  onAbort,
  onSetModel,
  onSetThinkingLevel,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const [controlBusy, setControlBusy] = useState<'model' | 'thinking'>()
  const [error, setError] = useState<string>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const running = status === 'running'
  const currentModel = model ? `${model.provider}::${model.id}` : ''

  const resize = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(180, Math.max(42, textarea.scrollHeight))}px`
  }

  useEffect(resize, [value])

  const send = async (mode?: DeliveryMode) => {
    const message = value.trim()
    if (!message || sending) return
    const deliveryMode = mode ?? (running ? 'steer' : 'prompt')
    setSending(true)
    setError(undefined)
    try {
      await onSend(message, deliveryMode)
      setValue('')
      textareaRef.current?.focus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="composer-area">
      <div className={`composer ${running ? 'is-running' : ''}`}>
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={running ? 'Steer Pi while it works…' : 'Ask Pi to make a change…'}
          aria-label="Message Pi"
          onChange={(event) => setValue(event.target.value)}
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
        <div className="composer-footer">
          <div className="composer-controls">
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
            disabled={!value.trim() || sending}
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
