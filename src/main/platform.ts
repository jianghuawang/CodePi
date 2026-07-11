import type { BrowserWindowConstructorOptions } from 'electron'

export const currentPlatform = process.platform as 'darwin' | 'win32' | 'linux'
export const gitNullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'

export function mainWindowPlatformOptions(): BrowserWindowConstructorOptions {
  if (process.platform !== 'darwin') return { titleBarStyle: 'default' }
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active'
  }
}

export function settingsWindowPlatformOptions(): BrowserWindowConstructorOptions {
  if (process.platform !== 'darwin') return { frame: false }
  return {
    frame: false,
    vibrancy: 'under-window',
    visualEffectState: 'active'
  }
}
