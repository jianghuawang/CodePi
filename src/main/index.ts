import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Session
} from 'electron'
import type {
  AppSettings,
  BootstrapData,
  MenuAction,
  PersistedState,
  PreviewEvent,
  ProjectRecord,
  TerminalEvent,
  ThinkingLevel,
  ThreadEvent,
  ThreadRecord,
  UsageDashboard
} from '../shared/contracts'
import { ipcChannels as channels } from '../shared/ipc-channels'
import { AttachmentService } from './attachment-service'
import { exportThreadToPath } from './export-service'
import {
  applyWorktreeToMain,
  commitChanges,
  copyWorktreeState,
  createWorktree,
  getChanges,
  getWorktreeRemovalRisk,
  isGitProject,
  openDirectoryInEditor,
  removeWorktree,
  setFileStaged
} from './git-service'
import { PiProcessManager } from './pi-manager'
import {
  disabledCapabilityIdsForSafeRestart,
  listPiCapabilities
} from './pi-capabilities'
import { validatePiBinary } from './pi-validation'
import { currentPlatform, mainWindowPlatformOptions, settingsWindowPlatformOptions } from './platform'
import { PreviewService } from './preview-service'
import { TranscriptSearchService } from './search-service'
import {
  cloneSessionBranch,
  cloneSessionAtEntry,
  discoverProjectSessions,
  readSessionMessages,
  readSessionTree,
  recoveredThreadId
} from './sessions'
import { StateStore } from './state-store'
import { TerminalService } from './terminal-service'
import {
  aggregateUsageLedger,
  deletePromptTemplate,
  listPromptTemplates,
  restoreTrashedThread,
  savePromptTemplate,
  updateThreadMetadata
} from './thread-library'
import {
  parseCommitInput,
  parseAttachments,
  parseCreateThreadInput,
  parseDeliveryMode,
  parseExportFormat,
  parseSettings,
  parseThreadUpdate,
  parseViewBounds,
  isRecord,
  requireBoolean,
  requireId,
  requireInteger,
  requireRepoPath,
  requireString
} from './validation'
import { WorkspaceService } from './workspace-service'

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let store!: StateStore
let processes!: PiProcessManager
let attachmentService!: AttachmentService
let terminalService!: TerminalService
let workspaceService!: WorkspaceService
let previewService!: PreviewService
const transcriptSearch = new TranscriptSearchService()
let quitInProgress = false
let readyToQuit = false

function publicState(): PersistedState {
  const { dismissedSessionFiles: _dismissed, ...state } = store.snapshot()
  return { ...state, settings: { ...state.settings, env: {} } }
}

function threadById(threadId: string): ThreadRecord {
  const thread = store.peek().threads.find((item) => item.id === threadId)
  if (!thread) throw new Error('Thread not found')
  return structuredClone(thread)
}

function projectById(projectId: string): ProjectRecord {
  const project = store.peek().projects.find((item) => item.id === projectId)
  if (!project) throw new Error('Project not found')
  return structuredClone(project)
}

function defaultThreadMetadata(): Pick<
  ThreadRecord,
  'pinned' | 'archived' | 'unread' | 'tags' | 'disabledCapabilityIds' | 'autoRetryEnabled'
> {
  const autoRetryEnabled = store?.peek().threads[0]?.autoRetryEnabled ?? true
  return {
    pinned: false,
    archived: false,
    unread: false,
    tags: [],
    disabledCapabilityIds: [],
    autoRetryEnabled
  }
}

function usageDashboard(projectId?: string): UsageDashboard {
  return aggregateUsageLedger(store.peek().usageLedger, projectId)
}

function emitThreadEvent(event: ThreadEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channels.threadEvent, event)
}

function emitTerminalEvent(event: TerminalEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channels.terminalEvent, event)
}

function emitPreviewEvent(event: PreviewEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channels.previewEvent, event)
}

function emitMenuAction(action: MenuAction): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channels.menuAction, action)
  mainWindow.show()
  mainWindow.focus()
}

function effectiveTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function broadcastTheme(): void {
  const theme = effectiveTheme()
  for (const window of [mainWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channels.themeChanged, theme)
  }
}

function applyTheme(settings: AppSettings): void {
  nativeTheme.themeSource = settings.theme
  broadcastTheme()
}

function developmentRendererUrl(): URL | null {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return null
  try {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !loopbackHosts.has(url.hostname) ||
      url.username ||
      url.password
    ) return null
    return url
  } catch {
    return null
  }
}

type WindowRole = 'main' | 'settings'

