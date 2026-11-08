import { defaultSpawn, type ChildLike, type SpawnFn } from './transport'
import { parseControlResponse } from './events'
import { parseMcpServers } from './mcp-status'
import type { ContextUsage } from '../../shared/project-options'
import { APP_COMMANDS, TERMINAL_ONLY_COMMANDS, type ClaudeCommand, type ClaudeInfo, type ClaudeModel, type CommandSource, type McpServerStatus } from '../../shared/claude-info-types'

/** Asks Claude Code about a folder by starting a short-lived process and sending
 *  control requests. No message is sent, so it uses no tokens and creates no chat.
 *  Startup hooks still run. */
const BASE_ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence'
]
/** For the command list: leaves the user's MCP servers unstarted. */
export const INFO_ARGS = [...BASE_ARGS, '--strict-mcp-config']
/** For MCP status: starts them, which is the point. */
export const MCP_CHECK_ARGS = BASE_ARGS

/** For plan usage, asked at every launch: only the answer is wanted, so the user's
 *  startup hooks stay out of it. */
export const PLAN_USAGE_ARGS = [...INFO_ARGS, '--settings', '{"disableAllHooks":true}']

const TIMEOUT_MS = 20_000
/** A big diff takes a while to gather. */
const CONTROL_TIMEOUT_MS = 45_000
/** Long enough that opening several chats in one folder asks only once, short
 *  enough that a newly installed skill turns up without restarting. */
const CACHE_MS = 5 * 60_000
const CLOSE_GRACE_MS = 4000
/** How long a check waits for slow servers before reporting them as starting. */
const MCP_SETTLE_MS = 20_000
const MCP_POLL_MS = 1000

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Where a command came from. Claude only says so inside the description: a
 *  "(user)" or "(project)" suffix, a "(plugin)" prefix, or a "plugin:" name. */
function classify(name: string, description: string, builtin: boolean): Pick<ClaudeCommand, 'description' | 'source' | 'plugin'> {
  const suffix = /\s*\(([^()]*)\)\s*$/.exec(description)
  const withoutSuffix = suffix === null ? description : description.slice(0, suffix.index)
  if (name.startsWith('mcp__')) return { description, source: 'mcp', plugin: null }
  if (builtin) return { description, source: 'builtin', plugin: null }
  const tagged: Record<string, CommandSource> = { user: 'user', project: 'project', 'claude.ai sync': 'synced' }
  const source = suffix === null ? undefined : tagged[suffix[1]!]
  if (source !== undefined) return { description: withoutSuffix, source, plugin: null }
  const prefix = /^\(([^()]+)\)\s*/.exec(description)
  const colon = name.indexOf(':')
  const plugin = prefix?.[1] ?? (colon > 0 ? name.slice(0, colon) : null)
  if (plugin === null) return { description, source: 'builtin', plugin: null }
  return { description: prefix === null ? description : description.slice(prefix[0].length), source: 'plugin', plugin }
}

/** Commands worth offering: drops the terminal-only ones and Claude's internal
 *  entry points ("__remote-workflow", "… sessions only"). */
export function parseCommands(raw: unknown): ClaudeCommand[] {
  if (!Array.isArray(raw)) return []
  const out: ClaudeCommand[] = []
  for (const c of raw) {
    if (!isObj(c) || typeof c.name !== 'string' || c.name.length === 0) continue
    const description = typeof c.description === 'string' ? c.description : ''
    if (c.name.startsWith('__') || /sessions only\)\s*$/.test(description)) continue
    if (TERMINAL_ONLY_COMMANDS.has(c.name)) continue
    out.push({
      name: c.name,
      argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : '',
      aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string') : [],
      ...classify(c.name, description, c.builtin === true)
    })
  }
  return out
}

/** Claude's commands plus the ones Delegatto answers itself, which a headless Claude
 *  doesn't list, so the / menu offers every command that works here. */
