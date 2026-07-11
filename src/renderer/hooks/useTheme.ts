import { useEffect, useState } from 'react'
import type { ThemeMode } from '../../shared/contracts'

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme(mode: ThemeMode): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(mode))

  useEffect(() => {
    setTheme(resolveTheme(mode))
    document.documentElement.dataset.theme = resolveTheme(mode)
    document.documentElement.style.colorScheme = resolveTheme(mode)

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMedia = () => {
      if (mode !== 'system') return
      const next = resolveTheme(mode)
      setTheme(next)
      document.documentElement.dataset.theme = next
      document.documentElement.style.colorScheme = next
    }
    media.addEventListener('change', onMedia)
    const unsubscribe = window.codePi?.onThemeChanged((next) => {
      if (mode !== 'system') return
      setTheme(next)
      document.documentElement.dataset.theme = next
      document.documentElement.style.colorScheme = next
    })
    return () => {
      media.removeEventListener('change', onMedia)
      unsubscribe?.()
    }
  }, [mode])

  return theme
}
