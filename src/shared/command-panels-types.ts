/** What Delegatto's screens for /hooks, /diff and /plugin show: Claude Code's own answers,
 *  tidied. /tasks uses the chat's background tasks and /export the transcript, so they
 *  need nothing here. */

export type HookScope = 'user' | 'project' | 'local'

export type HookEntry = {
  event: string
  /** Null for events without a matcher, and for a hook that matches everything. */
  matcher: string | null
  /** userSettings, projectSettings, localSettings, policySettings, pluginHook, … */
  source: string
  sourceLabel: string
  pluginName: string | null
  type: string
  /** What runs: a command, a prompt, a URL. */
  text: string
  /** Which file holds it, when it's one Delegatto can change. */
  scope: HookScope | null
  /** Exactly as the file has it, to find it again when removing. */
  config: Record<string, unknown> | null
}

export type HookEvent = { name: string; summary: string; supportsMatcher: boolean }

export type HooksListing = {
  hooks: HookEntry[]
  catalog: HookEvent[]
  /** Why hooks may not run, in words, or null when they do. */
  policyNote: string | null
}

export type DiffFile = {
  path: string
  added: number
  removed: number
  binary: boolean
  untracked: boolean
  /** modified, added, deleted, renamed, … */
  status: string
  hunks: Array<{ oldStart: number; newStart: number; lines: string[] }>
}

export type WorkspaceDiff = {
  files: DiffFile[]
  added: number
  removed: number
  /** What it's compared with: "main" for a branch, null for uncommitted changes. */
  baseBranch: string | null
  /** Files too big to show. */
  skipped: string[]
}

export type InstalledPlugin = {
  /** name@marketplace */
  id: string
  name: string
  marketplace: string
  version: string
  scope: string
  enabled: boolean
  /** For a project-scope plugin: the project it belongs to. */
  projectPath: string | null
  mcpServers: string[]
}

export type AvailablePlugin = {
  id: string
  name: string
  marketplace: string
  description: string
  installs: number | null
}

export type Marketplace = { name: string; source: string; where: string }

export type PluginsState = { installed: InstalledPlugin[]; available: AvailablePlugin[]; marketplaces: Marketplace[] }

/** What `claude plugin …` said: its output, or why it failed. */
export type PluginActionResult = { ok: true; output: string; reloaded: number } | { ok: false; error: string }

export type ExportChatResult = { status: 'saved'; path: string } | { status: 'text'; text: string } | { status: 'cancelled' } | { status: 'failed'; message: string }

export type PanelResult<T> ={ ok: true; value: T } | { ok: false; error: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const str = (v: unknown, fallback = ''): string => typeof v === 'string' ? v : fallback
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0

const SCOPES: Record<string, HookScope> = { userSettings: 'user', projectSettings: 'project', localSettings: 'local' }

/** Claude Code's `get_hooks_listing` answer. */
export function parseHooksListing(raw: unknown): HooksListing {
  const r = isObj(raw) ? raw : {}
  const hooks: HookEntry[] = Array.isArray(r.hooks) ? r.hooks.flatMap(h => {
    if (!isObj(h) || typeof h.event !== 'string') return []
    const editable = isObj(h.editable) && isObj(h.editable.config) ? h.editable : null
    const source = str(h.source)
    const matcher = str(h.matcher)
    return [{
      event: h.event,
      matcher: matcher === '' ? null : matcher,
      source,
      sourceLabel: str(h.sourceLabel, source),
      pluginName: typeof h.pluginName === 'string' ? h.pluginName : null,
      type: str(h.type, 'command'),
      text: str(h.commandText, str(h.displayText)),
      scope: editable !== null ? SCOPES[source] ?? null : null,
      config: editable !== null ? editable.config as Record<string, unknown> : null
    }]
  }) : []
  const catalog: HookEvent[] = Array.isArray(r.eventCatalog)
    ? r.eventCatalog.flatMap(e => isObj(e) && typeof e.name === 'string' ? [{ name: e.name, summary: str(e.summary), supportsMatcher: e.supportsMatcher === true }] : [])
    : []
  const p = isObj(r.policy) ? r.policy : {}
  const policyNote = p.allDisabled === true ? 'Hooks are turned off (disableAllHooks), so none of these run.'
    : p.disabledByPolicy === true ? 'Your organization’s policy turns hooks off.'
    : p.managedOnly === true ? 'Your organization’s policy allows only its own hooks; the rest don’t run.'
    : p.pluginOnly === true ? 'Only plugin hooks run here.'
    : r.safeMode === true ? 'Claude Code is in safe mode, so hooks don’t run.'
    : r.bareMode === true ? 'Claude Code is in bare mode, so hooks don’t run.'
    : null
  return { hooks, catalog, policyNote }
}

/** Claude Code's `get_workspace_diff` answer. */
export function parseWorkspaceDiff(raw: unknown): WorkspaceDiff {
  const d = isObj(raw) && isObj(raw.diff) ? raw.diff : {}
  const hunksByPath = new Map<string, DiffFile['hunks']>()
  if (Array.isArray(d.hunks)) for (const f of d.hunks) {
    if (!isObj(f) || typeof f.path !== 'string' || !Array.isArray(f.hunks)) continue
    hunksByPath.set(f.path, f.hunks.flatMap(h => isObj(h) && Array.isArray(h.lines)
      ? [{ oldStart: num(h.oldStart), newStart: num(h.newStart), lines: h.lines.filter((l): l is string => typeof l === 'string') }]
      : []))
  }
  const files: DiffFile[] = Array.isArray(d.perFileStats) ? d.perFileStats.flatMap(f => isObj(f) && typeof f.path === 'string' ? [{
    path: f.path,
    added: num(f.added),
    removed: num(f.removed),
    binary: f.isBinary === true,
    untracked: f.isUntracked === true,
    status: str(f.status, 'modified'),
    hunks: hunksByPath.get(f.path) ?? []
  }] : []) : []
  const stats = isObj(d.stats) ? d.stats : {}
  const source = isObj(d.source) ? d.source : {}
  return {
    files,
    added: num(stats.linesAdded),
    removed: num(stats.linesRemoved),
    baseBranch: source.kind === 'branch' && typeof source.baseBranch === 'string' ? source.baseBranch : null,
    skipped: Array.isArray(d.skippedLarge) ? d.skippedLarge.flatMap(s => typeof s === 'string' ? [s] : isObj(s) && typeof s.path === 'string' ? [s.path] : []) : []
  }
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@')
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: '' }
}

