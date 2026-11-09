import { safeExtraFlags, type SpawnSpec } from './transport'
import { alwaysAllowChanges, outsideFolder, sessionRuleStrings } from '../../shared/permission-scope'
import { allowAlwaysRule } from './permission-bridge'
import type { StreamedRow } from '../jsonl/stream'
import type { ContentBlock } from '../../shared/types'
import { FOLDER_MISSING, SHELL_OUTPUT_SENT, type PermissionSuggestion, type LiveEvent, type PermissionRequest, type PermissionDecision } from '../../shared/engine-types'

/** Engine core: ties the primitives built in Tasks 1-5 (pool, watcher,
 *  permission bridge, transport) into the one thing the IPC boundary
 *  (engine-ipc.ts, Task 6's electron half) actually calls. Node-only -- must
 *  never import electron; enforced by tests/architecture.test.ts the same as
 *  the rest of src/main/engine.
 *
 *  Narrow "Like" interfaces (PoolLike/WatcherLike/BridgeLike below) mirror the
 *  pattern pool.ts already established with TransportLike: the real
 *  SessionPool/SessionWatcher/PermissionBridge classes structurally satisfy
 *  them, but tests can inject lightweight fakes instead of standing up a real
 *  child-process pool or a real chokidar watch. */

export type SessionInfo = {
  sessionPk: number
  sessionKey: string
  filePath: string
  cwd: string
  resumeId: string
  indexedOffset: number
  /** True when this session has never been spawned against before (its
   *  durable file doesn't exist yet -- a brand-new chat from Task 8's
   *  startNewChat, before its first send). Optional so existing fixtures/
   *  tests that predate Task 8 (an established, resumable session) keep
   *  meaning "not new" by simply omitting the field -- see buildSpawnSpec. */
  isNew?: boolean
}

export type ImageBlockInput = { mediaType: string; dataBase64: string }

export interface PoolLike {
  send(sessionKey: string, spec: SpawnSpec, msg: object): void
  interrupt(sessionKey: string): void
  wake(sessionKey: string, spec: SpawnSpec): void
  on(sessionKey: string, cb: (e: LiveEvent) => void): void
  isTurnRunning(sessionKey: string): boolean
  respond?(sessionKey: string, requestId: string, response: unknown): void
  changeLive?(sessionKey: string, subtype: 'set_model' | 'set_permission_mode', extra: object, spec: Partial<SpawnSpec>): Promise<boolean>
  /** This chat's process was given a folder while running, so it needs no restart for it. */
  noteDirAdded?(sessionKey: string, dir: string): void
}

export interface WatcherLike {
  watch(filePath: string, fromOffset: number, onRows: (rows: StreamedRow[], endOffset: number) => void): void
  stop(): void
}

export interface BridgeLike {
  readonly toolName: string
  onRequest(cb: (req: PermissionRequest) => void): void
  resolve(id: string, decision: PermissionDecision): void
  handleRequest(args: unknown, sessionKey: string): { id: string; answer: Promise<unknown> }
  cancel(id: string): boolean
}

/** Persists "allow always" rules per cwd so the NEXT spawn against that
 *  working directory passes them via `--allowedTools`. A simple JSON-file
 *  backed implementation is wired in by engine-ipc.ts; tests use an
 *  in-memory fake. */
export type RulesStore = {
  add(cwd: string, rule: string): void
  get(cwd: string): string[]
}

export type EngineDefaults = {
  skipPermissions: boolean
  model?: string
  effort?: string
  permissionMode?: string
  claudeBin: string
}

