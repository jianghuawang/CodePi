import { contextBridge, ipcRenderer } from 'electron'
import type { CodePiApi, MenuAction, ThreadEvent } from '../shared/contracts'

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

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: CodePiApi = {
  bootstrap: () => ipcRenderer.invoke(channels.bootstrap),
  addProject: () => ipcRenderer.invoke(channels.addProject),
  toggleProject: (projectId, expanded) => ipcRenderer.invoke(channels.toggleProject, projectId, expanded),
  createThread: (input) => ipcRenderer.invoke(channels.createThread, input),
  deleteThread: (threadId) => ipcRenderer.invoke(channels.deleteThread, threadId),
  selectThread: (threadId) => ipcRenderer.invoke(channels.selectThread, threadId),
  openThread: (threadId) => ipcRenderer.invoke(channels.openThread, threadId),
  restartThread: (threadId) => ipcRenderer.invoke(channels.restartThread, threadId),
  sendMessage: (threadId, message, mode) => ipcRenderer.invoke(channels.sendMessage, threadId, message, mode),
  abortThread: (threadId) => ipcRenderer.invoke(channels.abortThread, threadId),
  setModel: (threadId, provider, modelId) => ipcRenderer.invoke(channels.setModel, threadId, provider, modelId),
  setThinkingLevel: (threadId, level) => ipcRenderer.invoke(channels.setThinkingLevel, threadId, level),
  getHistory: (threadId) => ipcRenderer.invoke(channels.getHistory, threadId),
  branchThread: (sourceThreadId, entryId) => ipcRenderer.invoke(channels.branchThread, sourceThreadId, entryId),
  getChanges: (threadId) => ipcRenderer.invoke(channels.getChanges, threadId),
  setFileStaged: (threadId, path, staged) => ipcRenderer.invoke(channels.setFileStaged, threadId, path, staged),
  commit: (input) => ipcRenderer.invoke(channels.commit, input),
  applyToMain: (threadId) => ipcRenderer.invoke(channels.applyToMain, threadId),
  openInEditor: (threadId) => ipcRenderer.invoke(channels.openInEditor, threadId),
  openSettings: () => ipcRenderer.invoke(channels.openSettings),
  getSettings: () => ipcRenderer.invoke(channels.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(channels.saveSettings, settings),
  validatePi: (path) => ipcRenderer.invoke(channels.validatePi, path),
  onThreadEvent: (listener) => subscribe<ThreadEvent>(channels.threadEvent, listener),
  onMenuAction: (listener) => subscribe<MenuAction>(channels.menuAction, listener),
  onThemeChanged: (listener) => subscribe<'light' | 'dark'>(channels.themeChanged, listener)
}

contextBridge.exposeInMainWorld('codePi', api)
