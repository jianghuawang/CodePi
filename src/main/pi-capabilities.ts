import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AppSettings,
  CapabilityKind,
  PiCapability,
  ThreadRecord
} from '../shared/contracts'
import { environmentForPi } from './pi-validation'

type CapabilitySource = PiCapability['source']
type ResourceKey = 'extensions' | 'skills'

interface PiResourceSettings {
  extensions: string[]
  skills: string[]
  packages: PackageSetting[]
}

interface PackageSetting {
  source: string
  extensions?: string[]
  skills?: string[]
  scope: 'user' | 'project'
}

export interface PiPackageRoot {
  source: string
  scope: 'user' | 'project'
  path: string
}

interface ResourceCandidate {
  kind: CapabilityKind
  path: string
  source: CapabilitySource
  packageName?: string
  description?: string
}

interface PackageJson {
  name?: string
  description?: string
  pi?: {
    extensions?: string[]
    skills?: string[]
  }
}

const emptyResourceSettings = (): PiResourceSettings => ({
  extensions: [],
  skills: [],
  packages: []
})

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function resourceKey(kind: CapabilityKind): ResourceKey {
  return kind === 'extension' ? 'extensions' : 'skills'
}

function expandPath(input: string, baseDir: string, home: string): string {
  const value = input.trim()
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  if (value.startsWith('~')) return join(home, value.slice(1))
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** Stable opaque id. Callers should pass a canonical/real path. */
export function piCapabilityId(kind: CapabilityKind, realPath: string): string {
  const digest = createHash('sha256').update(kind).update('\0').update(realPath).digest('hex')
  return `pi-capability:${digest}`
}

function stripTerminalEscapes(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

/** Parse the human-readable but stable indentation emitted by `pi list`. */
export function parsePiListOutput(output: string): PiPackageRoot[] {
  const roots: PiPackageRoot[] = []
  let scope: PiPackageRoot['scope'] | undefined
  let source: string | undefined

  for (const rawLine of stripTerminalEscapes(output).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^User packages:/i.test(trimmed)) {
      scope = 'user'
      source = undefined
      continue
    }
    if (/^Project packages:/i.test(trimmed)) {
      scope = 'project'
      source = undefined
      continue
    }
    if (!scope || /^(No packages|None\.?$)/i.test(trimmed)) continue

    const indentation = line.length - line.trimStart().length
    if (indentation <= 2) {
      source = trimmed
      continue
    }
    if (source && indentation >= 4 && isAbsolute(trimmed)) {
      roots.push({ source, scope, path: resolve(trimmed) })
      source = undefined
    }
  }

  return roots
}

async function runPiList(thread: ThreadRecord, settings: AppSettings): Promise<PiPackageRoot[]> {
  if (!settings.piPath || settings.piPath.includes('\0')) return []
  const output = await new Promise<string>((resolveOutput) => {
    execFile(
      settings.piPath,
      ['list'],
      {
        cwd: thread.cwd,
        env: environmentForPi(settings.env),
        encoding: 'utf8',
        timeout: 8_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      },
      (_error, stdout) => resolveOutput(String(stdout ?? ''))
    )
  })
  return parsePiListOutput(output)
}

async function readPiSettings(
  path: string,
  scope: PackageSetting['scope']
): Promise<PiResourceSettings> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return emptyResourceSettings()
  }
  if (!isRecord(value)) return emptyResourceSettings()

  const packages: PackageSetting[] = []
  if (Array.isArray(value.packages)) {
    for (const item of value.packages) {
      if (typeof item === 'string' && item.trim()) {
        packages.push({ source: item.trim(), scope })
      } else if (isRecord(item) && typeof item.source === 'string' && item.source.trim()) {
        packages.push({
          source: item.source.trim(),
          scope,
          ...(Array.isArray(item.extensions) ? { extensions: asStringArray(item.extensions) } : {}),
          ...(Array.isArray(item.skills) ? { skills: asStringArray(item.skills) } : {})
        })
      }
    }
  }

  return {
    extensions: asStringArray(value.extensions),
    skills: asStringArray(value.skills),
    packages
  }
}

