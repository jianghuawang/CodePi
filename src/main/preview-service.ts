import { randomUUID } from 'node:crypto'
import { WebContentsView, type BrowserWindow } from 'electron'
import type { PreviewEvent, ThreadRecord, ViewBounds } from '../shared/contracts'

type ThreadLookup = (threadId: string) => ThreadRecord
type WindowLookup = () => BrowserWindow | null
type EventSink = (event: PreviewEvent) => void

interface ActivePreview {
  threadId: string
  owner: BrowserWindow
  view: WebContentsView
  url: string
  title: string
  loading: boolean
  onDownload: (event: Electron.Event) => void
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function normalizePreviewUrl(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 4_096) {
    throw new TypeError('Preview URL is invalid')
  }
  let input = value.trim()
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) input = `http://${input}`

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new TypeError('Preview URL is invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Preview only supports HTTP and HTTPS')
  }
  if (url.username || url.password) throw new TypeError('Preview URLs cannot contain credentials')

  const hostname = url.hostname.toLocaleLowerCase()
  if (hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  else if (hostname === '[::]' || hostname === '::') url.hostname = '[::1]'
  else if (!LOOPBACK_HOSTS.has(hostname)) throw new TypeError('Preview is limited to local development servers')

  if (url.port) {
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('Preview port is invalid')
  }
  return url.toString()
}

export function clampPreviewBounds(bounds: ViewBounds, contentSize: readonly number[]): ViewBounds {
  const contentWidth = Math.max(1, contentSize[0] ?? 1)
  const contentHeight = Math.max(1, contentSize[1] ?? 1)
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    throw new TypeError('Preview bounds are invalid')
  }
  const x = Math.min(Math.max(0, Math.round(bounds.x)), Math.max(0, contentWidth - 1))
  const y = Math.min(Math.max(0, Math.round(bounds.y)), Math.max(0, contentHeight - 1))
  const maximumWidth = Math.max(1, contentWidth - x)
  const maximumHeight = Math.max(1, contentHeight - y)
  const width = Math.min(maximumWidth, Math.max(1, Math.round(bounds.width)))
  const height = Math.min(maximumHeight, Math.max(1, Math.round(bounds.height)))
  return { x, y, width, height }
}

export class PreviewService {
  private active: ActivePreview | undefined

  constructor(
    private readonly getThread: ThreadLookup,
    private readonly getWindow: WindowLookup,
    private readonly emit: EventSink,
  ) {}

