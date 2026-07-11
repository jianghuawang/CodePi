import type {
  AgentMessage,
  AssistantMessage,
  PiModel,
  SessionState,
  SessionStats,
  SessionTreeNode,
  ThinkingLevel,
  ToolResultMessage
} from './contracts'

export interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export type PiThinkingLevel = ThinkingLevel
export type PiQueueMode = 'all' | 'one-at-a-time'
export type PiStreamingBehavior = 'steer' | 'followUp'

type PiRpcCommandBody =
  | {
      type: 'prompt'
      message: string
      images?: PiImageContent[]
      streamingBehavior?: PiStreamingBehavior
    }
  | { type: 'steer'; message: string; images?: PiImageContent[] }
  | { type: 'follow_up'; message: string; images?: PiImageContent[] }
  | { type: 'abort' }
  | { type: 'new_session'; parentSession?: string }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'cycle_model' }
  | { type: 'get_available_models' }
  | { type: 'set_thinking_level'; level: PiThinkingLevel }
  | { type: 'cycle_thinking_level' }
  | { type: 'set_steering_mode'; mode: PiQueueMode }
  | { type: 'set_follow_up_mode'; mode: PiQueueMode }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'abort_retry' }
  | { type: 'bash'; command: string }
  | { type: 'abort_bash' }
  | { type: 'get_session_stats' }
  | { type: 'export_html'; outputPath?: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'fork'; entryId: string }
  | { type: 'clone' }
  | { type: 'get_fork_messages' }
  | { type: 'get_last_assistant_text' }
  | { type: 'set_session_name'; name: string }
  | { type: 'get_commands' }

/** Exact command envelope accepted by Pi RPC mode. */
export type PiRpcCommand = PiRpcCommandBody & { id?: string }

export interface PiRpcSuccessResponse<T = unknown> {
  id?: string
  type: 'response'
  command: string
  success: true
  data?: T
}

export interface PiRpcFailureResponse {
  id?: string
  type: 'response'
  command: string
  success: false
  error: string
}

export type PiRpcResponse<T = unknown> = PiRpcSuccessResponse<T> | PiRpcFailureResponse

export interface PiRpcSessionState extends Omit<SessionState, 'model'> {
  model?: PiModel | null
  autoCompactionEnabled?: boolean
}

export interface PiRpcSessionStats extends SessionStats {
  sessionFile?: string
  sessionId?: string
  userMessages?: number
  assistantMessages?: number
  toolCalls?: number
  toolResults?: number
  totalMessages?: number
}

export interface PiSessionTree {
  tree: SessionTreeNode[]
  leafId: string | null
  sessionFile?: string
}

export interface PiToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type PiExtensionUiMethod =
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'notify'
  | 'setStatus'
  | 'setWidget'
  | 'setTitle'
  | 'set_editor_text'

export interface PiExtensionUiRequest {
  type: 'extension_ui_request'
  id: string
  method: PiExtensionUiMethod | string
  title?: string
  message?: string
  timeout?: number
  [key: string]: unknown
}

export type PiAssistantMessageEvent =
  | { type: 'start'; partial?: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial?: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial?: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial?: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial?: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial?: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial?: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial?: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial?: AssistantMessage }
  | {
      type: 'toolcall_end'
      contentIndex: number
      toolCall: PiToolCall
      partial?: AssistantMessage
    }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: AssistantMessage }

export type PiRpcEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | {
      type: 'message_update'
      message: AgentMessage
      assistantMessageEvent: PiAssistantMessageEvent
    }
  | { type: 'message_end'; message: AgentMessage }
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      partialResult: unknown
    }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: unknown
      isError: boolean
    }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'extension_error'; extensionPath?: string; event?: string; error: string }
  | PiExtensionUiRequest
  | {
      type: 'auto_retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | {
      type: 'compaction_end'
      reason?: 'manual' | 'threshold' | 'overflow'
      aborted: boolean
      willRetry?: boolean
      errorMessage?: string
      [key: string]: unknown
    }

export interface PiTextDeltaEvent {
  delta: string
  contentIndex: number
}

export interface PiThinkingDeltaEvent {
  delta: string
  contentIndex: number
}

export interface PiToolCallStartEvent {
  contentIndex: number
  toolCallId?: string
  toolName?: string
}

export interface PiToolCallArgsEvent extends PiToolCallStartEvent {
  delta: string
}

export interface PiToolCallEndEvent {
  contentIndex: number
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface PiToolExecutionStartEvent {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
}

export interface PiToolOutputEvent {
  toolCallId: string
  toolName: string
  output: string
  isError?: boolean
  complete: boolean
}

export interface PiTurnEndEvent {
  message: AssistantMessage
  toolResults: ToolResultMessage[]
}

export interface PiQueueEvent {
  steering: string[]
  followUp: string[]
}

export interface PiAgentSettledEvent {
  messages: AgentMessage[]
  source: 'agent_end'
}

export interface PiAbortedEvent {
  source: 'command' | 'agent'
  message?: AssistantMessage
}

export interface PiRpcErrorEvent {
  message: string
  recoverable: boolean
  source: 'agent' | 'command' | 'extension' | 'framing' | 'process'
  cause?: unknown
}

export interface PiProcessCrashEvent {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

/** EventEmitter tuple map exposed by PiRpcClient. */
export interface PiRpcClientEventMap {
  'agent-start': []
  'turn-start': []
  'text-delta': [event: PiTextDeltaEvent]
  'thinking-delta': [event: PiThinkingDeltaEvent]
  'tool-call-start': [event: PiToolCallStartEvent]
  'tool-call-args': [event: PiToolCallArgsEvent]
  'tool-call-end': [event: PiToolCallEndEvent]
  'tool-execution-start': [event: PiToolExecutionStartEvent]
  'tool-output': [event: PiToolOutputEvent]
  'message-end': [message: AgentMessage]
  'turn-end': [event: PiTurnEndEvent]
  queue: [event: PiQueueEvent]
  'agent-settled': [event: PiAgentSettledEvent]
  aborted: [event: PiAbortedEvent]
  error: [event: PiRpcErrorEvent]
  'process-crash': [event: PiProcessCrashEvent]
  stderr: [chunk: string]
  'raw-event': [event: PiRpcEvent]
}