export function withAppCommands(commands: ClaudeCommand[]): ClaudeCommand[] {
  const have = new Set(commands.flatMap(c => [c.name, ...c.aliases]))
  return [...commands, ...APP_COMMANDS.filter(c => !have.has(c.name)).map(c => ({ ...c, aliases: [...c.aliases], source: 'builtin' as const, plugin: null }))]
}

/** Claude's model list, without "default" (the pickers have their own entry for
 *  that). A label is its version when the description starts with one ("Opus 5.5"). */
export function parseModels(raw: unknown): ClaudeModel[] {
  if (!Array.isArray(raw)) return []
  const out: ClaudeModel[] = []
  for (const m of raw) {
    if (!isObj(m) || typeof m.value !== 'string' || m.value === 'default') continue
    const description = typeof m.description === 'string' ? m.description : ''
    const name = typeof m.displayName === 'string' ? m.displayName : m.value
    const first = description.split(' · ')[0]!
    out.push({
      value: m.value,
      label: first.toLowerCase().startsWith(name.toLowerCase()) && first.length < 30 ? first : name,
      description,
      resolved: typeof m.resolvedModel === 'string' ? m.resolvedModel : null,
      efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e): e is string => typeof e === 'string') : []
    })
  }
  return out
}

/** The answer to `get_context_usage`, or null if it isn't one. */
export function parseContextUsage(raw: unknown): ContextUsage | null {
  if (!isObj(raw) || typeof raw.totalTokens !== 'number' || typeof raw.maxTokens !== 'number' || raw.maxTokens <= 0) return null
  const categories = Array.isArray(raw.categories)
    ? raw.categories.flatMap(c => isObj(c) && c.kind === 'used' && typeof c.name === 'string' && typeof c.tokens === 'number' ? [{ name: c.name, tokens: c.tokens }] : [])
    : []
  return {
    usedTokens: raw.totalTokens,
    maxTokens: raw.maxTokens,
    percent: Math.min(100, typeof raw.percentage === 'number' ? raw.percentage : (raw.totalTokens / raw.maxTokens) * 100),
    categories: categories.sort((a, b) => b.tokens - a.tokens)
  }
}

/** One short-lived process: send requests, then close. */
export class ControlSession {
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private failure: Error | null = null
  private closed = false
  private nextId = 0
  private buffer = ''
  private readonly child: ChildLike