export type EngineCoordinatorDeps = {
  pool: PoolLike
  makeWatcher: () => WatcherLike
  bridge: BridgeLike
  lookupSession: (sessionPk: number) => SessionInfo | null
  rulesStore: RulesStore
  defaults: EngineDefaults
  /** Predicate mirroring the pool's own two-writer guard: true when a
   *  terminal (or anything outside this app) already holds the session's
   *  file open. Checked here too -- not just inside whatever pool
   *  implementation is injected -- so `send()` never even builds a
   *  SpawnSpec/starts a watcher for a session this app must not touch, and so
   *  the refusal behaves identically regardless of whether the injected pool
   *  happens to enforce the same guard itself. */
  isExternallyLive: (sessionKey: string) => boolean
  /** Whether this spawn should enable Claude in Chrome (--chrome). Read at
   *  spawn time so a settings change applies to the next process. */
  chromeEnabled?: () => boolean
  /** Spending cap and extra CLI flags from the app settings, read at spawn
   *  time so a change applies to the next process. */
  /** Flags for this app's own processes only, never handed on to a terminal. */
  liveDetailFlags?: () => string[]
  spawnExtras?: () => { maxBudgetUsd: number | null; extraFlags: string[] }
  /** Whether a project's folder is there, since Claude can't start without it. */
  folderExists?: (cwd: string) => boolean
  /** What should reach Claude ahead of the chat's next message (`!` output). */
  contextForMessage?: (sessionPk: number) => ContentBlock[]
  /** Whether this chat's next process should ask for prompt suggestions. */
  wantsSuggestions?: (sessionPk: number) => boolean
  /** Folders outside the project that this chat's process may use. */
  projectDirs?: (sessionPk: number) => string[]
  /** "Always allow" on a folder: adds it to the project, as `/add-dir` does. False if it can't be. */
  addProjectDir?: (sessionPk: number, dir: string) => boolean
  /** Keeps each project's model, effort and permission choices, shared by its chats. */
  projectDefaults?: {
    load: (sessionPk: number) => Partial<EngineDefaults>
    save: (sessionPk: number, overrides: Partial<EngineDefaults>) => void
  }
}

/** Builds the exact MCP result an "other" refusal reads as -- a fresh literal
 *  per call, same rationale as pool.ts's refusedExternalLive: no shared
 *  mutable object a subscriber could stash and have mutate later. */
function refusedExternalLive(): LiveEvent {
  return { kind: 'other', type: 'refused-external-live' }
}

function unknownSessionEvent(): LiveEvent {
  return { kind: 'other', type: 'unknown-session' }
}

/** Builds the stream-json `user` turn sent over the transport's stdin.
 *  Text-only content stays a bare string (matches §2's simplest input
 *  shape); any images promote it to the block-array form with the text
 *  block first, mirroring the plan's recorded example verbatim. */
function buildUserMessage(text: string, images?: ImageBlockInput[], before: ContentBlock[] = [], uuid?: string): object {
  const id = uuid === undefined ? {} : { uuid }
  if ((images === undefined || images.length === 0) && before.length === 0) {
    return { type: 'user', ...id, message: { role: 'user', content: text } }
  }
  const blocks: ContentBlock[] = [
    ...before,
    // Empty for `!` output going by itself, and an empty block would be refused.
    ...(text.length > 0 ? [{ type: 'text', text } as ContentBlock] : []),
    ...(images ?? []).map((img): ContentBlock => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 }
    }))
  ]
  return { type: 'user', ...id, message: { role: 'user', content: blocks } }
}

/** Builds the SpawnSpec for one turn against an already-resolved session.
 *
 *  --session-id vs --resume (Task 8): a session whose durable file doesn't
 *  exist yet (`info.isNew`, from repos.ts's fs.existsSync check) has never
 *  been spawned before -- the CLI must be told to CREATE that session id
 *  (`--session-id`); there is nothing to `--resume`. Every other session
 *  (the file already exists -- an established chat, or this same chat's
 *  second-or-later spawn after an idle-reap) resumes in place from its
 *  durable `session_id`, never a fork. In practice this decision only bites
 *  once per session's lifetime in a given pool: SessionPool reuses one live
 *  Transport across every send() while it's alive, so a SpawnSpec is only
 *  ever consumed at the moment of an actual (re)spawn.
 *
 *  CRITICAL branch (per the T5 pairing): the permission tool + its MCP
 *  server + any persisted "allow always" rules are only wired in when
 *  `skipPermissions` is false. `--dangerously-skip-permissions` bypasses the
 *  permission-prompt-tool entirely, so setting it anyway would be dead
 *  config at best and a confusing signal at worst. */