function trustedSender(event: IpcMainInvokeEvent, requiredRole: WindowRole): void {
  const senderId = event.sender.id
  const role: WindowRole | undefined = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId
    ? 'main'
    : settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents.id === senderId
      ? 'settings'
      : undefined
  if (!role || role !== requiredRole) throw new Error('IPC request rejected')
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Subframe IPC request rejected')
  }
  try {
    const frame = new URL(event.senderFrame.url)
    const current = new URL(event.sender.getURL())
    if (frame.origin !== current.origin || frame.pathname !== current.pathname) throw new Error('mismatch')
    const expected = developmentRendererUrl()
    if (expected) {
      if (frame.origin !== expected.origin || frame.pathname !== expected.pathname) throw new Error('mismatch')
    } else if (frame.protocol !== 'file:') {
      throw new Error('mismatch')
    }
  } catch {
    throw new Error('IPC origin rejected')
  }
}

function handle(
  channel: string,
  callback: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  requiredRole: WindowRole = 'main'
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    trustedSender(event, requiredRole)
    return callback(event, ...args)
  })
}

function configureWebContents(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'http:' || target.protocol === 'https:') {
        void shell.openExternal(target.toString()).catch(() => undefined)
      }
    } catch {
      // Invalid and non-web targets stay blocked.
    }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    try {
      const currentUrl = new URL(current)
      const targetUrl = new URL(target)
      if (currentUrl.origin === targetUrl.origin && currentUrl.pathname === targetUrl.pathname) return
    } catch {
      // A malformed navigation target is always rejected.
    }
    event.preventDefault()
  })
}

const cspSessions = new WeakSet<Session>()

function configureContentSecurityPolicy(window: BrowserWindow): void {
  if (developmentRendererUrl() || cspSessions.has(window.webContents.session)) return
  const session = window.webContents.session
  cspSessions.add(session)
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !details.url.startsWith('file:')) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
        ]
      }
    })
  })
}

async function loadRenderer(window: BrowserWindow, kind: 'main' | 'settings'): Promise<void> {
  const developmentUrl = developmentRendererUrl()
  if (developmentUrl) {
    const url = new URL(developmentUrl)
    if (kind === 'settings') url.searchParams.set('window', 'settings')
    await window.loadURL(url.toString())
    return
  }
  await window.loadFile(join(__dirname, '../renderer/index.html'), {
    ...(kind === 'settings' ? { query: { window: 'settings' } } : {})
  })
}

function visibleBounds(bounds: PersistedState['windowBounds']): PersistedState['windowBounds'] {
  if (bounds.x === undefined || bounds.y === undefined) return bounds
  const intersectsDisplay = screen.getAllDisplays().some(({ workArea }) => {
    const horizontal = bounds.x! < workArea.x + workArea.width && bounds.x! + bounds.width > workArea.x
    const vertical = bounds.y! < workArea.y + workArea.height && bounds.y! + bounds.height > workArea.y
    return horizontal && vertical
  })
  return intersectsDisplay ? bounds : { width: bounds.width, height: bounds.height }
}

function createMainWindow(): BrowserWindow {
  const bounds = visibleBounds(store.snapshot().windowBounds)
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'CodePi',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f4f4f4',
    transparent: process.platform === 'darwin',
    ...mainWindowPlatformOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  configureContentSecurityPolicy(window)
  configureWebContents(window)
  window.once('ready-to-show', () => window.show())
  const persistBounds = (): void => {
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return
    const next = window.getBounds()
    store.update((state) => {
      state.windowBounds = { width: next.width, height: next.height, x: next.x, y: next.y }
    })
  }
  window.on('resize', persistBounds)
  window.on('move', persistBounds)
  const cleanupRendererResources = (): void => {
    void Promise.allSettled([
      previewService?.destroy(),
      terminalService?.stopAll()
    ])
  }
  window.webContents.on('render-process-gone', cleanupRendererResources)
  window.on('closed', () => {
    cleanupRendererResources()
    if (mainWindow === window) mainWindow = null
  })
  void loadRenderer(window, 'main').catch((error: unknown) => {
    if (!window.isDestroyed()) window.destroy()
    dialog.showErrorBox(
      'CodePi window could not load',
      error instanceof Error ? error.message : String(error)
    )
  })
  return window
}

async function openSettingsWindow(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  const window = new BrowserWindow({
    width: 560,
    height: 620,
    minWidth: 500,
    minHeight: 520,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'CodePi Settings',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f4f4f4',
    transparent: process.platform === 'darwin',
    ...settingsWindowPlatformOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  settingsWindow = window
  window.center()
  configureContentSecurityPolicy(window)
  configureWebContents(window)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null
  })
  await loadRenderer(window, 'settings')
}

function createApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => void openSettingsWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Thread', accelerator: 'CmdOrCtrl+N', click: () => emitMenuAction('new-thread') },
        { label: 'New Project', accelerator: 'CmdOrCtrl+Shift+N', click: () => emitMenuAction('new-project') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Search Threads…', accelerator: 'CmdOrCtrl+K', click: () => emitMenuAction('command-palette') }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        ...(process.platform === 'darwin' ? [{ role: 'window' as const }] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createThread(inputValue: unknown): Promise<ThreadRecord> {
  const input = parseCreateThreadInput(inputValue)
  const project = projectById(input.projectId)
  const id = randomUUID()
  const now = Date.now()
  let cwd = project.path
  let worktree: ThreadRecord['worktree']
  let source = input.branchFrom ? threadById(input.branchFrom.sourceThreadId) : undefined
  if (source && source.projectId !== project.id) throw new Error('History can only branch within its project')

  let sessionFile: string | undefined
  try {
    if (input.isolated && project.isGit) {
      worktree = await createWorktree(project.path, id, source?.worktree ? source : undefined)
      cwd = worktree.path
      if (source?.worktree) {
        await copyWorktreeState(source, {
          id,
          projectId: project.id,
          title: input.title || 'New thread',
          cwd,
          status: 'idle',
          createdAt: now,
          updatedAt: now,
          ...defaultThreadMetadata(),
          worktree
        })
      }
    }
    if (input.branchFrom) {
      if (!source) throw new Error('The source thread no longer exists')
      if (!source.sessionFile) {
        await processes.open(source.id)
        source = threadById(source.id)
      }
      if (!source.sessionFile) throw new Error('The source thread does not have a Pi session yet')
      sessionFile = await cloneSessionAtEntry(
        source.sessionFile,
        input.branchFrom.entryId,
        cwd,
        store.snapshot().settings.env
      )
    }
  } catch (error) {
    if (worktree) {
      const temporary: ThreadRecord = {
        id,
        projectId: project.id,
        title: input.title || 'New thread',
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        ...defaultThreadMetadata(),
        worktree
      }
      await removeWorktree(project.path, temporary).catch(() => undefined)
    }
    throw error
  }

  const sourceTitle = input.branchFrom
    ? store.snapshot().threads.find((item) => item.id === input.branchFrom!.sourceThreadId)?.title
    : undefined
  const thread: ThreadRecord = {
    id,
    projectId: project.id,
    title: input.title?.trim() || (sourceTitle ? `Branch of ${sourceTitle}` : 'New thread'),
    cwd,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    ...defaultThreadMetadata(),
    ...(sessionFile ? { sessionFile } : {}),
    ...(worktree ? { worktree } : {})
  }
  store.update((state) => {
    state.threads.unshift(thread)
    state.selectedThreadId = thread.id
  })
  return structuredClone(thread)
}

async function recoverSessions(): Promise<void> {
  const snapshot = store.snapshot()
  const discovered = await discoverProjectSessions(snapshot.projects, snapshot.threads, snapshot.settings.env)
  store.update((state) => {
    for (const thread of state.threads) {
      if (thread.status === 'running' || thread.status === 'waiting') thread.status = 'idle'
    }
    const existing = new Set(state.threads.flatMap((thread) => thread.sessionFile ? [resolve(thread.sessionFile)] : []))
    const dismissed = new Set((state.dismissedSessionFiles ?? []).map((file) => resolve(file)))
    for (const project of state.projects) {
      for (const session of discovered.get(project.id) ?? []) {
        const file = resolve(session.file)
        if (existing.has(file) || dismissed.has(file)) continue
        let id = recoveredThreadId(file)
        let suffix = 1
        while (state.threads.some((thread) => thread.id === id)) id = `${recoveredThreadId(file)}-${suffix++}`
        state.threads.push({
          id,
          projectId: project.id,
          title: session.title,
          cwd: session.cwd,
          status: 'idle',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          sessionFile: file,
          ...defaultThreadMetadata()
        })
        existing.add(file)
      }
    }
    if (state.selectedThreadId && !state.threads.some((thread) => thread.id === state.selectedThreadId)) {
      state.selectedThreadId = undefined
    }
  })
}