/** `claude plugin list --json --available` and `claude plugin marketplace list --json`. */
export function parsePlugins(list: unknown, markets: unknown): PluginsState {
  const l = isObj(list) ? list : { installed: list }
  const installed: InstalledPlugin[] = Array.isArray(l.installed) ? l.installed.flatMap(p => {
    if (!isObj(p) || typeof p.id !== 'string') return []
    return [{
      id: p.id,
      ...splitId(p.id),
      version: str(p.version),
      scope: str(p.scope, 'user'),
      enabled: p.enabled === true,
      projectPath: typeof p.projectPath === 'string' ? p.projectPath : null,
      mcpServers: isObj(p.mcpServers) ? Object.keys(p.mcpServers) : []
    }]
  }) : []
  const available: AvailablePlugin[] = Array.isArray(l.available) ? l.available.flatMap(p => {
    if (!isObj(p)) return []
    const id = str(p.pluginId, typeof p.name === 'string' && typeof p.marketplaceName === 'string' ? `${p.name}@${p.marketplaceName}` : '')
    if (id === '') return []
    return [{ id, ...splitId(id), description: str(p.description), installs: typeof p.installCount === 'number' ? p.installCount : null }]
  }) : []
  const marketplaces: Marketplace[] = Array.isArray(markets) ? markets.flatMap(m => isObj(m) && typeof m.name === 'string'
    ? [{ name: m.name, source: str(m.source), where: str(m.repo, str(m.url, str(m.path, str(m.installLocation)))) }]
    : []) : []
  return { installed, available, marketplaces }
}

/** The `claude plugin` commands the /plugin screen runs. Anything else is refused. */
const PLUGIN_ACTIONS: ReadonlySet<string> = new Set([
  'install', 'uninstall', 'enable', 'disable', 'update',
  'marketplace add', 'marketplace remove', 'marketplace update'
])

/** One of PLUGIN_ACTIONS, then names, and no flag but `--scope user|project|local`, so a
 *  name can't smuggle in an option such as `-y`. */
export function pluginArgsAllowed(args: unknown): args is string[] {
  if (!Array.isArray(args) || args.length === 0 || !args.every(a => typeof a === 'string' && a.length > 0 && a.length < 500)) return false
  const words = args as string[]
  const action = words[0] === 'marketplace' ? `marketplace ${words[1] ?? ''}` : words[0]!
  if (!PLUGIN_ACTIONS.has(action)) return false
  const rest = words.slice(action.includes(' ') ? 2 : 1)
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i]!.startsWith('-')) continue
    if (rest[i] !== '--scope' || !['user', 'project', 'local'].includes(rest[i + 1] ?? '')) return false
    i++
  }
  return rest.some(w => !w.startsWith('-')) || action === 'marketplace update'
}
