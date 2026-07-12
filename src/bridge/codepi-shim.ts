/**
 * WKWebView bridge shim for the Swift shell.
 *
 * Injected as a WKUserScript at document start, this file plays the role the
 * Electron preload plays today: it exposes the full `window.codePi` API. It is
 * type-checked against `CodePiApi`, so any drift between the renderer contract
 * and the shell surfaces as a compile error.
 *
 * Transport:
 * - Requests: `webkit.messageHandlers.codepi.postMessage(JSON)` resolves with a
 *   JSON string reply (or rejects with the bridge error message).
 * - Events: the Swift shell evaluates `window.__codepiDispatch(channel, json)`
 *   where `json` is an array of coalesced event payloads for that channel.
 */
import type { CodePiApi } from '../shared/contracts'
import { ipcChannels as channels } from '../shared/ipc-channels'

interface BridgeMessageHandler {
  postMessage(body: string): Promise<unknown>
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, BridgeMessageHandler | undefined> }
    __codepiDispatch?: (channel: string, payloadsJson: string) => void
  }
}

const listeners = new Map<string, Set<(value: unknown) => void>>()

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  const wrapped = listener as (value: unknown) => void
  set.add(wrapped)
  return () => {
    set.delete(wrapped)
  }
}

window.__codepiDispatch = (channel, payloadsJson) => {
  const set = listeners.get(channel)
  if (!set || set.size === 0) return
  let payloads: unknown[]
  try {
    payloads = JSON.parse(payloadsJson) as unknown[]
  } catch (reason) {
    console.error('CodePi bridge received an undecodable event batch', channel, reason)
    return
  }
  for (const payload of payloads) {
    for (const listener of [...set]) listener(payload)
  }
}

async function invoke<T>(channel: string, args: unknown[] = []): Promise<T> {
  const handler = window.webkit?.messageHandlers?.codepi
  if (!handler) throw new Error('The CodePi bridge is unavailable in this web view')
  const trimmed = [...args]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop()
  const reply = await handler.postMessage(JSON.stringify({ channel, args: trimmed }))
  if (reply === null || reply === undefined) return undefined as T
  return JSON.parse(reply as string) as T
}

const api: CodePiApi = {
  bootstrap: () => invoke(channels.bootstrap),
  addProject: () => invoke(channels.addProject),
  toggleProject: (projectId, expanded) => invoke(channels.toggleProject, [projectId, expanded]),
  createThread: (input) => invoke(channels.createThread, [input]),
  deleteThread: (threadId) => invoke(channels.deleteThread, [threadId]),
  selectThread: (threadId) => invoke(channels.selectThread, [threadId]),
  openThread: (threadId) => invoke(channels.openThread, [threadId]),
  restartThread: (threadId) => invoke(channels.restartThread, [threadId]),
  restartThreadWithoutCapabilities: (threadId) => invoke(channels.restartThreadWithoutCapabilities, [threadId]),
  sendMessage: (threadId, message, mode, attachments) => invoke(channels.sendMessage, [threadId, message, mode, attachments]),
  abortThread: (threadId) => invoke(channels.abortThread, [threadId]),
  setModel: (threadId, provider, modelId) => invoke(channels.setModel, [threadId, provider, modelId]),
  setThinkingLevel: (threadId, level) => invoke(channels.setThinkingLevel, [threadId, level]),
  getCapabilities: (threadId) => invoke(channels.getCapabilities, [threadId]),
  setCapabilityEnabled: (threadId, capabilityId, enabled) => invoke(channels.setCapabilityEnabled, [threadId, capabilityId, enabled]),
  getCommands: (threadId) => invoke(channels.getCommands, [threadId]),
  compactThread: (threadId, customInstructions) => invoke(channels.compactThread, [threadId, customInstructions]),
  setAutoCompaction: (threadId, enabled) => invoke(channels.setAutoCompaction, [threadId, enabled]),
  setAutoRetry: (threadId, enabled) => invoke(channels.setAutoRetry, [threadId, enabled]),
  getUsageDashboard: (projectId) => invoke(channels.getUsageDashboard, [projectId]),
  searchProjectFiles: (threadId, query, limit) => invoke(channels.searchProjectFiles, [threadId, query, limit]),
  getRecentFiles: (threadId) => invoke(channels.getRecentFiles, [threadId]),
  pickAttachments: (threadId) => invoke(channels.pickAttachments, [threadId]),
  listPromptTemplates: () => invoke(channels.listPromptTemplates),
  savePromptTemplate: (template) => invoke(channels.savePromptTemplate, [template]),
  deletePromptTemplate: (templateId) => invoke(channels.deletePromptTemplate, [templateId]),
  getHistory: (threadId) => invoke(channels.getHistory, [threadId]),
  branchThread: (sourceThreadId, entryId) => invoke(channels.branchThread, [sourceThreadId, entryId]),
  updateThread: (threadId, update) => invoke(channels.updateThread, [threadId, update]),
  duplicateThread: (threadId) => invoke(channels.duplicateThread, [threadId]),
  restoreThread: (threadId) => invoke(channels.restoreThread, [threadId]),
  purgeThread: (threadId) => invoke(channels.purgeThread, [threadId]),
  searchThreads: (query) => invoke(channels.searchThreads, [query]),
  exportThread: (threadId, format) => invoke(channels.exportThread, [threadId, format]),
  getChanges: (threadId) => invoke(channels.getChanges, [threadId]),
  setFileStaged: (threadId, path, staged) => invoke(channels.setFileStaged, [threadId, path, staged]),
  commit: (input) => invoke(channels.commit, [input]),
  applyToMain: (threadId) => invoke(channels.applyToMain, [threadId]),
  openInEditor: (threadId) => invoke(channels.openInEditor, [threadId]),
  listWorkspaceFiles: (threadId) => invoke(channels.listWorkspaceFiles, [threadId]),
  readWorkspaceFile: (threadId, path) => invoke(channels.readWorkspaceFile, [threadId, path]),
  openTerminal: (threadId, columns, rows) => invoke(channels.openTerminal, [threadId, columns, rows]),
  writeTerminal: (terminalId, data) => invoke(channels.writeTerminal, [terminalId, data]),
  resizeTerminal: (terminalId, columns, rows) => invoke(channels.resizeTerminal, [terminalId, columns, rows]),
  closeTerminal: (terminalId) => invoke(channels.closeTerminal, [terminalId]),
  openPreview: (threadId, url, bounds) => invoke(channels.openPreview, [threadId, url, bounds]),
  setPreviewBounds: (threadId, bounds) => invoke(channels.setPreviewBounds, [threadId, bounds]),
  previewAction: (threadId, action) => invoke(channels.previewAction, [threadId, action]),
  closePreview: (threadId) => invoke(channels.closePreview, [threadId]),
  openSettings: () => invoke(channels.openSettings),
  getSettings: () => invoke(channels.getSettings),
  saveSettings: (settings) => invoke(channels.saveSettings, [settings]),
  validatePi: (path) => invoke(channels.validatePi, [path]),
  onThreadEvent: (listener) => subscribe(channels.threadEvent, listener),
  onMenuAction: (listener) => subscribe(channels.menuAction, listener),
  onThemeChanged: (listener) => subscribe(channels.themeChanged, listener),
  onTerminalEvent: (listener) => subscribe(channels.terminalEvent, listener),
  onPreviewEvent: (listener) => subscribe(channels.previewEvent, listener),
}

window.codePi = api
