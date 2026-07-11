import { useEffect, useMemo, useState } from 'react'

const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' })

function formatRelative(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1_000)
  const absolute = Math.abs(seconds)
  if (absolute < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 7) return formatter.format(days, 'day')
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)
}

export function useRelativeTime(timestamp: number): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return useMemo(() => formatRelative(timestamp, now), [now, timestamp])
}
