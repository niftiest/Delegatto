import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText, uniqueStampedPath } from '../manage/safe-file'
import { SAVED_EFFORTS } from '../../shared/models'
import {
  CLAUDE_SETTING_KEYS, LIST_KEYS, PERMISSION_MODES, USER_ONLY_KEYS,
  type ClaudeSettingKey, type ClaudeSettingsPatch, type ClaudeSettingsTarget, type ClaudeSettingsView,
  type EffectiveValue, type SettingSource
} from '../../shared/claude-settings-types'

/** Reads and edits Claude Code's own settings files (electron-free).
 *
 *  Only the keys in CLAUDE_SETTING_KEYS are ever written; every other key in a
 *  file is kept exactly as it was. A file that isn't valid JSON is never
 *  written. Writes are atomic, and the user file is copied to
 *  ~/.claude/backups/delegatto/ first. */

export type SettingsLocations = {
  /** ~/.claude */
  claudeDir: string
  /** Organisation-managed settings files (read-only, highest precedence). */
  managedFiles: string[]
}

export function defaultManagedFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== 'win32') return ['/etc/claude-code/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.json']
  const pf = env.ProgramFiles ?? 'C:\\Program Files'
  const pd = env.ProgramData ?? 'C:\\ProgramData'
  return [join(pf, 'ClaudeCode', 'managed-settings.json'), join(pd, 'ClaudeCode', 'managed-settings.json')]
}

export function settingsPath(loc: SettingsLocations, target: ClaudeSettingsTarget): string {
  if (target.scope === 'user') return join(loc.claudeDir, 'settings.json')
  return join(target.cwd, '.claude', target.scope === 'project' ? 'settings.json' : 'settings.local.json')
}

type Read = { exists: boolean; data: Record<string, unknown>; error: string | null }

export function readJsonFile(path: string): Read {
  if (!existsSync(path)) return { exists: false, data: {}, error: null }
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    if (text.trim() === '') return { exists: true, data: {}, error: null }
    const v = JSON.parse(text) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { exists: true, data: {}, error: 'The file is not a JSON object.' }
    return { exists: true, data: v as Record<string, unknown>, error: null }
  } catch (e) {
    return { exists: true, data: {}, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export function getPath(obj: Record<string, unknown>, key: string): unknown {
  let cur: unknown = obj
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.')
  let cur = obj
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[part] = {}
    cur = cur[part] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}

/** Removes a key; a parent object it leaves empty is removed too. */
function deletePath(obj: Record<string, unknown>, key: string): void {
  const parts = key.split('.')
  const chain: Array<Record<string, unknown>> = [obj]
  for (const part of parts.slice(0, -1)) {
    const next = chain[chain.length - 1]![part]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return
    chain.push(next as Record<string, unknown>)
  }
  delete chain[chain.length - 1]![parts[parts.length - 1]!]
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]!).length > 0) break
    delete chain[i - 1]![parts[i - 1]!]
  }
}

const BOOL_KEYS: ReadonlySet<ClaudeSettingKey> = new Set<ClaudeSettingKey>([
  'alwaysThinkingEnabled', 'autoMemoryEnabled', 'autoCompactEnabled', 'remoteControlAtStartup',
  'enableAllProjectMcpServers', 'includeCoAuthoredBy', 'skipDangerousModePermissionPrompt'
])