function buildSpawnSpec(
  info: SessionInfo,
  defaults: EngineDefaults,
  rulesStore: RulesStore,
  chrome = false,
  extras: { maxBudgetUsd: number | null; extraFlags: string[] } = { maxBudgetUsd: null, extraFlags: [] },
  sessionRules: string[] = []
): SpawnSpec {
  const spec: SpawnSpec = {
    cwd: info.cwd,
    skipPermissions: defaults.skipPermissions
  }
  if (info.isNew === true) {
    spec.sessionId = info.resumeId
  } else {
    spec.resumeId = info.resumeId
  }
  if (defaults.model !== undefined) spec.model = defaults.model
  if (defaults.effort !== undefined) spec.effort = defaults.effort
  if (defaults.permissionMode !== undefined) spec.permissionMode = defaults.permissionMode
  if (chrome) spec.chrome = true
  if (extras.maxBudgetUsd !== null && extras.maxBudgetUsd > 0) spec.maxBudgetUsd = extras.maxBudgetUsd

  // Claude Code asks over stdin and stdout. As well as more about each request, this is what
  // offers Claude its question and plan-mode tools, so it applies when skipping permissions too.
  spec.permissionPromptTool = 'stdio'
  if (!defaults.skipPermissions) {
    const rules = [...rulesStore.get(info.cwd), ...sessionRules]
    if (rules.length > 0) spec.extraArgs = ['--allowedTools', rules.join(',')]
  }
  const userFlags = safeExtraFlags(extras.extraFlags)
  if (userFlags.length > 0) spec.extraArgs = [...(spec.extraArgs ?? []), ...userFlags]

  return spec
}

export { alwaysAllowChanges }

type PendingPermission = { req: PermissionRequest; sessionPk: number; cwd: string }

/**
 * Pure coordination logic wiring pool + watcher + permission bridge +
 * catalog lookup + rules persistence into the surface engine-ipc.ts forwards
 * to the renderer. Every dependency is injected so this is fully testable
 * with fakes -- no electron, no real child processes, no real filesystem
 * watching.
 */
export class EngineCoordinator {
  private readonly sessionInfoByPk = new Map<number, SessionInfo>()
  private readonly sessionKeyToPk = new Map<string, number>()
  private readonly watchers = new Map<number, WatcherLike>()
  private readonly subscribedKeys = new Set<string>()
  /** Modes picked in the chat header. They last as long as the app is open. */
  private readonly chatModes = new Map<number, string>()
  /** Requests Claude Code is waiting on, to the bridge's id for each. */
  private readonly asked = new Map<string, string>()
  /** Chats with `!` output to deliver once the running turn ends. */
  private readonly shellOutputWaiting = new Set<number>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  /** Per-chat overrides set by Task 8's New-Chat dialog (model/effort/
   *  skipPermissions chosen at creation time), consulted ahead of the
   *  coordinator's global EngineDefaults for that one sessionPk. Only used when
   *  no `projectDefaults` store is wired (tests). Callers must omit a
   *  field entirely (not set it to `undefined`) to fall back to the global
   *  default for it -- see effectiveDefaults, which spreads this object
   *  directly over `deps.defaults`. */
  private readonly sessionDefaults = new Map<number, Partial<EngineDefaults>>()
  /** What each chat was allowed "for this session". Gone when the app closes. */
  private readonly sessionGrants = new Map<number, { rules: string[]; dirs: string[] }>()

  private readonly eventListeners: Array<(sessionPk: number, e: LiveEvent) => void> = []
  private readonly rowsListeners: Array<(sessionPk: number, rows: StreamedRow[]) => void> = []
  private readonly permissionListeners: Array<(sessionPk: number, req: PermissionRequest) => void> = []

  constructor(private readonly deps: EngineCoordinatorDeps) {
    // Registered once, globally: the bridge is shared across every spawned
    // session, and each parked request already carries its own sessionKey to
    // route back to a sessionPk.
    this.deps.bridge.onRequest((req) => this.handleBridgeRequest(req))
  }

