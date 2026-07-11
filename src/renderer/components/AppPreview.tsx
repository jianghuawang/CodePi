import { ArrowLeft, ArrowRight, Monitor, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreviewEvent, ViewBounds } from '../../shared/contracts'

export interface AppPreviewProps {
  threadId: string
  active?: boolean
  initialUrl?: string
}

interface PreviewState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

function elementBounds(element: HTMLElement | null): ViewBounds | undefined {
  if (!element) return undefined
  const rect = element.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return undefined
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

export function AppPreview({ threadId, active = true, initialUrl = '' }: AppPreviewProps): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const openedRef = useRef(false)
  const requestedRef = useRef(Boolean(initialUrl))
  const activeRef = useRef(active)
  const urlRef = useRef(initialUrl)
  const frameRef = useRef<number | undefined>(undefined)
  const [draftUrl, setDraftUrl] = useState(initialUrl)
  const [state, setState] = useState<PreviewState>({
    url: initialUrl,
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [error, setError] = useState<string>()

  const resizePreview = useCallback(() => {
    if (!activeRef.current || !openedRef.current) return
    const bounds = elementBounds(surfaceRef.current)
    if (!bounds) return
    void window.codePi.setPreviewBounds(threadId, bounds).catch(() => undefined)
  }, [threadId])

  const scheduleResize = useCallback(() => {
    if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = undefined
      resizePreview()
    })
  }, [resizePreview])

  const openUrl = useCallback(async (urlValue?: string) => {
    const url = (urlValue ?? urlRef.current).trim()
    if (!activeRef.current || !url) return
    const bounds = elementBounds(surfaceRef.current)
    if (!bounds) {
      setError('Preview is still being laid out. Try again in a moment.')
      return
    }
    requestedRef.current = true
    urlRef.current = url
    setError(undefined)
    setState((current) => ({ ...current, loading: true }))
    try {
      await window.codePi.openPreview(threadId, url, bounds)
      if (!activeRef.current) {
        await window.codePi.closePreview(threadId).catch(() => undefined)
        openedRef.current = false
      } else {
        openedRef.current = true
      }
    } catch (reason) {
      openedRef.current = false
      await window.codePi.closePreview(threadId).catch(() => undefined)
      setState((current) => ({ ...current, loading: false }))
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [threadId])

  useEffect(() => window.codePi.onPreviewEvent((event: PreviewEvent) => {
    if (event.threadId !== threadId) return
    if (!activeRef.current) {
      void window.codePi.closePreview(threadId).catch(() => undefined)
      return
    }
    if (event.type === 'error') {
      setError(event.message)
      setState((current) => ({ ...current, loading: false }))
      return
    }
    openedRef.current = true
    urlRef.current = event.url
    setDraftUrl(event.url)
    setState({
      url: event.url,
      title: event.title,
      loading: event.loading,
      canGoBack: event.canGoBack,
      canGoForward: event.canGoForward,
    })
  }), [threadId])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const observer = new ResizeObserver(scheduleResize)
    observer.observe(surface)
    window.addEventListener('resize', scheduleResize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleResize)
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    }
  }, [scheduleResize])

  useEffect(() => {
    activeRef.current = active
    if (!active) {
      void window.codePi.closePreview(threadId).catch(() => undefined)
      openedRef.current = false
      return
    }
    if (requestedRef.current && urlRef.current) {
      const frame = window.requestAnimationFrame(() => void openUrl())
      return () => window.cancelAnimationFrame(frame)
    }
  }, [active, openUrl, threadId])

  useEffect(() => () => {
    void window.codePi.closePreview(threadId).catch(() => undefined)
    openedRef.current = false
  }, [threadId])

  const action = async (value: 'back' | 'forward' | 'reload'): Promise<void> => {
    setError(undefined)
    try {
      await window.codePi.previewAction(threadId, value)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <section className={`workspace-app-preview ${active ? 'is-active' : ''}`} aria-label="App preview">
      <header className="workspace-preview-toolbar">
        <div className="workspace-preview-navigation">
          <button
            type="button"
            className="workspace-icon-button"
            aria-label="Back"
            title="Back"
            disabled={!openedRef.current || !state.canGoBack}
            onClick={() => void action('back')}
          >
            <ArrowLeft size={13} />
          </button>
          <button
            type="button"
            className="workspace-icon-button"
            aria-label="Forward"
            title="Forward"
            disabled={!openedRef.current || !state.canGoForward}
            onClick={() => void action('forward')}
          >
            <ArrowRight size={13} />
          </button>
          <button
            type="button"
            className="workspace-icon-button"
            aria-label="Reload"
            title="Reload"
            disabled={!openedRef.current}
            onClick={() => void action('reload')}
          >
            <RefreshCw size={13} className={state.loading ? 'is-spinning' : ''} />
          </button>
        </div>
        <form
          className="workspace-preview-address"
          onSubmit={(event) => {
            event.preventDefault()
            void openUrl(draftUrl)
          }}
        >
          <Monitor size={12} aria-hidden="true" />
          <input
            value={draftUrl}
            aria-label="Local preview URL"
            placeholder="http://localhost:3000"
            spellCheck={false}
            onChange={(event) => setDraftUrl(event.target.value)}
          />
          <button type="submit" className="workspace-text-button" disabled={!draftUrl.trim()}>Open</button>
        </form>
        {state.title && <span className="workspace-preview-title" title={state.title}>{state.title}</span>}
      </header>
      {error && <div className="workspace-pane-error workspace-preview-error" role="alert">{error}</div>}
      <div ref={surfaceRef} className="workspace-preview-surface">
        {!requestedRef.current && (
          <div className="workspace-pane-empty workspace-preview-placeholder">
            <Monitor size={21} aria-hidden="true" />
            <span>Enter a localhost URL to preview your app.</span>
          </div>
        )}
      </div>
    </section>
  )
}
