import {
  Activity,
  CalendarDays,
  Coins,
  Gauge,
  RefreshCw,
  Sparkles,
  TimerReset,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  SessionState,
  SessionStats,
  UsageDashboard
} from '../../shared/contracts'
import { useOutsideClick } from '../hooks/useOutsideClick'

export interface UsageDashboardPopoverProps {
  threadId: string
  projectId: string
  state: SessionState
  stats?: SessionStats
  onStateChange: (state: SessionState) => void | Promise<void>
  onStatsChange: (stats: SessionStats | undefined) => void | Promise<void>
  onClose: () => void
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000 ? 1 : 0
  }).format(value)
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value < 0.01) return `<$0.01`
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 3 : 2
  }).format(value)
}

function shortDay(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.getTime())
    ? value.slice(-5)
    : new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(date)
}

export function UsageDashboardPopover({
  threadId,
  projectId,
  state,
  stats,
  onStateChange,
  onStatsChange,
  onClose
}: UsageDashboardPopoverProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dashboard, setDashboard] = useState<UsageDashboard>()
  const [currentState, setCurrentState] = useState(state)
  const [currentStats, setCurrentStats] = useState(stats)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'compact' | 'compaction' | 'retry'>()
  const [error, setError] = useState<string>()
  useOutsideClick(rootRef, onClose)

  useEffect(() => setCurrentState(state), [state])
  useEffect(() => setCurrentStats(stats), [stats])

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setDashboard(await window.codePi.getUsageDashboard(projectId))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])

  const contextPercent = Math.max(0, Math.min(100, currentStats?.contextUsage?.percent ?? 0))
  const contextTokens = currentStats?.contextUsage?.tokens
  const contextWindow = currentStats?.contextUsage?.contextWindow
  const visibleDays = useMemo(() => dashboard?.days.slice(-14) ?? [], [dashboard])
  const maxDayTokens = Math.max(1, ...visibleDays.map((day) => day.tokens))
  const autoCompaction = currentState.autoCompactionEnabled ?? true
  const autoRetry = currentState.autoRetryEnabled ?? true

  // Patch on top of the latest state (tracked via ref) so a publish after an
  // await cannot clobber state changes that arrived while the call was pending.
  const latestState = useRef(currentState)
  latestState.current = currentState

  const publishState = async (patch: Partial<SessionState>) => {
    const next = { ...latestState.current, ...patch }
    latestState.current = next
    setCurrentState(next)
    try {
      await onStateChange(next)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const compact = async () => {
    setBusy('compact')
    setError(undefined)
    await publishState({ isCompacting: true })
    try {
      const nextStats = await window.codePi.compactThread(threadId)
      setCurrentStats(nextStats)
      await onStatsChange(nextStats)
      await loadDashboard()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      await publishState({ isCompacting: false })
      setBusy(undefined)
    }
  }

  const toggleAutoCompaction = async () => {
    const requested = !autoCompaction
    setBusy('compaction')
    setError(undefined)
    try {
      const enabled = await window.codePi.setAutoCompaction(threadId, requested)
      await publishState({ autoCompactionEnabled: enabled })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const toggleAutoRetry = async () => {
    const requested = !autoRetry
    setBusy('retry')
    setError(undefined)
    try {
      const enabled = await window.codePi.setAutoRetry(threadId, requested)
      await publishState({ autoRetryEnabled: enabled })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="usage-dashboard-popover" role="dialog" aria-label="Context and usage" ref={rootRef}>
      <div className="usage-dashboard-heading">
        <div>
          <strong>Context & usage</strong>
          <span>{currentState.model?.name || currentState.model?.id || 'Current Pi session'}</span>
        </div>
        <div className="usage-heading-actions">
          <button className="icon-button" onClick={() => void loadDashboard()} disabled={loading} aria-label="Refresh usage">
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Close usage dashboard">×</button>
        </div>
      </div>

      {error && <div className="popover-error" role="alert">{error}</div>}

      <section className="context-meter-section">
        <div className="context-meter-heading">
          <span><Gauge size={13} /> Context window</span>
          <strong>{currentStats?.contextUsage?.percent == null ? '—' : `${Math.round(contextPercent)}%`}</strong>
        </div>
        <div className="context-meter" role="progressbar" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(contextPercent)}>
          <span style={{ width: `${contextPercent}%` }} />
        </div>
        <div className="context-meter-detail">
          <span>{contextTokens == null ? 'Waiting for fresh usage' : `${compactNumber(contextTokens)} tokens in context`}</span>
          {contextWindow ? <span>{compactNumber(contextWindow)} limit</span> : null}
        </div>
        <button
          className="compact-context-button"
          disabled={Boolean(busy) || currentState.isStreaming || currentState.isCompacting}
          onClick={() => void compact()}
          title={currentState.isStreaming ? 'Wait for Pi to finish before compacting' : 'Summarize older context now'}
        >
          {busy === 'compact' || currentState.isCompacting
            ? <RefreshCw size={12} className="spin" />
            : <Sparkles size={12} />}
          {busy === 'compact' || currentState.isCompacting ? 'Compacting…' : 'Compact context now'}
        </button>
      </section>

      <section className="usage-summary-grid">
        <div className="usage-summary-card">
          <span><Activity size={12} /> This thread</span>
          <strong>{compactNumber(currentStats?.tokens.total ?? 0)}</strong>
          <small>{formatCost(currentStats?.cost ?? 0)}</small>
        </div>
        <div className="usage-summary-card">
          <span><Zap size={12} /> Today</span>
          <strong>{compactNumber(dashboard?.today.tokens ?? 0)}</strong>
          <small>{formatCost(dashboard?.today.cost ?? 0)} · {dashboard?.today.turns ?? 0} turns</small>
        </div>
        <div className="usage-summary-card wide">
          <span><CalendarDays size={12} /> This month</span>
          <strong>{compactNumber(dashboard?.month.tokens ?? 0)} tokens</strong>
          <small>{formatCost(dashboard?.month.cost ?? 0)} · {dashboard?.month.turns ?? 0} turns</small>
        </div>
      </section>

      <section className="usage-chart-section">
        <div className="usage-chart-heading">
          <span><Coins size={12} /> Daily usage</span>
          <small>{visibleDays.length > 0 ? 'Last 14 days' : 'No recorded usage'}</small>
        </div>
        <div className="usage-day-chart" aria-label="Daily token usage">
          {visibleDays.length === 0 && <div className="popover-empty compact">Usage will appear after completed turns.</div>}
          {visibleDays.map((day) => {
            const height = day.tokens === 0 ? 2 : Math.max(5, Math.round((day.tokens / maxDayTokens) * 100))
            return (
              <div className="usage-day" key={day.date} title={`${day.date}: ${compactNumber(day.tokens)} tokens, ${formatCost(day.cost)}`}>
                <div className="usage-day-track"><span style={{ height: `${height}%` }} /></div>
                <small>{shortDay(day.date)}</small>
              </div>
            )
          })}
        </div>
      </section>

      <section className="usage-controls">
        <button
          className="usage-toggle-row"
          role="switch"
          aria-checked={autoCompaction}
          disabled={Boolean(busy)}
          onClick={() => void toggleAutoCompaction()}
        >
          <span className="usage-toggle-icon"><Sparkles size={13} /></span>
          <span><strong>Auto-compact · Pi-wide</strong><small>Updates Pi’s global context setting</small></span>
          <span className={`native-switch ${autoCompaction ? 'is-on' : ''} ${busy === 'compaction' ? 'is-busy' : ''}`} aria-hidden="true"><span /></span>
        </button>
        <button
          className="usage-toggle-row"
          role="switch"
          aria-checked={autoRetry}
          disabled={Boolean(busy)}
          onClick={() => void toggleAutoRetry()}
        >
          <span className="usage-toggle-icon"><TimerReset size={13} /></span>
          <span><strong>Auto-retry · Pi-wide</strong><small>Updates Pi’s global retry setting</small></span>
          <span className={`native-switch ${autoRetry ? 'is-on' : ''} ${busy === 'retry' ? 'is-busy' : ''}`} aria-hidden="true"><span /></span>
        </button>
      </section>
    </div>
  )
}