  /** Resolves the session, ensures its watcher + event subscription are
   *  running, builds the SpawnSpec for this turn, and hands it to the pool.
   *  A sessionPk the catalog doesn't know about (deleted session, stale
   *  reference, race with a prune) surfaces as an `unknown-session` event
   *  instead of throwing -- a bad IPC call from the renderer must never crash
   *  the main process. */
  /** `uuid` names the message, so it can be followed in the queue and withdrawn. */
  send(sessionPk: number, text: string, images?: ImageBlockInput[], uuid?: string): void {
    const info = this.deps.lookupSession(sessionPk)
    if (info === null) {
      this.emitEvent(sessionPk, unknownSessionEvent())
      return
    }
    this.cacheSessionInfo(sessionPk, info)

    if (this.deps.isExternallyLive(info.sessionKey)) {
      this.emitEvent(sessionPk, refusedExternalLive())
      return
    }

    if (info.cwd.length > 0 && this.deps.folderExists?.(info.cwd) === false) {
      this.emitEvent(sessionPk, { kind: 'other', type: FOLDER_MISSING })
      return
    }

    this.ensureEventSubscription(info.sessionKey, sessionPk)
    this.ensureWatcher(sessionPk, info)

    const spec = buildSpawnSpec(info, this.effectiveDefaults(sessionPk), this.deps.rulesStore,
      this.deps.chromeEnabled?.() ?? false, this.spawnExtrasFor(sessionPk), this.sessionRulesFor(sessionPk))
    // A slash command has to be the whole message, or Claude reads it as text.
    const before = text.trimStart().startsWith('/') ? [] : this.deps.contextForMessage?.(sessionPk) ?? []
    // `!` output that a message has already carried: nothing is left to say.
    if (text.length === 0 && before.length === 0 && (images === undefined || images.length === 0)) return
    const userMessage = buildUserMessage(text, images, before, uuid)
    if (text.length === 0) this.emitEvent(sessionPk, { kind: 'other', type: SHELL_OUTPUT_SENT })
    this.deps.pool.send(info.sessionKey, spec, userMessage)
  }

  /** Makes sure this chat has a process, with no message sent. False if it can't have one. */
  wake(sessionPk: number): boolean {
    const info = this.deps.lookupSession(sessionPk)
    if (info === null || this.deps.isExternallyLive(info.sessionKey)) return false
    if (info.cwd.length > 0 && this.deps.folderExists?.(info.cwd) === false) return false
    this.cacheSessionInfo(sessionPk, info)
    this.ensureEventSubscription(info.sessionKey, sessionPk)
    this.ensureWatcher(sessionPk, info)
    this.deps.pool.wake(info.sessionKey, buildSpawnSpec(info, this.effectiveDefaults(sessionPk), this.deps.rulesStore,
      this.deps.chromeEnabled?.() ?? false, this.spawnExtrasFor(sessionPk), this.sessionRulesFor(sessionPk)))
    return true
  }

  /** Gives Claude a finished `!` command's output, which starts a turn as it does in the
   *  terminal. During a turn it waits for the turn to end. While something outside this
   *  app holds the chat it can't go at all, so it stays for the next message. */
  deliverShellOutput(sessionPk: number): void {
    const info = this.deps.lookupSession(sessionPk)
    if (info === null || this.deps.isExternallyLive(info.sessionKey)) return
    this.ensureEventSubscription(info.sessionKey, sessionPk)
    if (this.deps.pool.isTurnRunning(info.sessionKey)) {
      this.shellOutputWaiting.add(sessionPk)
      return
    }
    this.shellOutputWaiting.delete(sessionPk)
    this.send(sessionPk, '')
  }

  /** Registers per-chat overrides (Task 8) for one sessionPk -- e.g. the
   *  model/effort/skipPermissions chosen in the New-Chat dialog. Pass only
   *  the fields to override; an omitted field falls back to the
   *  coordinator's global EngineDefaults (see effectiveDefaults). */
  setSessionDefaults(sessionPk: number, overrides: Partial<EngineDefaults>): void {
    this.sessionDefaults.set(sessionPk, overrides)
    this.deps.projectDefaults?.save(sessionPk, overrides)
  }

