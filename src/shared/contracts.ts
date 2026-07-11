export type ThemeMode = 'system' | 'light' | 'dark'
export type ThreadStatus = 'idle' | 'running' | 'waiting' | 'error'
export type DeliveryMode = 'prompt' | 'steer' | 'followUp'
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
  isGit: boolean
  expanded: boolean
  createdAt: number
}

export interface WorktreeRecord {
  path: string
  branch: string
  baseBranch: string
  baseCommit: string
}

export interface ThreadRecord {
  id: string
  projectId: string
  title: string
  cwd: string
  status: ThreadStatus
  createdAt: number
  updatedAt: number
  sessionFile?: string
  lastError?: string
  worktree?: WorktreeRecord
}

export interface AppSettings {
  piPath: string
  defaultModel: string
  theme: ThemeMode
  env: Record<string, string>
}

export interface PersistedState {
  version: 1
  projects: ProjectRecord[]
  threads: ThreadRecord[]
  selectedThreadId?: string
  windowBounds: WindowBounds
  settings: AppSettings
}

export interface PiModel {
  id: string
  name: string
  provider: string
  api?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
}

export interface UsageCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
}

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost?: UsageCost
}

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AssistantContent = TextContent | ThinkingContent | ToolCallContent

export interface UserMessage {
  role: 'user'
  content: string | Array<TextContent | { type: 'image'; data?: string; mimeType?: string }>
  timestamp: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContent[]
  provider?: string
  model?: string
  usage?: PiUsage
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  timestamp: number
}

export interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: TextContent[]
  isError: boolean
  timestamp: number
}

export interface BashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
  timestamp: number
}

export interface CustomMessage {
  role: 'custom'
  customType: string
  content: string | Array<TextContent | { type: 'image'; data?: string; mimeType?: string }>
  display: boolean
  details?: unknown
  timestamp: number
}

export interface BranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId: string
  timestamp: number
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore: number
  timestamp: number
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage

export interface SessionState {
  model: PiModel | null
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: 'all' | 'one-at-a-time'
  followUpMode: 'all' | 'one-at-a-time'
  sessionFile?: string
  sessionId: string
  sessionName?: string
  messageCount: number
  pendingMessageCount: number
}

export interface SessionStats {
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

export interface SessionEntry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  message?: AgentMessage
  [key: string]: unknown
}

export interface SessionTreeNode {
  entry: SessionEntry
  children: SessionTreeNode[]
  label?: string
  labelTimestamp?: string
}

export interface OpenThreadResult {
  thread: ThreadRecord
  state: SessionState
  messages: AgentMessage[]
  models: PiModel[]
  tree: SessionTreeNode[]
}

export interface DiffLine {
  type: 'add' | 'del' | 'normal'
  content: string
  oldNumber?: number
  newNumber?: number
}

export interface DiffChunk {
  content: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  changes: DiffLine[]
}

export interface DiffFile {
  from: string
  to: string
  additions: number
  deletions: number
  chunks: DiffChunk[]
  staged: boolean
  stageable: boolean
  binary?: boolean
}

export type ThreadEvent =
  | { type: 'status'; threadId: string; status: ThreadStatus; error?: string }
  | { type: 'agent-start'; threadId: string }
  | { type: 'text-delta'; threadId: string; delta: string; contentIndex: number }
  | { type: 'thinking-delta'; threadId: string; delta: string; contentIndex: number }
  | { type: 'tool-call-start'; threadId: string; toolCallId?: string; toolName?: string; contentIndex?: number }
  | { type: 'tool-call-args'; threadId: string; toolCallId?: string; delta: string; contentIndex?: number }
  | { type: 'tool-call-end'; threadId: string; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-output'; threadId: string; toolCallId: string; toolName: string; output: string; isError?: boolean; complete: boolean }
  | { type: 'message-end'; threadId: string; message: AgentMessage }
  | { type: 'turn-end'; threadId: string; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: 'queue'; threadId: string; steering: string[]; followUp: string[] }
  | { type: 'settled'; threadId: string; stats?: SessionStats }
  | { type: 'aborted'; threadId: string }
  | { type: 'error'; threadId: string; message: string; recoverable: boolean }

export type MenuAction = 'new-thread' | 'new-project' | 'settings'

export interface BootstrapData {
  state: PersistedState
  pi: { available: boolean; path: string; version?: string; error?: string }
  platform: 'darwin' | 'win32' | 'linux'
}

export interface CreateThreadInput {
  projectId: string
  title?: string
  isolated: boolean
  branchFrom?: { sourceThreadId: string; entryId: string }
}

export interface CommitInput {
  threadId: string
  message: string
  push: boolean
}

export interface CodePiApi {
  bootstrap(): Promise<BootstrapData>
  addProject(): Promise<ProjectRecord | null>
  toggleProject(projectId: string, expanded: boolean): Promise<void>
  createThread(input: CreateThreadInput): Promise<ThreadRecord>
  deleteThread(threadId: string): Promise<void>
  selectThread(threadId?: string): Promise<void>
  openThread(threadId: string): Promise<OpenThreadResult>
  restartThread(threadId: string): Promise<OpenThreadResult>
  sendMessage(threadId: string, message: string, mode: DeliveryMode): Promise<void>
  abortThread(threadId: string): Promise<void>
  setModel(threadId: string, provider: string, modelId: string): Promise<PiModel>
  setThinkingLevel(threadId: string, level: ThinkingLevel): Promise<ThinkingLevel>
  getHistory(threadId: string): Promise<{ tree: SessionTreeNode[]; leafId: string | null }>
  branchThread(sourceThreadId: string, entryId: string): Promise<ThreadRecord>
  getChanges(threadId: string): Promise<DiffFile[]>
  setFileStaged(threadId: string, path: string, staged: boolean): Promise<void>
  commit(input: CommitInput): Promise<{ commit: string; pushed: boolean }>
  applyToMain(threadId: string): Promise<void>
  openInEditor(threadId: string): Promise<void>
  openSettings(): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  validatePi(path: string): Promise<{ available: boolean; path: string; version?: string; error?: string }>
  onThreadEvent(listener: (event: ThreadEvent) => void): () => void
  onMenuAction(listener: (action: MenuAction) => void): () => void
  onThemeChanged(listener: (theme: 'light' | 'dark') => void): () => void
}
