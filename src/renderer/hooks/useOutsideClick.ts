import { useEffect, type RefObject } from 'react'

export function useOutsideClick<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onOutside: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return
    const listener = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', listener)
    return () => document.removeEventListener('mousedown', listener)
  }, [enabled, onOutside, ref])
}