  /** Like setSessionDefaults but MERGES over any existing overrides rather
   *  than replacing them -- the chat header's model/effort selectors change
   *  one field at a time and must not clobber the other, nor the
   *  skipPermissions the New-Chat dialog may already have registered. */
  mergeSessionDefaults(sessionPk: number, overrides: Partial<EngineDefaults>): void {
    const next: Partial<EngineDefaults> = { ...this.overridesFor(sessionPk), ...overrides }
    // undefined means "back to the default", which only works if the key is gone:
    // effectiveDefaults spreads this over the defaults.
    for (const key of Object.keys(next) as Array<keyof EngineDefaults>) if (next[key] === undefined) delete next[key]
    this.sessionDefaults.set(sessionPk, next)
    this.deps.projectDefaults?.save(sessionPk, next)
  }

  /** The flags that make a terminal run this chat the way it runs here: permissions,
   *  model, effort, Chrome and the user's extra flags. Not the spending cap, which
   *  Claude only applies to non-interactive runs, or Delegatto's own permission
   *  server, which is what a terminal's own prompts replace. */
  terminalFlags(sessionPk: number): string[] {
    const d = this.effectiveDefaults(sessionPk)
    const flags: string[] = []
    if (d.skipPermissions) flags.push('--dangerously-skip-permissions')
    else if (d.permissionMode !== undefined) flags.push('--permission-mode', d.permissionMode)
    if (d.model !== undefined) flags.push('--model', d.model)
    if (d.effort !== undefined) flags.push('--effort', d.effort)
    if (this.deps.chromeEnabled?.() === true) flags.push('--chrome')
    return [...flags, ...safeExtraFlags(this.deps.spawnExtras?.().extraFlags ?? []), ...this.dirFlags(sessionPk)]
  }

  interrupt(sessionPk: number): void {
    const info = this.resolveCachedOrLookup(sessionPk)
    if (info === null) return
    this.deps.pool.interrupt(info.sessionKey)
  }

  /** Pairs with PermissionBridge's parked promise (Task 5): `allow_always`
   *  derives a persisted rule from the ORIGINAL pending request (tool/input)
   *  and stores it against the session's cwd before resolving -- so the rule
   *  is in place for the NEXT spawn's `--allowedTools`, not this one (this
   *  turn's tool call has already happened; there is nothing to retrofit it
   *  onto). `allow` and `allow_always` both resolve as an ordinary `allow`.
   *  An unknown id (already resolved, timed out, or simply never parked here
   *  -- e.g. a stale renderer retry) still forwards to `bridge.resolve` (a
   *  documented no-op for an unrecognized id) but never leaves a pending
   *  entry behind either way, since the `delete` below runs unconditionally. */
  resolvePermission(id: string, decision: 'allow' | 'allow_always' | 'allow_folder' | 'deny', editedInput?: unknown, denyMessage?: string): void {
    const pending = this.pendingPermissions.get(id)
    this.pendingPermissions.delete(id)
    try {
      this.answerPermission(id, pending, decision, editedInput, denyMessage)
    } finally {
      // Every window showing the card drops it, not only the one that answered.
      if (pending !== undefined) this.emitEvent(pending.sessionPk, { kind: 'permissionGone', id })
    }
  }

  private answerPermission(
    id: string, pending: PendingPermission | undefined,
    decision: 'allow' | 'allow_always' | 'allow_folder' | 'deny', editedInput?: unknown, denyMessage?: string
  ): void {
    if (decision === 'deny') {
      this.deps.bridge.resolve(id, { behavior: 'deny', message: denyMessage ?? 'Denied by user' })
      return
    }

    if (decision === 'allow_folder') {
      const folder = pending === undefined ? null : outsideFolder(pending.req)
      if (pending !== undefined && folder !== null && this.deps.addProjectDir?.(pending.sessionPk, folder) === true) {
        // The running process gets it now, so this chat carries on with no restart.
        this.deps.pool.noteDirAdded?.(pending.req.sessionKey, folder)
        this.deps.bridge.resolve(id, { behavior: 'allow', updatedInput: editedInput ?? pending.req.input, updatedPermissions: [{ type: 'addDirectories', directories: [folder], destination: 'session' }] })
        return
      }
      decision = 'allow_always' // A folder that can't be saved still gets what the session can have.
    }

    if (decision === 'allow_always' && pending !== undefined && pending.req.tool !== 'ExitPlanMode') this.rememberSessionGrants(pending)

    // Claude Code says what "don't ask again" means for this request, and applies it now.
    // For a plan, the same button means "and accept edits from here on".
    const suggestions: PermissionSuggestion[] = decision !== 'allow_always' ? []
      : pending?.req.tool === 'ExitPlanMode' ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      : alwaysAllowChanges(pending?.req.suggestions ?? [])
    if (decision === 'allow_always' && suggestions.length === 0 && pending !== undefined) {
      const rule = allowAlwaysRule(pending.req.tool, pending.req.input)
      this.deps.rulesStore.add(pending.cwd, rule)
    }

    this.deps.bridge.resolve(id, { behavior: 'allow', updatedInput: editedInput ?? pending?.req.input, ...(suggestions.length > 0 ? { updatedPermissions: suggestions } : {}) })
  }