  constructor(spawnFn: SpawnFn, bin: string, args: string[], cwd: string) {
    this.child = spawnFn(bin, args, cwd)
    this.child.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()))
    this.child.stderr.on('data', () => { /* drained so the pipe never blocks */ })
    ;(this.child as unknown as { on(e: 'error', cb: (err: Error) => void): void }).on('error', err => this.fail(err))
    this.child.on('exit', code => this.fail(new Error(`Claude Code exited early (code ${String(code)}).`)))
  }

  request(subtype: string, extra: object = {}, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    if (this.failure !== null) return Promise.reject(this.failure)
    const id = `delegatto-${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Claude Code took too long to answer.'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) }
      })
      this.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...extra } }) + '\n')
    })
  }

  /** Closing stdin lets the process exit normally and remove its own session
   *  lock; killing it is only the fallback. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.child.stdin.end() } catch { /* already closed */ }
    const killer = setTimeout(() => { try { this.child.kill() } catch { /* already gone */ } }, CLOSE_GRACE_MS)
    killer.unref?.()
    this.child.on('exit', () => clearTimeout(killer))
  }

  private onData(text: string): void {
    this.buffer += text
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const control = parseControlResponse(this.buffer.slice(0, index))
      this.buffer = this.buffer.slice(index + 1)
      if (control === null) continue
      const waiter = this.pending.get(control.requestId)
      if (waiter === undefined) continue
      this.pending.delete(control.requestId)
      if (control.ok) waiter.resolve(control.response)
      else waiter.reject(new Error(control.error))
    }
  }

  private fail(err: Error): void {
    if (this.failure !== null) return
    this.failure = err
    for (const waiter of this.pending.values()) waiter.reject(err)
    this.pending.clear()
  }
}

export class ClaudeInfoService {
  private readonly cache = new Map<string, ClaudeInfo>()
  private readonly inFlight = new Map<string, Promise<ClaudeInfo>>()
  private readonly bin: () => string
  private readonly spawnFn: SpawnFn
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly chromeEnabled: () => boolean

  constructor(opts: { claudeBin: string | (() => string); spawnFn?: SpawnFn; now?: () => number; sleep?: (ms: number) => Promise<void>; chromeEnabled?: () => boolean }) {
    const claudeBin = opts.claudeBin
    this.bin = typeof claudeBin === 'string' ? () => claudeBin : claudeBin
    this.spawnFn = opts.spawnFn ?? defaultSpawn
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.chromeEnabled = opts.chromeEnabled ?? (() => false)
  }

  get(cwd: string, opts: { refresh?: boolean } = {}): Promise<ClaudeInfo> {
    const cached = this.cache.get(cwd)
    if (cached !== undefined && opts.refresh !== true && this.now() - cached.fetchedAt < CACHE_MS) return Promise.resolve(cached)
    const running = this.inFlight.get(cwd)
    if (running !== undefined) return running
    const request = this.ask(cwd).then(info => { this.cache.set(cwd, info); return info }).finally(() => this.inFlight.delete(cwd))
    this.inFlight.set(cwd, request)
    return request
  }

  private async ask(cwd: string): Promise<ClaudeInfo> {
    const session = new ControlSession(this.spawnFn, this.bin(), INFO_ARGS, cwd)
    try {
      const answer = await session.request('initialize')
      const a = isObj(answer) ? answer : {}
      return {
        commands: withAppCommands(parseCommands(a.commands)),
        models: parseModels(a.models),
        version: typeof a.claude_code_version === 'string' ? a.claude_code_version : null,
        fetchedAt: this.now()
      }
    } finally {
      session.close()
    }
  }

  /** The account's plan and limits. No transcript scan: only the limits are wanted. */
  async planUsage(cwd: string): Promise<unknown> {
    const session = new ControlSession(this.spawnFn, this.bin(), PLAN_USAGE_ARGS, cwd)
    try {
      return await session.request('get_usage', { skip_behaviors: true })
    } finally {
      session.close()
    }
  }

  /** Drops what's cached, so the next ask sees newly installed plugins' commands. */
  forget(): void {
    this.cache.clear()
  }

  /** One control request to a short-lived process in the folder, for a chat with no
   *  process running. `quiet` keeps the user's startup hooks from running for it. */
  async control(cwd: string, subtype: string, body: object = {}, opts: { quiet?: boolean } = {}): Promise<unknown> {
    const session = new ControlSession(this.spawnFn, this.bin(), opts.quiet === true ? PLAN_USAGE_ARGS : INFO_ARGS, cwd)
    try {
      return await session.request(subtype, body, CONTROL_TIMEOUT_MS)
    } finally {
      session.close()
    }
  }

  /** Starts the folder's MCP servers as a chat would, and reports how they did.
   *  Waits for slow ones, up to a limit; any still going are left as 'pending'. */
  async mcpCheck(cwd: string): Promise<McpServerStatus[]> {
    const args = this.chromeEnabled() ? [...MCP_CHECK_ARGS, '--chrome'] : MCP_CHECK_ARGS
    const session = new ControlSession(this.spawnFn, this.bin(), args, cwd)
    try {
      const deadline = this.now() + MCP_SETTLE_MS
      for (;;) {
        const answer = await session.request('mcp_status')
        const servers = parseMcpServers(isObj(answer) ? answer.mcpServers : null)
        if (!servers.some(s => s.status === 'pending') || this.now() >= deadline) return servers
        await this.sleep(MCP_POLL_MS)
      }
    } finally {
      session.close()
    }
  }
}