function hasPattern(value: string): boolean {
  return /^[!+-]/.test(value) || value.includes('*') || value.includes('?')
}

function globRegex(pattern: string): RegExp {
  const normalized = toPosix(pattern).replace(/^\.\//, '')
  let source = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1
        if (normalized[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

function patternTargets(path: string, baseDir: string, kind: CapabilityKind): string[] {
  const absolute = toPosix(resolve(path))
  const relativePath = toPosix(relative(baseDir, path))
  const targets = [relativePath, basename(path), absolute]
  if (kind === 'skill' && basename(path) === 'SKILL.md') {
    const parent = dirname(path)
    targets.push(toPosix(relative(baseDir, parent)), basename(parent), toPosix(resolve(parent)))
  }
  return targets
}

function matchesPattern(
  path: string,
  pattern: string,
  baseDir: string,
  kind: CapabilityKind
): boolean {
  const matcher = globRegex(pattern)
  return patternTargets(path, baseDir, kind).some((target) => matcher.test(target.replace(/^\.\//, '')))
}

function matchesExact(
  path: string,
  pattern: string,
  baseDir: string,
  kind: CapabilityKind
): boolean {
  const normalized = toPosix(pattern).replace(/^\.\//, '')
  return patternTargets(path, baseDir, kind)
    .map((target) => target.replace(/^\.\//, ''))
    .some((target) => target === normalized)
}

function applyPatterns(
  paths: string[],
  patterns: string[],
  baseDir: string,
  kind: CapabilityKind
): string[] {
  const includes = patterns.filter((pattern) => !/^[!+-]/.test(pattern))
  const excludes = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1))
  const forceIncludes = patterns.filter((pattern) => pattern.startsWith('+')).map((pattern) => pattern.slice(1))
  const forceExcludes = patterns.filter((pattern) => pattern.startsWith('-')).map((pattern) => pattern.slice(1))

  const selected = new Set(
    includes.length === 0
      ? paths
      : paths.filter((path) => includes.some((pattern) => matchesPattern(path, pattern, baseDir, kind)))
  )
  for (const path of paths) {
    if (excludes.some((pattern) => matchesPattern(path, pattern, baseDir, kind))) selected.delete(path)
    if (forceIncludes.some((pattern) => matchesExact(path, pattern, baseDir, kind))) selected.add(path)
    if (forceExcludes.some((pattern) => matchesExact(path, pattern, baseDir, kind))) selected.delete(path)
  }
  return [...selected]
}

function applyAutoOverrides(
  paths: string[],
  entries: string[],
  baseDir: string,
  kind: CapabilityKind
): string[] {
  return applyPatterns(paths, entries.filter((entry) => /^[!+-]/.test(entry)), baseDir, kind)
}

async function readDirectory(path: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function pathType(path: string): Promise<'file' | 'directory' | undefined> {
  try {
    const details = await stat(path)
    if (details.isFile()) return 'file'
    if (details.isDirectory()) return 'directory'
  } catch {
    // Broken and unreadable resources are intentionally ignored.
  }
  return undefined
}

async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (!isRecord(value)) return undefined
    const manifest = isRecord(value.pi) ? value.pi : undefined
    return {
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(manifest
        ? {
            pi: {
              ...(Array.isArray(manifest.extensions)
                ? { extensions: asStringArray(manifest.extensions) }
                : {}),
              ...(Array.isArray(manifest.skills) ? { skills: asStringArray(manifest.skills) } : {})
            }
          }
        : {})
    }
  } catch {
    return undefined
  }
}

async function resolveExtensionDirectory(path: string): Promise<string[] | undefined> {
  const manifest = await readPackageJson(path)
  if (manifest?.pi?.extensions !== undefined) {
    return collectManifestResources(path, 'extension', manifest.pi.extensions)
  }
  for (const indexName of ['index.ts', 'index.js']) {
    const candidate = join(path, indexName)
    if (await exists(candidate)) return [candidate]
  }
  return undefined
}

async function collectAutoExtensions(path: string): Promise<string[]> {
  if ((await pathType(path)) !== 'directory') return []
  const ownEntry = await resolveExtensionDirectory(path)
  if (ownEntry) return ownEntry

  const extensions: string[] = []
  for (const entry of await readDirectory(path)) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const candidate = join(path, entry.name)
    const type = entry.isSymbolicLink() ? await pathType(candidate) : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : undefined
    if (type === 'file' && ['.ts', '.js'].includes(extname(entry.name))) {
      extensions.push(candidate)
    } else if (type === 'directory') {
      const nested = await resolveExtensionDirectory(candidate)
      if (nested) extensions.push(...nested)
    }
  }
  return extensions
}

async function collectSkills(
  path: string,
  allowRootMarkdown: boolean,
  root = path,
  visited = new Set<string>()
): Promise<string[]> {
  if ((await pathType(path)) !== 'directory') return []
  const canonical = await canonicalPath(path)
  if (visited.has(canonical)) return []
  visited.add(canonical)

  const entries = await readDirectory(path)
  const skillFile = entries.find((entry) => entry.name === 'SKILL.md')
  if (skillFile) {
    const skillPath = join(path, 'SKILL.md')
    if (skillFile.isFile() || (skillFile.isSymbolicLink() && (await pathType(skillPath)) === 'file')) {
      return [skillPath]
    }
  }

  const skills: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const candidate = join(path, entry.name)
    const type = entry.isSymbolicLink() ? await pathType(candidate) : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : undefined
    if (type === 'file' && allowRootMarkdown && path === root && extname(entry.name) === '.md') {
      skills.push(candidate)
    } else if (type === 'directory') {
      skills.push(...(await collectSkills(candidate, allowRootMarkdown, root, visited)))
    }
  }
  return skills
}

async function collectResourcePath(path: string, kind: CapabilityKind): Promise<string[]> {
  const type = await pathType(path)
  if (type === 'file') return [path]
  if (type !== 'directory') return []
  return kind === 'extension' ? collectAutoExtensions(path) : collectSkills(path, true)
}

async function walkManifestCandidates(
  root: string,
  kind: CapabilityKind,
  path = root,
  visited = new Set<string>()
): Promise<string[]> {
  if ((await pathType(path)) !== 'directory') return []
  const canonical = await canonicalPath(path)
  if (visited.has(canonical)) return []
  visited.add(canonical)

  const files: string[] = []
  for (const entry of await readDirectory(path)) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const candidate = join(path, entry.name)
    const type = entry.isSymbolicLink() ? await pathType(candidate) : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : undefined
    if (type === 'directory') {
      files.push(...(await walkManifestCandidates(root, kind, candidate, visited)))
    } else if (
      type === 'file' &&
      (kind === 'extension' ? ['.ts', '.js'].includes(extname(entry.name)) : extname(entry.name) === '.md')
    ) {
      files.push(candidate)
    }
  }
  return files
}

async function collectManifestResources(
  root: string,
  kind: CapabilityKind,
  entries: string[]
): Promise<string[]> {
  const sourceEntries = entries.filter((entry) => !/^[!+-]/.test(entry))
  const resources: string[] = []
  let manifestCandidates: string[] | undefined

  for (const entry of sourceEntries) {
    if (entry.includes('*') || entry.includes('?')) {
      manifestCandidates ??= await walkManifestCandidates(root, kind)
      resources.push(
        ...manifestCandidates.filter((path) => matchesPattern(path, entry, root, kind))
      )
    } else {
      resources.push(...(await collectResourcePath(resolve(root, entry), kind)))
    }
  }

  const unique = [...new Set(resources.map((path) => resolve(path)))]
  return applyPatterns(
    unique,
    entries.filter((entry) => /^[!+-]/.test(entry)),
    root,
    kind
  )
}

async function collectSettingsResources(
  entries: string[],
  baseDir: string,
  home: string,
  kind: CapabilityKind,
  source: CapabilitySource
): Promise<ResourceCandidate[]> {
  const paths: string[] = []
  for (const entry of entries.filter((item) => !hasPattern(item))) {
    paths.push(...(await collectResourcePath(expandPath(entry, baseDir, home), kind)))
  }
  return applyPatterns(paths, entries.filter(hasPattern), baseDir, kind).map((path) => ({
    kind,
    path,
    source
  }))
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd)
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function projectAgentSkillDirs(cwd: string, userAgentSkills: string): Promise<string[]> {
  const directories: string[] = []
  const gitRoot = await findGitRoot(cwd)
  let current = resolve(cwd)
  while (true) {
    const candidate = join(current, '.agents', 'skills')
    if (resolve(candidate) !== resolve(userAgentSkills)) directories.push(candidate)
    if ((gitRoot && current === gitRoot) || (!gitRoot && dirname(current) === current)) break
    current = dirname(current)
  }
  return directories
}

async function collectAutoResources(
  thread: ThreadRecord,
  agentDir: string,
  home: string,
  globalSettings: PiResourceSettings,
  projectSettings: PiResourceSettings
): Promise<{ project: ResourceCandidate[]; user: ResourceCandidate[] }> {
  const projectBase = join(thread.cwd, '.pi')
  const userAgentSkills = join(home, '.agents', 'skills')
  const ancestorSkillDirs = await projectAgentSkillDirs(thread.cwd, userAgentSkills)

  const projectExtensions = applyAutoOverrides(
    await collectAutoExtensions(join(projectBase, 'extensions')),
    projectSettings.extensions,
    projectBase,
    'extension'
  )
  const projectSkills = applyAutoOverrides(
    [
      ...(await collectSkills(join(projectBase, 'skills'), true)),
      ...(await Promise.all(ancestorSkillDirs.map((path) => collectSkills(path, false)))).flat()
    ],
    projectSettings.skills,
    projectBase,
    'skill'
  )
  const userExtensions = applyAutoOverrides(
    await collectAutoExtensions(join(agentDir, 'extensions')),
    globalSettings.extensions,
    agentDir,
    'extension'
  )
  const userSkills = applyAutoOverrides(
    [
      ...(await collectSkills(join(agentDir, 'skills'), true)),
      ...(await collectSkills(userAgentSkills, false))
    ],
    globalSettings.skills,
    agentDir,
    'skill'
  )

  return {
    project: [
      ...projectExtensions.map((path) => ({ kind: 'extension' as const, path, source: 'project' as const })),
      ...projectSkills.map((path) => ({ kind: 'skill' as const, path, source: 'project' as const }))
    ],
    user: [
      ...userExtensions.map((path) => ({ kind: 'extension' as const, path, source: 'user' as const })),
      ...userSkills.map((path) => ({ kind: 'skill' as const, path, source: 'user' as const }))
    ]
  }
}

function npmPackageName(source: string): string | undefined {
  const raw = source.startsWith('npm:') ? source.slice(4) : source
  if (!raw || raw.includes('/') && !raw.startsWith('@') && /^(?:\.|~|\/)/.test(raw)) return undefined
  if (raw.startsWith('@')) {
    const slash = raw.indexOf('/')
    if (slash < 0) return undefined
    const version = raw.indexOf('@', slash)
    return version < 0 ? raw : raw.slice(0, version)
  }
  const version = raw.lastIndexOf('@')
  return version > 0 ? raw.slice(0, version) : raw
}

function packageIdentity(setting: PackageSetting, baseDir: string, home: string): string {
  const npmName = npmPackageName(setting.source)
  if (setting.source.startsWith('npm:') || (npmName && !/^(?:git:|https?:|ssh:|git@)/.test(setting.source))) {
    return `npm:${npmName ?? setting.source}`
  }
  if (/^(?:git:|https?:|ssh:|git@)/.test(setting.source)) {
    return `git:${setting.source.replace(/@[^/@]+$/, '')}`
  }
  return `local:${expandPath(setting.source, baseDir, home)}`
}

function dedupePackageSettings(
  project: PackageSetting[],
  user: PackageSetting[],
  projectBase: string,
  agentDir: string,
  home: string
): PackageSetting[] {
  const result: PackageSetting[] = []
  const seen = new Set<string>()
  for (const setting of [...project, ...user]) {
    const base = setting.scope === 'project' ? projectBase : agentDir
    const identity = packageIdentity(setting, base, home)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(setting)
  }
  return result
}

function findListedPackageRoot(
  setting: PackageSetting,
  roots: PiPackageRoot[],
  baseDir: string,
  home: string
): string | undefined {
  const exact = roots.find((root) => root.scope === setting.scope && root.source === setting.source)
  if (exact) return exact.path
  const identity = packageIdentity(setting, baseDir, home)
  const equivalent = roots.find((root) => root.scope === setting.scope &&
    packageIdentity({ source: root.source, scope: root.scope }, baseDir, home) === identity
  )
  if (equivalent) return equivalent.path
  if (/^(?:\.|~|\/)/.test(setting.source)) return expandPath(setting.source, baseDir, home)
  const npmName = npmPackageName(setting.source)
  if (setting.scope === 'project' && npmName) return join(baseDir, 'npm', 'node_modules', npmName)
  return undefined
}

async function collectPackageResources(
  root: string,
  setting: PackageSetting
): Promise<ResourceCandidate[]> {
  const type = await pathType(root)
  if (!type) return []
  const packageJson = type === 'directory' ? await readPackageJson(root) : undefined
  const packageName = packageJson?.name ?? setting.source
  const candidates: ResourceCandidate[] = []

  for (const kind of ['extension', 'skill'] as const) {
    const key = resourceKey(kind)
    const configuredFilter = setting[key]
    if (configuredFilter?.length === 0) continue

    let paths: string[]
    if (type === 'file') {
      paths = kind === 'extension' ? [root] : []
    } else if (packageJson?.pi && packageJson.pi[key] !== undefined) {
      paths = await collectManifestResources(root, kind, packageJson.pi[key] ?? [])
    } else {
      paths = await collectResourcePath(join(root, key), kind)
    }
    if (configuredFilter) paths = applyPatterns(paths, configuredFilter, root, kind)

    candidates.push(
      ...paths.map((path) => ({
        kind,
        path,
        source: 'package' as const,
        packageName,
        ...(kind === 'extension' && packageJson?.description
          ? { description: packageJson.description }
          : {})
      }))
    )
  }
  return candidates
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) return trimmed.slice(1, -1)
  return trimmed
}

async function skillMetadata(path: string): Promise<{ name?: string; description?: string }> {
  let header: string
  try {
    const content = (await readFile(path, 'utf8')).slice(0, 64 * 1024)
    if (!content.startsWith('---')) return {}
    const end = content.indexOf('\n---', 3)
    if (end < 0) return {}
    header = content.slice(3, end)
  } catch {
    return {}
  }
  const name = header.match(/^name:\s*(.+)$/m)?.[1]
  const description = header.match(/^description:\s*(.+)$/m)?.[1]
  return {
    ...(name ? { name: unquote(name) } : {}),
    ...(description && !['>', '|'].includes(description.trim())
      ? { description: unquote(description) }
      : {})
  }
}

async function toCapability(
  candidate: ResourceCandidate,
  disabled: Set<string>
): Promise<PiCapability> {
  const path = await canonicalPath(candidate.path)
  const id = piCapabilityId(candidate.kind, path)
  const metadata = candidate.kind === 'skill' ? await skillMetadata(path) : {}
  const fallbackName = basename(path) === 'SKILL.md'
    ? basename(dirname(path))
    : basename(path, extname(path))
  const name = metadata.name?.trim() || fallbackName
  const description = metadata.description ?? candidate.description
  return {
    id,
    kind: candidate.kind,
    name,
    ...(description ? { description } : {}),
    path,
    source: candidate.source,
    ...(candidate.packageName ? { packageName: candidate.packageName } : {}),
    enabled: !disabled.has(id),
    ...(candidate.kind === 'skill' ? { commandName: `skill:${name}` } : {})
  }
}

/**
 * Resolve the capabilities Pi would discover for this thread, then layer the
 * thread-local CodePi disable list over that native-effective set.
 */
async function resolvePiCapabilities(
  thread: ThreadRecord,
  settings: AppSettings
): Promise<PiCapability[]> {
  const env = environmentForPi(settings.env)
  const home = env.HOME || homedir()
  const agentDir = expandPath(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), thread.cwd, home)
  const projectBase = join(thread.cwd, '.pi')

  const [globalSettings, projectSettings, listedRoots] = await Promise.all([
    readPiSettings(join(agentDir, 'settings.json'), 'user'),
    readPiSettings(join(projectBase, 'settings.json'), 'project'),
    runPiList(thread, settings)
  ])

  const [projectSettingsExtensions, projectSettingsSkills, userSettingsExtensions, userSettingsSkills, auto] =
    await Promise.all([
      collectSettingsResources(projectSettings.extensions, projectBase, home, 'extension', 'settings'),
      collectSettingsResources(projectSettings.skills, projectBase, home, 'skill', 'settings'),
      collectSettingsResources(globalSettings.extensions, agentDir, home, 'extension', 'settings'),
      collectSettingsResources(globalSettings.skills, agentDir, home, 'skill', 'settings'),
      collectAutoResources(thread, agentDir, home, globalSettings, projectSettings)
    ])

  const packageSettings = dedupePackageSettings(
    projectSettings.packages,
    globalSettings.packages,
    projectBase,
    agentDir,
    home
  )
  const packageCandidates = (
    await Promise.all(
      packageSettings.map(async (setting) => {
        const base = setting.scope === 'project' ? projectBase : agentDir
        const root = findListedPackageRoot(setting, listedRoots, base, home)
        return root ? collectPackageResources(root, setting) : []
      })
    )
  ).flat()

  // Pi's documented collision precedence: project settings, project auto,
  // user settings, user auto, then package resources.
  const ordered = [
    ...projectSettingsExtensions,
    ...projectSettingsSkills,
    ...auto.project,
    ...userSettingsExtensions,
    ...userSettingsSkills,
    ...auto.user,
    ...packageCandidates
  ]
  const unique = new Map<string, ResourceCandidate>()
  for (const candidate of ordered) {
    const path = await canonicalPath(candidate.path)
    const key = `${candidate.kind}\0${path}`
    if (!unique.has(key)) unique.set(key, { ...candidate, path })
  }

  const disabled = new Set(thread.disabledCapabilityIds)
  const capabilities = await Promise.all(
    [...unique.values()].map((candidate) => toCapability(candidate, disabled))
  )
  return capabilities
}

export async function listPiCapabilities(
  thread: ThreadRecord,
  settings: AppSettings
): Promise<PiCapability[]> {
  const sourceOrder: Record<CapabilitySource, number> = {
    project: 0,
    settings: 1,
    user: 2,
    package: 3
  }
  return (await resolvePiCapabilities(thread, settings)).sort((left, right) =>
    left.kind.localeCompare(right.kind) ||
    sourceOrder[left.source] - sourceOrder[right.source] ||
    left.name.localeCompare(right.name) ||
    left.path.localeCompare(right.path)
  )
}

/**
 * Preserve stale disable entries while disabling every capability discovered
 * for the safe-restart path. Keeping stale ids prevents a temporarily missing
 * resource from being re-enabled unexpectedly when it returns.
 */
export function disabledCapabilityIdsForSafeRestart(
  existingIds: readonly string[],
  capabilities: readonly Pick<PiCapability, 'id'>[]
): string[] {
  return [...new Set([...existingIds, ...capabilities.map((capability) => capability.id)])]
}

/** Build deterministic Pi CLI args that opt out of discovery and opt in explicitly. */
export async function buildCapabilitySpawnArgs(
  thread: ThreadRecord,
  settings: AppSettings
): Promise<string[]> {
  const capabilities = (await resolvePiCapabilities(thread, settings))
    .filter((capability) => capability.enabled)
  const args = ['--no-extensions', '--no-skills']
  for (const capability of capabilities) {
    args.push(capability.kind === 'extension' ? '--extension' : '--skill', capability.path)
  }
  return args
}

/** Backward-compatible descriptive alias for callers outside the manager. */
export const buildPiCapabilitySpawnArgs = buildCapabilitySpawnArgs