  /** The requests still waiting on an answer, oldest first, for a window opened after they came. */
  pendingPermissionList(): Array<{ sessionPk: number; req: PermissionRequest }> {
    return [...this.pendingPermissions.values()].map(p => ({ sessionPk: p.sessionPk, req: p.req }))
  }

  onEvent(cb: (sessionPk: number, e: LiveEvent) => void): void {
    this.eventListeners.push(cb)
  }

  onRows(cb: (sessionPk: number, rows: StreamedRow[]) => void): void {
    this.rowsListeners.push(cb)
  }

  onPermission(cb: (sessionPk: number, req: PermissionRequest) => void): void {
    this.permissionListeners.push(cb)
  }

  /** Starts tailing a session's transcript WITHOUT sending anything -- used
   *  while a terminal holds the chat, so its turns stream into the open
   *  transcript (via onRows) instead of waiting for the periodic sweep.
   *  Idempotent (reuses a running watcher). Returns false for an unknown
   *  sessionPk. */
  watchSession(sessionPk: number): boolean {
    const info = this.deps.lookupSession(sessionPk)
    if (info === null) return false
    this.cacheSessionInfo(sessionPk, info)
    this.ensureWatcher(sessionPk, info)
    return true
  }

  /** Stops the session's watcher (if one is running) so repeated sends to
   *  the same session never leak watchers across the session's lifetime, and
   *  a closed chat stops tailing its file. Safe to call for a session with no
   *  watcher (nothing to dispose, e.g. a session that was only ever refused
   *  for being externally live).
   *
   *  Deliberately does NOT clear `sessionInfoByPk`/`sessionKeyToPk` or deny
   *  any of the session's pending permission requests: closing a chat's view
   *  (switching to a different one) is not the same as abandoning its
   *  in-flight turn -- the pool/transport keep running independently of the
   *  watcher, a tool call can still be waiting on a decision, and
   *  `resolvePermission`'s `allow_always` needs the cached cwd to persist a
   *  rule even if that answer arrives after the chat view was closed.
   *  PermissionBridge's own per-request timeout (Task 5) is what eventually
   *  cleans up a request nobody ever answers. */
  disposeSession(sessionPk: number): void {
    const watcher = this.watchers.get(sessionPk)
    if (watcher === undefined) return
    watcher.stop()
    this.watchers.delete(sessionPk)
  }

  /** Whole-coordinator teardown for app quit (Plan 2 review Fix 3):
   *  `disposeSession` above is per-session and, before this fix, was called
   *  from nowhere -- every SessionWatcher ever started leaked for the app's
   *  full lifetime. This stops EVERY active watcher (regardless of whether
   *  its session has a turn mid-flight -- the whole process is exiting, so
   *  there is no "later" for it to resume) and clears every per-session
   *  bookkeeping map, so nothing in this coordinator instance keeps a
   *  reference alive past teardown. Deliberately does NOT touch
   *  `pendingPermissions` -- same rationale as `disposeSession`, and moot at
   *  app-quit either way. Idempotent: a second call finds every map already
   *  empty and is a no-op. */
  disposeAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
    this.sessionInfoByPk.clear()
    this.sessionKeyToPk.clear()
    this.sessionDefaults.clear()
    this.subscribedKeys.clear()
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private handleBridgeRequest(req: PermissionRequest): void {
    const sessionPk = this.sessionKeyToPk.get(req.sessionKey)
    if (sessionPk === undefined) {
      // A permission request whose sessionKey doesn't map back to any
      // sessionPk this coordinator has ever sent for -- nothing in the
      // renderer knows which chat to show it against. Log and drop rather
      // than forward a request no UI surface can route, and don't park it
      // (parking with no route would just leak on out on the pending map
      // until its own timeout).
      console.warn(`[engine-coordinator] permission request for unmapped sessionKey "${req.sessionKey}" -- dropping`)
      return
    }

    const cwd = this.sessionInfoByPk.get(sessionPk)?.cwd ?? ''
    this.pendingPermissions.set(req.id, { req, sessionPk, cwd })
    for (const cb of this.permissionListeners) cb(sessionPk, req)
  }