/** Validates a value for a key. Returns the cleaned value, or an error. */
export function validateSetting(key: ClaudeSettingKey, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `${key}: ${why}` })
  if (BOOL_KEYS.has(key)) return typeof value === 'boolean' ? { ok: true, value } : bad('must be true or false')
  if (LIST_KEYS.has(key)) {
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) return bad('must be a list of text entries')
    const clean = [...new Set((value as string[]).map(v => v.trim()).filter(v => v.length > 0))]
    if (clean.some(v => v.length > 500)) return bad('an entry is too long')
    return { ok: true, value: clean }
  }
  switch (key) {
    case 'effortLevel':
      return typeof value === 'string' && (SAVED_EFFORTS as readonly string[]).includes(value) ? { ok: true, value } : bad(`must be one of ${SAVED_EFFORTS.join(', ')}`)
    case 'permissions.defaultMode':
      return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value) ? { ok: true, value } : bad(`must be one of ${PERMISSION_MODES.join(', ')}`)
    case 'cleanupPeriodDays':
      // 0 fails Claude Code's own validation; "keep" is a large number.
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 36500 ? { ok: true, value } : bad('must be a whole number of days, at least 1')
    case 'attribution.commit':
    case 'attribution.pr':
      return typeof value === 'string' && value.length <= 2000 ? { ok: true, value } : bad('must be text')
    case 'model':
    case 'outputStyle':
    case 'language': {
      if (typeof value !== 'string') return bad('must be text')
      const v = value.trim()
      return v.length > 0 && v.length <= 200 ? { ok: true, value: v } : bad('must not be empty')
    }
    default:
      return bad('is not editable here')
  }
}

/** Keeps the user file's previous version (last 10) before Delegatto edits it. */
export function backupUserFile(loc: SettingsLocations, path: string): void {
  if (!existsSync(path)) return
  const dir = join(loc.claudeDir, 'backups', 'delegatto')
  mkdirSync(dir, { recursive: true })
  copyFileSync(path, uniqueStampedPath(dir, '-settings.json'))
  const old = readdirSync(dir).filter(f => f.endsWith('-settings.json')).sort()
  for (const f of old.slice(0, Math.max(0, old.length - 10))) {
    try { unlinkSync(join(dir, f)) } catch { /* best effort */ }
  }
}

/** Keeps a new settings.local.json out of git, the way Claude Code does:
 *  listed in the repo's own .git/info/exclude (never in a committed file). */
export function excludeLocalSettingsFromGit(cwd: string): void {
  try {
    const git = join(cwd, '.git')
    if (!existsSync(git) || !statSync(git).isDirectory()) return
    const info = join(git, 'info')
    mkdirSync(info, { recursive: true })
    const exclude = join(info, 'exclude')
    const line = '.claude/settings.local.json'
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    if (text.split(/\r?\n/).some(l => l.trim() === line || l.trim() === `/${line}`)) return
    appendFileSync(exclude, `${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}${line}\n`)
  } catch { /* best effort: the setting is still saved */ }
}

/** Applies a patch to one settings file. null removes a key. Throws (and
 *  writes nothing) when the file is unreadable or a value is invalid. */
export function writeSettings(loc: SettingsLocations, target: ClaudeSettingsTarget, patch: ClaudeSettingsPatch): void {
  const entries = Object.entries(patch) as Array<[ClaudeSettingKey, unknown]>
  const known = new Set<string>(CLAUDE_SETTING_KEYS)
  const cleaned: Array<[ClaudeSettingKey, unknown]> = []
  for (const [key, value] of entries) {
    if (!known.has(key)) throw new Error(`${key} is not a setting Delegatto edits.`)
    // Removing one from a project file is allowed (that's how a stray override is cleared).
    if (value === null || value === undefined) { cleaned.push([key, null]); continue }
    if (target.scope !== 'user' && USER_ONLY_KEYS.has(key)) throw new Error(`${key} can only be set for all projects.`)
    const v = validateSetting(key, value)
    if (!v.ok) throw new Error(v.error)
    cleaned.push([key, v.value])
  }
  if (cleaned.length === 0) return

  const path = settingsPath(loc, target)
  const current = readJsonFile(path)
  if (current.error !== null) throw new Error(`${path} could not be read (${current.error}). Fix or remove it first.`)
  const data = current.data
  for (const [key, value] of cleaned) {
    if (value === null) deletePath(data, key)
    else setPath(data, key, value)
  }
  if (target.scope === 'user') backupUserFile(loc, path)
  mkdirSync(join(path, '..'), { recursive: true })
  atomicWriteText(path, JSON.stringify(data, null, 2) + '\n')
  if (target.scope === 'local' && !current.exists) excludeLocalSettingsFromGit(target.cwd)
}

