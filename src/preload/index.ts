import { contextBridge, ipcRenderer } from 'electron'
import type { CodePiApi, MenuAction, PreviewEvent, TerminalEvent, ThreadEvent } from '../shared/contracts'
import { ipcChannels as channels } from '../shared/ipc-channels'

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
  restartThreadWithoutCapabilities: (threadId) => ipcRenderer.invoke(channels.restartThreadWithoutCapabilities, threadId),
  sendMessage: (threadId, message, mode, attachments) => ipcRenderer.invoke(channels.sendMessage, threadId, message, mode, attachments),
  abortThread: (threadId) => ipcRenderer.invoke(channels.abortThread, threadId),
  setModel: (threadId, provider, modelId) => ipcRenderer.invoke(channels.setModel, threadId, provider, modelId),
  setThinkingLevel: (threadId, level) => ipcRenderer.invoke(channels.setThinkingLevel, threadId, level),
  getCapabilities: (threadId) => ipcRenderer.invoke(channels.getCapabilities, threadId),
  setCapabilityEnabled: (threadId, capabilityId, enabled) => ipcRenderer.invoke(channels.setCapabilityEnabled, threadId, capabilityId, enabled),
  getCommands: (threadId) => ipcRenderer.invoke(channels.getCommands, threadId),
  compactThread: (threadId, customInstructions) => ipcRenderer.invoke(channels.compactThread, threadId, customInstructions),
  setAutoCompaction: (threadId, enabled) => ipcRenderer.invoke(channels.setAutoCompaction, threadId, enabled),
  setAutoRetry: (threadId, enabled) => ipcRenderer.invoke(channels.setAutoRetry, threadId, enabled),
  getUsageDashboard: (projectId) => ipcRenderer.invoke(channels.getUsageDashboard, projectId),
  searchProjectFiles: (threadId, query, limit) => ipcRenderer.invoke(channels.searchProjectFiles, threadId, query, limit),
  getRecentFiles: (threadId) => ipcRenderer.invoke(channels.getRecentFiles, threadId),
  pickAttachments: (threadId) => ipcRenderer.invoke(channels.pickAttachments, threadId),
  listPromptTemplates: () => ipcRenderer.invoke(channels.listPromptTemplates),
  savePromptTemplate: (template) => ipcRenderer.invoke(channels.savePromptTemplate, template),
  deletePromptTemplate: (templateId) => ipcRenderer.invoke(channels.deletePromptTemplate, templateId),
  getHistory: (threadId) => ipcRenderer.invoke(channels.getHistory, threadId),
  branchThread: (sourceThreadId, entryId) => ipcRenderer.invoke(channels.branchThread, sourceThreadId, entryId),
  updateThread: (threadId, update) => ipcRenderer.invoke(channels.updateThread, threadId, update),
  duplicateThread: (threadId) => ipcRenderer.invoke(channels.duplicateThread, threadId),
  restoreThread: (threadId) => ipcRenderer.invoke(channels.restoreThread, threadId),
  purgeThread: (threadId) => ipcRenderer.invoke(channels.purgeThread, threadId),
  searchThreads: (query) => ipcRenderer.invoke(channels.searchThreads, query),
  exportThread: (threadId, format) => ipcRenderer.invoke(channels.exportThread, threadId, format),
  getChanges: (threadId) => ipcRenderer.invoke(channels.getChanges, threadId),
  setFileStaged: (threadId, path, staged) => ipcRenderer.invoke(channels.setFileStaged, threadId, path, staged),
  commit: (input) => ipcRenderer.invoke(channels.commit, input),
  applyToMain: (threadId) => ipcRenderer.invoke(channels.applyToMain, threadId),
  openInEditor: (threadId) => ipcRenderer.invoke(channels.openInEditor, threadId),
  listWorkspaceFiles: (threadId) => ipcRenderer.invoke(channels.listWorkspaceFiles, threadId),
  readWorkspaceFile: (threadId, path) => ipcRenderer.invoke(channels.readWorkspaceFile, threadId, path),
  openTerminal: (threadId, columns, rows) => ipcRenderer.invoke(channels.openTerminal, threadId, columns, rows),
  writeTerminal: (terminalId, data) => ipcRenderer.invoke(channels.writeTerminal, terminalId, data),
  resizeTerminal: (terminalId, columns, rows) => ipcRenderer.invoke(channels.resizeTerminal, terminalId, columns, rows),
  closeTerminal: (terminalId) => ipcRenderer.invoke(channels.closeTerminal, terminalId),
  openPreview: (threadId, url, bounds) => ipcRenderer.invoke(channels.openPreview, threadId, url, bounds),
  setPreviewBounds: (threadId, bounds) => ipcRenderer.invoke(channels.setPreviewBounds, threadId, bounds),
  previewAction: (threadId, action) => ipcRenderer.invoke(channels.previewAction, threadId, action),
  closePreview: (threadId) => ipcRenderer.invoke(channels.closePreview, threadId),
  openSettings: () => ipcRenderer.invoke(channels.openSettings),
  getSettings: () => ipcRenderer.invoke(channels.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(channels.saveSettings, settings),
  validatePi: (path) => ipcRenderer.invoke(channels.validatePi, path),
  onThreadEvent: (listener) => subscribe<ThreadEvent>(channels.threadEvent, listener),
  onMenuAction: (listener) => subscribe<MenuAction>(channels.menuAction, listener),
  onThemeChanged: (listener) => subscribe<'light' | 'dark'>(channels.themeChanged, listener),
  onTerminalEvent: (listener) => subscribe<TerminalEvent>(channels.terminalEvent, listener),
  onPreviewEvent: (listener) => subscribe<PreviewEvent>(channels.previewEvent, listener)
}

contextBridge.exposeInMainWorld('codePi', api)
