import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
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
  ProjectRecord,
  ThinkingLevel,
  ThreadEvent,
  ThreadRecord
} from '../shared/contracts'
import {
  applyWorktreeToMain,
  commitChanges,
  createWorktree,
  getChanges,
  getWorktreeRemovalRisk,
  isGitProject,
  openDirectoryInEditor,
  removeWorktree,
  setFileStaged
} from './git-service'
import { PiProcessManager } from './pi-manager'
import { validatePiBinary } from './pi-validation'
import { currentPlatform, mainWindowPlatformOptions, settingsWindowPlatformOptions } from './platform'
import {
  cloneSessionAtEntry,
  discoverProjectSessions,
  recoveredThreadId
} from './sessions'
import { StateStore } from './state-store'
import {
  parseCommitInput,
  parseCreateThreadInput,
  parseDeliveryMode,
  parseSettings,
  requireBoolean,
  requireId,
  requireRepoPath,
  requireString
} from './validation'

const channels = {
  bootstrap: 'codepi:bootstrap',
  addProject: 'codepi:add-project',
  toggleProject: 'codepi:toggle-project',
  createThread: 'codepi:create-thread',
  deleteThread: 'codepi:delete-thread',
  selectThread: 'codepi:select-thread',
  openThread: 'codepi:open-thread',
  restartThread: 'codepi:restart-thread',
  sendMessage: 'codepi:send-message',
  abortThread: 'codepi:abort-thread',
  setModel: 'codepi:set-model',
  setThinkingLevel: 'codepi:set-thinking-level',
  getHistory: 'codepi:get-history',
  branchThread: 'codepi:branch-thread',
  getChanges: 'codepi:get-changes',
  setFileStaged: 'codepi:set-file-staged',
  commit: 'codepi:commit',
  applyToMain: 'codepi:apply-to-main',
  openInEditor: 'codepi:open-in-editor',
  openSettings: 'codepi:open-settings',
  getSettings: 'codepi:get-settings',
  saveSettings: 'codepi:save-settings',
  validatePi: 'codepi:validate-pi',
  threadEvent: 'codepi:thread-event',
  menuAction: 'codepi:menu-action',
  themeChanged: 'codepi:theme-changed'
} as const

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let store: StateStore
let processes: PiProcessManager
let quitInProgress = false
let readyToQuit = false

function publicState(): PersistedState {
  const { dismissedSessionFiles: _dismissed, ...state } = store.snapshot()
  return { ...state, settings: { ...state.settings, env: {} } }
}

function threadById(threadId: string): ThreadRecord {
  const thread = store.snapshot().threads.find((item) => item.id === threadId)
  if (!thread) throw new Error('Thread not found')
  return thread
}

function projectById(projectId: string): ProjectRecord {
  const project = store.snapshot().projects.find((item) => item.id === projectId)
  if (!project) throw new Error('Project not found')
  return project
}

function emitThreadEvent(event: ThreadEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channels.threadEvent, event)
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
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  void loadRenderer(window, 'main')
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
        { role: 'selectAll' }
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
  if (input.isolated && project.isGit) {
    worktree = await createWorktree(project.path, id)
    cwd = worktree.path
  }

  let sessionFile: string | undefined
  try {
    if (input.branchFrom) {
      let source = threadById(input.branchFrom.sourceThreadId)
      if (source.projectId !== project.id) throw new Error('History can only branch within its project')
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
          sessionFile: file
        })
        existing.add(file)
      }
    }
    if (state.selectedThreadId && !state.threads.some((thread) => thread.id === state.selectedThreadId)) {
      state.selectedThreadId = undefined
    }
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
  handle(channels.deleteThread, async (_event, threadIdValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    const thread = threadById(threadId)
    const project = projectById(thread.projectId)
    await processes.close(threadId)
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
          title: 'Delete Thread?',
          message: `This isolated worktree has ${details}.`,
          detail: 'Deleting the thread will permanently remove its local worktree and local branch.',
          buttons: ['Cancel', 'Delete Thread'],
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
    store.update((state) => {
      state.threads = state.threads.filter((item) => item.id !== threadId)
      if (thread.sessionFile) {
        const dismissed = new Set(state.dismissedSessionFiles ?? [])
        dismissed.add(resolve(thread.sessionFile))
        state.dismissedSessionFiles = [...dismissed]
      }
      if (state.selectedThreadId === threadId) state.selectedThreadId = undefined
    })
  })

  handle(channels.selectThread, (_event, threadIdValue) => {
    if (threadIdValue !== undefined) threadById(requireId(threadIdValue, 'threadId'))
    store.update((state) => {
      state.selectedThreadId = threadIdValue === undefined ? undefined : String(threadIdValue)
    })
  })

  handle(channels.openThread, (_event, threadId) => processes.open(requireId(threadId, 'threadId')))
  handle(channels.restartThread, (_event, threadId) => processes.restart(requireId(threadId, 'threadId')))
  handle(channels.sendMessage, (_event, threadIdValue, messageValue, modeValue) => {
    const threadId = requireId(threadIdValue, 'threadId')
    threadById(threadId)
    const message = requireString(messageValue, 'message', { max: 2_000_000 })
    return processes.send(threadId, message, parseDeliveryMode(modeValue))
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
  await app.whenReady()
  store = await StateStore.open(app.getPath('userData'))
  applyTheme(store.snapshot().settings)
  await recoverSessions()
  processes = new PiProcessManager(store, emitThreadEvent)
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
  void Promise.allSettled([processes?.stopAll(), store?.flush()]).finally(() => {
    readyToQuit = true
    app.quit()
  })
})

void start().catch((error) => {
    dialog.showErrorBox('CodePi could not start', error instanceof Error ? error.message : String(error))
  app.exit(1)
})