  async open(threadId: string, urlValue: string, bounds: ViewBounds): Promise<void> {
    this.getThread(threadId)
    const url = normalizePreviewUrl(urlValue)
    const owner = this.getWindow()
    if (!owner || owner.isDestroyed()) throw new Error('The CodePi window is unavailable')

    if (this.active?.threadId === threadId && !this.active.view.webContents.isDestroyed()) {
      this.setBounds(threadId, bounds)
      this.active.view.setVisible(true)
      await this.navigateActive(url)
      return
    }
    await this.destroyActive()

    const view = new WebContentsView({
      webPreferences: {
        partition: `codepi-preview-${randomUUID()}`,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
        webviewTag: false,
      },
    })
    view.setBackgroundColor('#ffffff')
    const contents = view.webContents
    const previewSession = contents.session
    previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    previewSession.setPermissionCheckHandler(() => false)
    const onDownload = (event: Electron.Event): void => event.preventDefault()
    previewSession.on('will-download', onDownload)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('login', (event, _details, _authInfo, callback) => {
      event.preventDefault()
      callback()
    })

    const active: ActivePreview = {
      threadId,
      owner,
      view,
      url,
      title: '',
      loading: true,
      onDownload,
    }
    this.active = active
    owner.contentView.addChildView(view)
    view.setBounds(clampPreviewBounds(bounds, owner.getContentSize()))
    view.setVisible(true)

    const guardNavigation = (event: Electron.Event, target: string): void => {
      try {
        normalizePreviewUrl(target)
      } catch (error) {
        event.preventDefault()
        this.emit({
          type: 'error',
          threadId,
          message: error instanceof Error ? error.message : 'Preview navigation was blocked',
        })
      }
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.on('did-start-loading', () => {
      if (this.active !== active) return
      active.loading = true
      this.emitState(active)
    })
    contents.on('did-stop-loading', () => {
      if (this.active !== active) return
      active.loading = false
      this.emitState(active)
    })
    contents.on('page-title-updated', (_event, title) => {
      if (this.active !== active) return
      active.title = title.replace(/[\r\n\0]/g, ' ').slice(0, 200)
      this.emitState(active)
    })
    const recordNavigation = (_event: Electron.Event, target: string): void => {
      if (this.active !== active) return
      try {
        active.url = normalizePreviewUrl(target)
        this.emitState(active)
      } catch {
        // The navigation guards reject disallowed top-level targets.
      }
    }
    contents.on('did-navigate', recordNavigation)
    contents.on('did-navigate-in-page', recordNavigation)
    contents.on('did-fail-load', (_event, errorCode, description, _target, isMainFrame) => {
      if (this.active !== active || !isMainFrame || errorCode === -3) return
      active.loading = false
      this.emit({ type: 'error', threadId, message: `Preview failed to load: ${description}` })
      this.emitState(active)
    })
    contents.on('render-process-gone', (_event, details) => {
      if (this.active !== active) return
      this.emit({ type: 'error', threadId, message: `Preview renderer stopped: ${details.reason}` })
    })
    contents.on('destroyed', () => {
      if (this.active !== active) return
      this.active = undefined
      this.emit({ type: 'error', threadId, message: 'Preview closed unexpectedly' })
    })

    await this.navigateActive(url)
  }

  setBounds(threadId: string, bounds: ViewBounds): void {
    const active = this.requireActive(threadId)
    if (active.owner.isDestroyed()) throw new Error('The CodePi window is unavailable')
    active.view.setBounds(clampPreviewBounds(bounds, active.owner.getContentSize()))
  }

  setVisible(threadId: string, visible: boolean): void {
    const active = this.active
    if (!active || active.threadId !== threadId || active.view.webContents.isDestroyed()) return
    active.view.setVisible(visible)
  }

  action(threadId: string, action: 'back' | 'forward' | 'reload'): void {
    const active = this.requireActive(threadId)
    const contents = active.view.webContents
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    else if (action === 'reload') contents.reload()
  }

  async close(threadId: string): Promise<void> {
    if (this.active?.threadId !== threadId) return
    await this.destroyActive()
  }

  async destroy(): Promise<void> {
    await this.destroyActive()
  }

  private requireActive(threadId: string): ActivePreview {
    const active = this.active
    if (!active || active.threadId !== threadId || active.view.webContents.isDestroyed()) {
      throw new Error('Preview is not open for this thread')
    }
    return active
  }

  private async navigateActive(url: string): Promise<void> {
    const active = this.active
    if (!active) throw new Error('Preview is not open')
    active.url = url
    active.loading = true
    this.emitState(active)
    try {
      await active.view.webContents.loadURL(url)
    } catch (error) {
      if (this.active === active) {
        active.loading = false
        this.emit({
          type: 'error',
          threadId: active.threadId,
          message: error instanceof Error ? error.message : 'Preview failed to load',
        })
        this.emitState(active)
      }
      throw error
    }
  }

  private emitState(active: ActivePreview): void {
    if (this.active !== active || active.view.webContents.isDestroyed()) return
    const contents = active.view.webContents
    this.emit({
      type: 'state',
      threadId: active.threadId,
      url: contents.getURL() || active.url,
      title: active.title || contents.getTitle(),
      loading: active.loading,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    })
  }

  private async destroyActive(): Promise<void> {
    const active = this.active
    if (!active) return
    this.active = undefined
    const previewSession = active.view.webContents.session
    previewSession.removeListener('will-download', active.onDownload)
    previewSession.setPermissionRequestHandler(null)
    previewSession.setPermissionCheckHandler(null)
    if (!active.owner.isDestroyed()) active.owner.contentView.removeChildView(active.view)
    if (!active.view.webContents.isDestroyed()) {
      active.view.webContents.close({ waitForBeforeUnload: false })
    }
  }
}
