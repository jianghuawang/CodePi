import { useCallback, useState } from 'react'

/** Pane width preference kept in renderer storage; undefined means "use the CSS default". */
export function usePersistedWidth(key: string): [number | undefined, (width: number | undefined) => void] {
  const [width, setWidth] = useState<number | undefined>(() => {
    try {
      const parsed = Number(window.localStorage.getItem(key))
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    } catch {
      return undefined
    }
  })
  const update = useCallback((next: number | undefined) => {
    setWidth(next)
    try {
      if (next === undefined) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, String(Math.round(next)))
    } catch {
      // Width preferences are best-effort; layout still works without storage.
    }
  }, [key])
  return [width, update]
}