  /** Merges any Task 8 per-session overrides over the coordinator's global
   *  EngineDefaults. A session with no overrides registered returns
   *  `deps.defaults` by reference (no allocation on the hot path every
   *  send() already is). */
  private effectiveDefaults(sessionPk: number): EngineDefaults {
    const merged = { ...this.deps.defaults, ...this.overridesFor(sessionPk) }
    const mode = this.chatModes.get(sessionPk)
    if (mode === undefined) return merged
    return mode === 'bypassPermissions'
      ? { ...merged, skipPermissions: true, permissionMode: undefined }
      : { ...merged, skipPermissions: false, permissionMode: mode }
  }

  /** The mode this chat is in, or will start its next process in. */
  modeOf(sessionPk: number): string {
    const d = this.effectiveDefaults(sessionPk)
    return d.skipPermissions ? 'bypassPermissions' : d.permissionMode ?? 'default'
  }

  /** Switches a chat's mode: at once if it has a process, even mid-turn, or else for its next. */
  async setPermissionMode(sessionPk: number, mode: string): Promise<void> {
    this.chatModes.set(sessionPk, mode)
    const info = this.deps.lookupSession(sessionPk)
    if (info === null) return
    const d = this.effectiveDefaults(sessionPk)
    await this.deps.pool.changeLive?.(info.sessionKey, 'set_permission_mode', { mode }, { skipPermissions: d.skipPermissions, permissionMode: d.permissionMode })
  }

  /** A model picked for a chat with a running process applies straight away. */
  async setLiveModel(sessionPk: number, model: string): Promise<void> {
    const info = this.deps.lookupSession(sessionPk)
    if (info !== null) await this.deps.pool.changeLive?.(info.sessionKey, 'set_model', { model }, { model })
  }

  /** The choices that apply to this chat, which belong to its project when stored. */
  private overridesFor(sessionPk: number): Partial<EngineDefaults> {
    // Read fresh each time: another chat in the folder may have changed them.
    if (this.deps.projectDefaults !== undefined) return this.deps.projectDefaults.load(sessionPk)
    return this.sessionDefaults.get(sessionPk) ?? {}
  }

  private dirFlags(sessionPk: number): string[] {
    const dirs = [...(this.deps.projectDirs?.(sessionPk) ?? [])]
    for (const dir of this.sessionGrants.get(sessionPk)?.dirs ?? []) {
      if (!dirs.some(d => d.toLowerCase() === dir.toLowerCase())) dirs.push(dir)
    }
    return dirs.flatMap(dir => ['--add-dir', dir])
  }

  /** A chat's process closes when idle and comes back on the next message. To the user that's
   *  the same session, so what they allowed for it comes back too, until the app closes. */
  private rememberSessionGrants(pending: PendingPermission): void {
    const changes = alwaysAllowChanges(pending.req.suggestions ?? [])
    const grants = this.sessionGrants.get(pending.sessionPk) ?? { rules: [], dirs: [] }
    for (const rule of sessionRuleStrings(changes)) {
      if (!grants.rules.includes(rule)) grants.rules.push(rule)
    }
    for (const s of changes) {
      if (s.type !== 'addDirectories' || s.destination !== 'session') continue
      for (const dir of s.directories ?? []) {
        if (grants.dirs.includes(dir)) continue
        grants.dirs.push(dir)
        this.deps.pool.noteDirAdded?.(pending.req.sessionKey, dir)
      }
    }
    this.sessionGrants.set(pending.sessionPk, grants)
  }