/** The whole settings file as written, for the settings that have no control of their own. */
export function readSettingsText(loc: SettingsLocations, target: ClaudeSettingsTarget): { path: string; text: string } {
  const path = settingsPath(loc, target)
  try {
    return { path, text: readFileSync(path, 'utf8') }
  } catch {
    return { path, text: '{\n}\n' }
  }
}

/** Replaces the whole file, once it's known to be a JSON object. */
export function writeSettingsText(loc: SettingsLocations, target: ClaudeSettingsTarget, text: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`That isn't valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Settings have to be a JSON object, between { and }.')
  const path = settingsPath(loc, target)
  const existed = existsSync(path)
  if (target.scope === 'user') backupUserFile(loc, path)
  mkdirSync(join(path, '..'), { recursive: true })
  atomicWriteText(path, text.endsWith('\n') ? text : `${text}\n`)
  if (target.scope === 'local' && !existed) excludeLocalSettingsFromGit(target.cwd)
}

/** Adds a permission rule ("allow always") to a project's local settings,
 *  where Claude Code itself saves "don't ask again" rules. */
export function addAllowRule(loc: SettingsLocations, cwd: string, rule: string): void {
  const target: ClaudeSettingsTarget = { scope: 'local', cwd }
  const current = readJsonFile(settingsPath(loc, target))
  if (current.error !== null) throw new Error(current.error)
  const list = getPath(current.data, 'permissions.allow')
  const existing = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  if (existing.includes(rule)) return
  writeSettings(loc, target, { 'permissions.allow': [...existing, rule] })
}

function projectMcpServers(cwd: string): string[] {
  const r = readJsonFile(join(cwd, '.mcp.json'))
  const servers = r.data.mcpServers
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers) ? Object.keys(servers) : []
}

/** The file being edited, plus what is in effect for that target. */
export function readSettingsView(loc: SettingsLocations, target: ClaudeSettingsTarget): ClaudeSettingsView {
  const path = settingsPath(loc, target)
  const own = readJsonFile(path)

  // Lowest precedence first; managed last (wins).
  const layers: Array<{ source: SettingSource; data: Record<string, unknown> }> = []
  layers.push({ source: 'user', data: readJsonFile(settingsPath(loc, { scope: 'user' })).data })
  if (target.scope !== 'user') {
    layers.push({ source: 'project', data: readJsonFile(settingsPath(loc, { scope: 'project', cwd: target.cwd })).data })
    layers.push({ source: 'local', data: readJsonFile(settingsPath(loc, { scope: 'local', cwd: target.cwd })).data })
  }
  for (const f of loc.managedFiles) {
    const m = readJsonFile(f)
    if (m.exists && m.error === null) layers.push({ source: 'managed', data: m.data })
  }

  const ownValues: ClaudeSettingsView['own'] = {}
  const effective: ClaudeSettingsView['effective'] = {}
  const lists: ClaudeSettingsView['lists'] = {}
  for (const key of CLAUDE_SETTING_KEYS) {
    const mine = getPath(own.data, key)
    if (mine !== undefined) ownValues[key] = mine
    if (LIST_KEYS.has(key)) {
      const entries: Array<{ value: string; source: SettingSource }> = []
      for (const layer of layers) {
        const v = getPath(layer.data, key)
        if (!Array.isArray(v)) continue
        for (const item of v) if (typeof item === 'string' && !entries.some(e => e.value === item)) entries.push({ value: item, source: layer.source })
      }
      lists[key] = entries
      continue
    }
    let eff: EffectiveValue = { value: undefined, source: 'default' }
    for (const layer of layers) {
      const v = getPath(layer.data, key)
      if (v !== undefined) eff = { value: v, source: layer.source }
    }
    effective[key] = eff
  }

  return {
    target, path, exists: own.exists, error: own.error,
    own: ownValues, effective, lists,
    projectMcpServers: target.scope === 'user' ? [] : projectMcpServers(target.cwd)
  }
}
