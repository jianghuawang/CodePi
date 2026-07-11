import type { SessionStats } from '../shared/contracts'

export interface LiveTextSegment {
  type: 'text'
  text: string
}

export interface LiveThinkingSegment {
  type: 'thinking'
  text: string
}

export interface LiveToolSegment {
  type: 'tool'
  id: string
  name: string
  argsText: string
  args?: Record<string, unknown>
  output: string
  isError: boolean
  complete: boolean
}

export type LiveSegment = LiveTextSegment | LiveThinkingSegment | LiveToolSegment

export interface LiveTurn {
  segments: Record<number, LiveSegment>
  stats?: SessionStats
}