  private sessionRulesFor(sessionPk: number): string[] {
    return this.sessionGrants.get(sessionPk)?.rules ?? []
  }

  private spawnExtrasFor(sessionPk: number): { maxBudgetUsd: number | null; extraFlags: string[] } {
    const extras = this.deps.spawnExtras?.() ?? { maxBudgetUsd: null, extraFlags: [] }
    return {
      ...extras,
      extraFlags: [...extras.extraFlags, ...(this.deps.liveDetailFlags?.() ?? []), ...this.dirFlags(sessionPk), ...(this.deps.wantsSuggestions?.(sessionPk) === true ? ['--prompt-suggestions'] : [])]
    }
  }

  private cacheSessionInfo(sessionPk: number, info: SessionInfo): void {
    this.sessionInfoByPk.set(sessionPk, info)
    this.sessionKeyToPk.set(info.sessionKey, sessionPk)
  }

  private resolveCachedOrLookup(sessionPk: number): SessionInfo | null {
    const cached = this.sessionInfoByPk.get(sessionPk)
    if (cached !== undefined) return cached
    const info = this.deps.lookupSession(sessionPk)
    if (info === null) return null
    this.cacheSessionInfo(sessionPk, info)
    return info
  }

  /** Registers exactly one pool subscriber per sessionKey -- pool.on() has no
   *  matching "off", so calling it again on every send would pile up
   *  duplicate subscribers that each re-emit the same event. */
  private ensureEventSubscription(sessionKey: string, sessionPk: number): void {
    if (this.subscribedKeys.has(sessionKey)) return
    this.subscribedKeys.add(sessionKey)
    this.deps.pool.on(sessionKey, (e) => {
      if (e.kind === 'permissionAsked') { this.askPermission(sessionKey, e.requestId, e.args); return }
      if (e.kind === 'permissionCancelled') { this.cancelPermission(sessionKey, sessionPk, e.requestId); return }
      // Nothing is left to answer for a process that has gone.
      if (e.kind === 'exit') for (const requestId of [...this.asked.keys()].filter(k => k.startsWith(`${sessionKey}\0`))) this.cancelPermission(sessionKey, sessionPk, requestId.slice(sessionKey.length + 1))
      this.emitEvent(sessionPk, e)
      if (e.kind === 'result' && this.shellOutputWaiting.has(sessionPk)) this.deliverShellOutput(sessionPk)
    })
  }

  private askPermission(sessionKey: string, requestId: string, args: Record<string, unknown>): void {
    const { id, answer } = this.deps.bridge.handleRequest(args, sessionKey)
    const key = `${sessionKey}\0${requestId}`
    this.asked.set(key, id)
    void answer.then((result: unknown) => {
      // A cancelled one has nobody left to hear the answer.
      if (this.asked.delete(key)) this.deps.pool.respond?.(sessionKey, requestId, result)
    })
  }

  private cancelPermission(sessionKey: string, sessionPk: number, requestId: string): void {
    const key = `${sessionKey}\0${requestId}`
    const id = this.asked.get(key)
    if (id === undefined) return
    this.asked.delete(key)
    this.pendingPermissions.delete(id)
    this.deps.bridge.cancel(id)
    this.emitEvent(sessionPk, { kind: 'permissionGone', id })
  }

  /** Starts exactly one watcher per session, from the offset the catalog has
   *  already indexed up to. A repeated send to the same session reuses the
   *  running watcher instead of starting a second one against the same file
   *  (which would double-emit every appended row). */
  private ensureWatcher(sessionPk: number, info: SessionInfo): void {
    if (this.watchers.has(sessionPk)) return
    const watcher = this.deps.makeWatcher()
    watcher.watch(info.filePath, info.indexedOffset, (rows) => {
      for (const cb of this.rowsListeners) cb(sessionPk, rows)
    })
    this.watchers.set(sessionPk, watcher)
  }

  private emitEvent(sessionPk: number, e: LiveEvent): void {
    for (const cb of this.eventListeners) cb(sessionPk, e)
  }
}