async function duplicateThreadRecord(sourceThreadId: string): Promise<ThreadRecord> {
  const source = threadById(sourceThreadId)
  if (source.deletedAt) throw new Error('Restore this thread before duplicating it')
  const project = projectById(source.projectId)
  const id = randomUUID()
  const now = Date.now()
  let cwd = project.path
  let worktree: ThreadRecord['worktree']
  let sessionFile: string | undefined
  try {
    if (source.worktree && project.isGit) {
      worktree = await createWorktree(project.path, id, source)
      cwd = worktree.path
      await copyWorktreeState(source, {
        id,
        projectId: project.id,
        title: `Copy of ${source.title}`,
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        ...defaultThreadMetadata(),
        worktree
      })
    }
    if (source.sessionFile) {
      const history = await readSessionTree(source.sessionFile)
      if (history.leafId) {
        sessionFile = await cloneSessionBranch(
          source.sessionFile,
          history.leafId,
          cwd,
          store.snapshot().settings.env,
          false
        )
      }
    }
  } catch (error) {
    if (worktree) {
      await removeWorktree(project.path, {
        id,
        projectId: project.id,
        title: `Copy of ${source.title}`,
        cwd,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        ...defaultThreadMetadata(),
        worktree
      }).catch(() => undefined)
    }
    throw error
  }
  const thread: ThreadRecord = {
    id,
    projectId: source.projectId,
    title: `Copy of ${source.title}`.slice(0, 240),
    cwd,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    ...defaultThreadMetadata(),
    tags: [...source.tags],
    disabledCapabilityIds: [...source.disabledCapabilityIds],
    autoRetryEnabled: source.autoRetryEnabled,
    ...(sessionFile ? { sessionFile } : {}),
    ...(worktree ? { worktree } : {})
  }
  store.update((state) => {
    state.threads.unshift(thread)
    state.selectedThreadId = thread.id
  })
  return structuredClone(thread)
}

async function trashThread(threadId: string): Promise<void> {
  threadById(threadId)
  await Promise.allSettled([
    processes.close(threadId),
    terminalService.closeThread(threadId),
    previewService.close(threadId)
  ])
  store.update((state) => {
    const thread = state.threads.find((item) => item.id === threadId)
    if (!thread) return
    thread.deletedAt = Date.now()
    thread.unread = false
    thread.status = 'idle'
    if (state.selectedThreadId === threadId) state.selectedThreadId = undefined
  })
}

