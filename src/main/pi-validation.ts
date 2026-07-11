import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

export interface PiValidationResult {
  available: boolean
  path: string
  version?: string
  error?: string
}

export function environmentForPi(env: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env }
  if (process.platform === 'darwin' && env.PATH === undefined) {
    const entries = ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')]
    merged.PATH = [...new Set(entries.filter(Boolean))].join(':')
  }
  return merged
}

export async function validatePiBinary(
  piPath: string,
  env: Record<string, string> = {}
): Promise<PiValidationResult> {
  if (!piPath || piPath.includes('\0')) return { available: false, path: piPath, error: 'Choose a Pi executable.' }
  if ((piPath.includes('/') || piPath.includes('\\')) && !isAbsolute(piPath)) {
    return {
      available: false,
      path: piPath,
      error: 'Use an absolute path for a Pi executable outside PATH.'
    }
  }
  return new Promise((resolve) => {
    execFile(
      piPath,
      ['--version'],
      {
        env: environmentForPi(env),
        encoding: 'utf8',
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim()
          resolve({
            available: false,
            path: piPath,
            error: detail || 'Pi was not found. Install @earendil-works/pi-coding-agent or choose its executable.'
          })
          return
        }
        const version = String(stdout).trim().split(/\r?\n/, 1)[0]
        resolve({ available: true, path: piPath, ...(version ? { version } : {}) })
      }
    )
  })
}
