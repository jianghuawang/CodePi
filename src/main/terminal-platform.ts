import { isAbsolute } from 'node:path'

export interface TerminalLaunchOptions {
  shell: string
  args: string[]
  env: Record<string, string>
}

function cleanEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !key.startsWith('ELECTRON_RENDERER_')) env[key] = value
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

export function terminalLaunchOptions(
  cwd: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TerminalLaunchOptions {
  const env = cleanEnvironment(sourceEnvironment)
  env.PWD = cwd
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'CodePi'
  env.TERM_PROGRAM_VERSION = process.env.npm_package_version ?? '0.1.0'
  env.LANG ||= 'en_US.UTF-8'

  if (platform === 'win32') {
    const shell = sourceEnvironment.COMSPEC || 'powershell.exe'
    return {
      shell,
      args: shell.toLowerCase().includes('powershell') ? ['-NoLogo'] : [],
      env,
    }
  }

  const configuredShell = sourceEnvironment.SHELL
  const shell = configuredShell && isAbsolute(configuredShell)
    ? configuredShell
    : platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  return { shell, args: ['-l'], env }
}