async function purgeThreadPermanently(threadId: string): Promise<void> {
  const thread = threadById(threadId)
  const project = projectById(thread.projectId)
  await Promise.allSettled([
    processes.close(threadId),
    terminalService.closeThread(threadId),
    previewService.close(threadId)
  ])
  if (thread.worktree) {
    const risk = await getWorktreeRemovalRisk(thread).catch(() => ({ dirty: false, unpushedCommits: 0 }))
    if (risk.dirty || risk.unpushedCommits > 0) {
      const details = [
        ...(risk.dirty ? ['uncommitted changes'] : []),
        ...(risk.unpushedCommits > 0
          ? [`${risk.unpushedCommits} unpushed commit${risk.unpushedCommits === 1 ? '' : 's'}`]
          : [])
      ].join(' and ')
      const options = {
        type: 'warning' as const,
        title: 'Delete Thread Permanently?',
        message: `This isolated worktree has ${details}.`,
        detail: 'Permanent deletion removes its local worktree and branch. This cannot be undone.',
        buttons: ['Cancel', 'Delete Permanently'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const answer = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      if (answer.response !== 1) throw new Error('Thread deletion was cancelled')
    }
    await removeWorktree(project.path, thread)
  }
  await attachmentService.cleanupThread(threadId)
  transcriptSearch.clear(thread.sessionFile)
  store.update((state) => {
    state.threads = state.threads.filter((item) => item.id !== threadId)
    if (thread.sessionFile) {
      const dismissed = new Set(state.dismissedSessionFiles ?? [])
      dismissed.add(resolve(thread.sessionFile))
      state.dismissedSessionFiles = [...dismissed]
    }
    if (state.selectedThreadId === threadId) state.selectedThreadId = undefined
  })
}

function registerIpc(): void {
  handle(channels.bootstrap, async (): Promise<BootstrapData> => {
    const settings = store.snapshot().settings
    return {
      state: publicState(),
      pi: await validatePiBinary(settings.piPath, settings.env),
      platform: currentPlatform
    }
  })

  handle(channels.addProject, async (): Promise<ProjectRecord | null> => {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const options = {
      title: 'Add Project',
      buttonLabel: 'Add Project',
      properties: ['openDirectory' as const]
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    const path = await realpath(selected).catch(() => resolve(selected))
    const details = await stat(path)
    if (!details.isDirectory()) throw new Error('Select a folder')
    const duplicate = store.snapshot().projects.find((project) => resolve(project.path) === resolve(path))
    if (duplicate) return duplicate
    const project: ProjectRecord = {
      id: randomUUID(),
      name: basename(path),
      path,
      isGit: await isGitProject(path),
      expanded: true,
      createdAt: Date.now()
    }
    store.update((state) => state.projects.push(project))
    return structuredClone(project)
  })

  handle(channels.toggleProject, (_event, projectIdValue, expandedValue) => {
    const projectId = requireId(projectIdValue, 'projectId')
    const expanded = requireBoolean(expandedValue, 'expanded')
    projectById(projectId)
    store.update((state) => {
      const project = state.projects.find((item) => item.id === projectId)
      if (project) project.expanded = expanded
    })
  })

  handle(channels.createThread, (_event, input) => createThread(input))
  handle(channels.deleteThread, (_event, threadIdValue) => trashThread(requireId(threadIdValue, 'threadId')))

  handle(channels.selectThread, async (_event, threadIdValue) => {
    const previous = store.snapshot().selectedThreadId
    const threadId = threadIdValue === undefined ? undefined : requireId(threadIdValue, 'threadId')
    if (threadId) {
      const thread = threadById(threadId)
      if (thread.deletedAt) throw new Error('Restore this thread before opening it')
    }
    if (previous && previous !== threadId) await previewService.close(previous).catch(() => undefined)
    store.update((state) => {
      state.selectedThreadId = threadId
      const selected = state.threads.find((item) => item.id === threadId)
      if (selected) selected.unread = false
    })
  })

  handle(channels.openThread, (_event, threadIdValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    if (threadById(threadId).deletedAt) throw new Error('Restore this thread before opening it')
    return processes.open(threadId)
  })
  handle(channels.restartThread, (_event, threadIdValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    if (threadById(threadId).deletedAt) throw new Error('Restore this thread before opening it')
    return processes.restart(threadId)
  })
  handle(channels.restartThreadWithoutCapabilities, async (_event, threadIdValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const thread = threadById(threadId)
    if (thread.deletedAt) throw new Error('Restore this thread before opening it')
    const capabilities = await listPiCapabilities(thread, store.snapshot().settings)
    store.update((state) => {
      const current = state.threads.find((item) => item.id === threadId)
      if (!current) return
      current.disabledCapabilityIds = disabledCapabilityIdsForSafeRestart(
        current.disabledCapabilityIds,
        capabilities
      )
    })
    return processes.restart(threadId)
  })
  handle(channels.sendMessage, async (_event, threadIdValue, messageValue, modeValue, attachmentsValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const thread = threadById(threadId)
    if (thread.deletedAt) throw new Error('Restore this thread before sending')
    if (thread.archived) throw new Error('Unarchive this thread before sending')
    const message = requireString(messageValue, 'message', { max: 2_000_000 })
    const attachments = await attachmentService.prepare(thread, parseAttachments(attachmentsValue))
    return processes.send(threadId, message, parseDeliveryMode(modeValue), attachments)
  })
  handle(channels.abortThread, (_event, threadId) => processes.abort(requireId(threadId, 'threadId')))
  handle(channels.setModel, (_event, threadIdValue, providerValue, modelValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    threadById(threadId)
    const provider = requireString(providerValue, 'provider', { max: 256 })
    const model = requireString(modelValue, 'model', { max: 512 })
    return processes.setModel(threadId, provider, model)
  })
  handle(channels.setThinkingLevel, (_event, threadIdValue, levelValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    threadById(threadId)
    const level = requireString(levelValue, 'thinkingLevel', { max: 16 })
    const levels: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    if (!levels.includes(level as ThinkingLevel)) throw new Error('Invalid thinking level')
    return processes.setThinkingLevel(threadId, level as ThinkingLevel)
  })
  handle(channels.getCapabilities, (_event, threadIdValue) => {
    const thread = threadById(requireId(threadIdValue, 'threadId'))
    return listPiCapabilities(thread, store.snapshot().settings)
  })
  handle(channels.setCapabilityEnabled, async (_event, threadIdValue, capabilityIdValue, enabledValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const thread = threadById(threadId)
    if (thread.status === 'running' || thread.status === 'waiting') {
      throw new Error('Stop the active turn before changing extensions or skills')
    }
    const capabilityId = requireString(capabilityIdValue, 'capabilityId', { max: 256 })
    const enabled = requireBoolean(enabledValue, 'enabled')
    const capabilities = await listPiCapabilities(thread, store.snapshot().settings)
    if (!capabilities.some((capability) => capability.id === capabilityId)) throw new Error('Capability not found')
    store.update((state) => {
      const current = state.threads.find((item) => item.id === threadId)
      if (!current) return
      const disabled = new Set(current.disabledCapabilityIds)
      if (enabled) disabled.delete(capabilityId)
      else disabled.add(capabilityId)
      current.disabledCapabilityIds = [...disabled]
    })
    return processes.restart(threadId)
  })
  handle(channels.getCommands, (_event, threadIdValue) => processes.commands(requireId(threadIdValue, 'threadId')))
  handle(channels.compactThread, (_event, threadIdValue, instructionsValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const instructions = instructionsValue === undefined
      ? undefined
      : requireString(instructionsValue, 'compaction instructions', { max: 100_000, allowEmpty: true }).trim() || undefined
    return processes.compact(threadId, instructions)
  })
  handle(channels.setAutoCompaction, (_event, threadIdValue, enabledValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    return processes.setAutoCompaction(threadId, requireBoolean(enabledValue, 'enabled'))
  })
  handle(channels.setAutoRetry, (_event, threadIdValue, enabledValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    return processes.setAutoRetry(threadId, requireBoolean(enabledValue, 'enabled'))
  })
  handle(channels.getUsageDashboard, (_event, projectIdValue) => {
    const projectId = projectIdValue === undefined ? undefined : requireId(projectIdValue, 'projectId')
    if (projectId) projectById(projectId)
    return usageDashboard(projectId)
  })
  handle(channels.searchProjectFiles, (_event, threadIdValue, queryValue, limitValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const query = requireString(queryValue, 'file query', { max: 1_000, allowEmpty: true })
    const limit = limitValue === undefined ? 40 : requireInteger(limitValue, 'limit', 1, 100)
    return workspaceService.searchFiles(threadId, query, limit)
  })
  handle(channels.getRecentFiles, (_event, threadIdValue) => {
    return workspaceService.recentFiles(requireId(threadIdValue, 'threadId'))
  })
  handle(channels.pickAttachments, (_event, threadIdValue) => {
    const thread = threadById(requireId(threadIdValue, 'threadId'))
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    return attachmentService.pick(owner, thread)
  })
  handle(channels.listPromptTemplates, () => listPromptTemplates(store))
  handle(channels.savePromptTemplate, (_event, value) => {
    if (!isRecord(value)) throw new TypeError('Prompt template is invalid')
    savePromptTemplate(store, {
      ...(value.id === undefined ? {} : { id: requireId(value.id, 'templateId') }),
      title: requireString(value.title, 'prompt title', { max: 120 }),
      prompt: requireString(value.prompt, 'prompt', { max: 200_000 })
    })
    return listPromptTemplates(store)
  })
  handle(channels.deletePromptTemplate, (_event, templateIdValue) => {
    deletePromptTemplate(store, requireId(templateIdValue, 'templateId'))
    return listPromptTemplates(store)
  })
  handle(channels.getHistory, (_event, threadId) => processes.history(requireId(threadId, 'threadId')))
  handle(channels.branchThread, (_event, sourceThreadIdValue, entryIdValue) => {
    const sourceThreadId = requireId(sourceThreadIdValue, 'sourceThreadId')
    const source = threadById(sourceThreadId)
    return createThread({
      projectId: source.projectId,
      isolated: projectById(source.projectId).isGit,
      branchFrom: { sourceThreadId, entryId: requireId(entryIdValue, 'entryId') }
    })
  })
  handle(channels.updateThread, async (_event, threadIdValue, updateValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const previous = threadById(threadId)
    const update = parseThreadUpdate(updateValue)
    const updated = updateThreadMetadata(store, threadId, update)
    if (updated.title !== previous.title) await processes.setSessionName(threadId, updated.title).catch(() => undefined)
    if (updated.archived && !previous.archived) {
      await Promise.allSettled([
        processes.close(threadId),
        terminalService.closeThread(threadId),
        previewService.close(threadId)
      ])
      store.update((state) => {
        if (state.selectedThreadId === threadId) state.selectedThreadId = undefined
      })
    }
    return threadById(threadId)
  })
  handle(channels.duplicateThread, (_event, threadIdValue) => {
    return duplicateThreadRecord(requireId(threadIdValue, 'threadId'))
  })
  handle(channels.restoreThread, async (_event, threadIdValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const thread = threadById(threadId)
    if (!thread.deletedAt) throw new Error('Thread is not in Trash')
    const details = await stat(thread.cwd).catch(() => undefined)
    if (!details?.isDirectory()) {
      throw new Error('The thread working directory no longer exists. Restore it before restoring the thread.')
    }
    return restoreTrashedThread(store, threadId)
  })
  handle(channels.purgeThread, async (_event, threadIdValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const thread = threadById(threadId)
    if (!thread.deletedAt) throw new Error('Move the thread to Trash before deleting it permanently')
    const options = {
      type: 'warning' as const,
      title: 'Delete Thread Permanently?',
      message: `Delete “${thread.title}” permanently?`,
      detail: 'Its CodePi metadata and session listing will be removed. This cannot be undone.',
      buttons: ['Cancel', 'Delete Permanently'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }
    const answer = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    if (answer.response !== 1) throw new Error('Permanent deletion was cancelled')
    return purgeThreadPermanently(threadId)
  })
  handle(channels.searchThreads, (_event, queryValue) => {
    const query = requireString(queryValue, 'search query', { max: 512, allowEmpty: true })
    return transcriptSearch.search({
      query,
      threads: store.snapshot().threads.filter((thread) => !thread.deletedAt),
      location: 'all',
      limit: 80
    }).then((results) => results.map(({ source: _source, score: _score, ...result }) => result))
  })
  handle(channels.exportThread, async (_event, threadIdValue, formatValue) => {
    const thread = threadById(requireId(threadIdValue, 'threadId'))
    const project = projectById(thread.projectId)
    const format = parseExportFormat(formatValue)
    const extension = format === 'markdown' ? 'md' : 'html'
    const safeTitle = thread.title.replace(/[^A-Za-z0-9._ -]+/g, '-').trim().slice(0, 120) || 'CodePi-thread'
    const options = {
      title: `Export ${thread.title}`,
      defaultPath: `${safeTitle}.${extension}`,
      filters: [{ name: format === 'markdown' ? 'Markdown' : 'HTML', extensions: [extension] }]
    }
    const save = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (save.canceled || !save.filePath) return null
    // Prefer the raw session JSONL: processes.messages() bounds payloads for
    // the renderer (truncated tool output, collapsed attachments, stripped
    // image data), which must never leak into an export.
    const messages = thread.sessionFile
      ? await readSessionMessages(thread.sessionFile)
      : processes.has(thread.id)
        ? await processes.messages(thread.id)
        : []
    const result = await exportThreadToPath({
      thread,
      messages,
      projectName: project.name,
      includeThinking: true,
      includeTools: true,
      outputPath: save.filePath,
      format
    })
    return { path: result.path }
  })

  handle(channels.getChanges, (_event, threadIdValue) => {
    const thread = threadById(requireId(threadIdValue, 'threadId'))
    return projectById(thread.projectId).isGit ? getChanges(thread) : []
  })
  handle(channels.setFileStaged, (_event, threadIdValue, pathValue, stagedValue) => {
    const thread = threadById(requireId(threadIdValue, 'threadId'))
    const project = projectById(thread.projectId)
    if (!project.isGit) return
    const requestedPath = requireRepoPath(pathValue)
    const staged = requireBoolean(stagedValue, 'staged')
    return getChanges(thread).then((files) => {
      const selected = files.find((file) => (file.to || file.from) === requestedPath)
      const paths = selected
        ? [selected.from, selected.to]
            .filter((path): path is string => Boolean(path))
            .map((path) => requireRepoPath(path))
        : [requestedPath]
      return setFileStaged(thread.cwd, paths, staged)
    })
  })
  handle(channels.commit, (_event, inputValue) => {
    const input = parseCommitInput(inputValue)
    const thread = threadById(input.threadId)
    if (!projectById(thread.projectId).isGit) throw new Error('This project is not a Git repository')
    return commitChanges(thread, input.message.trim(), input.push)
  })
  handle(channels.applyToMain, (_event, threadIdValue) => {
    const thread = threadById(requireId(threadIdValue, 'threadId'))
    const project = projectById(thread.projectId)
    return applyWorktreeToMain(project.path, thread)
  })
  handle(channels.openInEditor, (_event, threadIdValue) => {
    const thread = threadById(requireId(threadIdValue, 'threadId'))
    return openDirectoryInEditor(thread.cwd)
  })
  handle(channels.listWorkspaceFiles, (_event, threadIdValue) => {
    return workspaceService.listFiles(requireId(threadIdValue, 'threadId'))
  })
  handle(channels.readWorkspaceFile, (_event, threadIdValue, pathValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    return workspaceService.readFile(threadId, requireRepoPath(pathValue))
  })
  handle(channels.openTerminal, (_event, threadIdValue, columnsValue, rowsValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const columns = requireInteger(columnsValue, 'columns', 2, 500)
    const rows = requireInteger(rowsValue, 'rows', 1, 300)
    return terminalService.open(threadId, columns, rows)
  })
  handle(channels.writeTerminal, (_event, terminalIdValue, dataValue) => {
    const terminalId = requireId(terminalIdValue, 'terminalId')
    terminalService.write(terminalId, requireString(dataValue, 'terminal input', { max: 64 * 1024, allowEmpty: true }))
  })
  handle(channels.resizeTerminal, (_event, terminalIdValue, columnsValue, rowsValue) => {
    const terminalId = requireId(terminalIdValue, 'terminalId')
    terminalService.resize(
      terminalId,
      requireInteger(columnsValue, 'columns', 2, 500),
      requireInteger(rowsValue, 'rows', 1, 300)
    )
  })
  handle(channels.closeTerminal, (_event, terminalIdValue) => {
    return terminalService.close(requireId(terminalIdValue, 'terminalId'))
  })
  handle(channels.openPreview, (_event, threadIdValue, urlValue, boundsValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const url = requireString(urlValue, 'preview URL', { max: 4_096 })
    return previewService.open(threadId, url, parseViewBounds(boundsValue))
  })
  handle(channels.setPreviewBounds, (_event, threadIdValue, boundsValue) => {
    previewService.setBounds(requireId(threadIdValue, 'threadId'), parseViewBounds(boundsValue))
  })
  handle(channels.previewAction, (_event, threadIdValue, actionValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    if (actionValue !== 'back' && actionValue !== 'forward' && actionValue !== 'reload') {
      throw new TypeError('Preview action is invalid')
    }
    previewService.action(threadId, actionValue)
  })
  handle(channels.closePreview, (_event, threadIdValue) => {
    return previewService.close(requireId(threadIdValue, 'threadId'))
  })

  handle(channels.openSettings, () => openSettingsWindow())
  handle(channels.getSettings, () => store.snapshot().settings, 'settings')
  handle(channels.saveSettings, async (_event, value) => {
    const settings = parseSettings(value)
    const validation = await validatePiBinary(settings.piPath, settings.env)
    if (!validation.available) throw new Error(validation.error ?? 'Pi is unavailable')
    store.update((state) => {
      state.settings = settings
    })
    applyTheme(settings)
    return structuredClone(settings)
  }, 'settings')
  handle(channels.validatePi, (_event, pathValue) => {
    const path = requireString(pathValue, 'Pi path', { max: 4096 })
    return validatePiBinary(path, store.snapshot().settings.env)
  }, 'settings')
}

async function start(): Promise<void> {
  app.setName('CodePi')
  const developmentUserData = process.env.CODEPI_USER_DATA_DIR?.trim()
  if (!app.isPackaged && developmentUserData) {
    const userDataPath = resolve(developmentUserData)
    await mkdir(userDataPath, { recursive: true })
    app.setPath('userData', userDataPath)
  }
  await app.whenReady()
  store = await StateStore.open(app.getPath('userData'))
  applyTheme(store.snapshot().settings)
  await recoverSessions()
  processes = new PiProcessManager(store, emitThreadEvent)
  attachmentService = new AttachmentService(join(app.getPath('userData'), 'attachments'))
  workspaceService = new WorkspaceService(threadById)
  terminalService = new TerminalService(threadById, emitTerminalEvent)
  previewService = new PreviewService(threadById, () => mainWindow, emitPreviewEvent)
  registerIpc()
  createApplicationMenu()
  mainWindow = createMainWindow()

  nativeTheme.on('updated', broadcastTheme)
  app.on('activate', () => {
    if (!mainWindow) mainWindow = createMainWindow()
    else mainWindow.show()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (readyToQuit) return
  event.preventDefault()
  if (quitInProgress) return
  quitInProgress = true
  const shutdownTasks = [
    processes?.stopAll() ?? Promise.resolve(),
    terminalService?.stopAll() ?? Promise.resolve(),
    previewService?.destroy() ?? Promise.resolve(),
    store?.flush() ?? Promise.resolve()
  ]
  void Promise.allSettled(shutdownTasks).then((results) => {
    const stateFlush = results[3]
    if (stateFlush.status === 'rejected') {
      dialog.showErrorBox(
        'CodePi could not save its state',
        stateFlush.reason instanceof Error ? stateFlush.reason.message : String(stateFlush.reason)
      )
    }
  }).finally(() => {
    readyToQuit = true
    app.quit()
  })
})

void start().catch((error) => {
  dialog.showErrorBox('CodePi could not start', error instanceof Error ? error.message : String(error))
  app.exit(1)
})
