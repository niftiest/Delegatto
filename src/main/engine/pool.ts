import type { SpawnSpec } from './transport'
import type { BackgroundTask, LiveEvent, EngineSnapshot, TurnInfo } from '../../shared/engine-types'

/** Narrow surface of Transport the pool depends on -- lets tests inject a
 *  fake transport (no real child_process spawned) while the production
 *  factory wraps a real `new Transport(spec, { claudeBin })`. Node-only,
 *  same as transport.ts: this file must never import electron (enforced by
 *  tests/architecture.test.ts). */
export interface TransportLike {
  /** Asks the process something without starting a turn. */
  request?(subtype: string, extra?: object, timeoutMs?: number): Promise<unknown>
  respond?(requestId: string, response: unknown, error?: string): void
  start(): void
  send(msg: object): void
  interrupt(): void
  /** OS pid once spawned (for the pool HUD's kill button); optional so fakes
   *  needn't implement it. */
  readonly pid?: number | null
  /** Graceful shutdown (reap / app-quit): lets the process exit on its own and
   *  clean up its session-lock file, force-killing only as a fallback. Distinct
   *  from interrupt() (a hard Ctrl-C that cancels the in-flight turn). */
  close(): void
  on(cb: (e: LiveEvent) => void): void
  onExit(cb: (code: number | null) => void): void
}

export type TransportFactory = (spec: SpawnSpec) => TransportLike

/** Builds the event emitted (in place of spawning) when a send targets a
 *  session the pool has been told is externally live -- e.g. a terminal
 *  already running `claude` against the same session file. Spawning a
 *  second writer would corrupt the JSONL's ordering, so the send is dropped
 *  and this is surfaced instead. A fresh object literal per call (rather
 *  than one shared module-level constant) so there is no shared-mutable
 *  state a subscriber could accidentally mutate and have it bleed into a
 *  later, unrelated refusal. */
function refusedExternalLive(): LiveEvent {
  return { kind: 'other', type: 'refused-external-live' }
}

/** The parts of a spec the user can change on a running chat. Not the session id,
 *  which legitimately goes from "create" to "resume" after the first process. */
function settingsKey(spec: SpawnSpec): string {
  const dirs = (spec.extraArgs ?? []).filter((a, i, all) => all[i - 1] === '--add-dir').map(d => d.toLowerCase()).sort()
  return JSON.stringify([spec.model, spec.effort, spec.permissionMode, spec.skipPermissions, spec.chrome, spec.maxBudgetUsd, spec.extraArgs?.includes('--prompt-suggestions') ?? false, dirs])
}

/** Claude Code's new list, keeping when each task started and how far it has got. */
function mergeBackgroundTasks(known: BackgroundTask[], incoming: BackgroundTask[], now: number): BackgroundTask[] {
  return incoming.map(t => {
    const before = known.find(k => k.id === t.id)
    return before === undefined ? { ...t, startedAt: now } : { ...t, startedAt: before.startedAt, lastTool: before.lastTool, tokens: before.tokens }
  })
}

/** A process just woken can take a while to answer about its files. */
const REWIND_WAIT_MS = 30_000

/** A message waiting for an old process to exit. */
type HeldSend = { uuid: string | null; run: () => void }

function uuidOf(msg: object): string | null {
  const uuid = (msg as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : null
}

interface Entry {
  transport: TransportLike
  /** The spec this transport was spawned with (model/effort for the HUD). */
  spec: SpawnSpec
  /** When the transport was spawned (pool HUD uptime). */
  startedAt: number
  lastActivity: number
  /** Replace it on the next message: see restartForReload. */
  reload?: boolean
  /** Whether a turn is CURRENTLY in flight on this transport (vs the process
   *  being pooled but idle between turns). Set true on every send() and cleared
   *  when the transport emits its terminal `result` for that turn. This is the
   *  "a turn is actively running" signal the UI's running-state re-derivation
   *  needs -- distinct from `isLive` (the process merely exists), which stays
   *  true for an idle pooled transport and must NOT be read as "still running".*/
  busy: boolean
  /** When the current turn began, and the output tokens it has used so far. Kept
   *  here so a chat reopened mid-turn shows the real figures. */
  turnStartedAt: number
  turnTokens: number
  /** What this process has running in the background. They die with it, so it isn't
   *  idle while there are any, even though no turn is running. */
  backgroundTasks: BackgroundTask[]
  /** Set the instant this entry is reaped/shut down. Captured by closures
   *  passed to `transport.on`/`onExit` at spawn time, so a transport's own
   *  late-firing callbacks (e.g. a delayed OS-level exit after we've already
   *  reaped it) check the ENTRY OBJECT they closed over, not a fresh map
   *  lookup by key -- so they can never mistakenly touch a different, later
   *  transport that has since been spawned under the same session key. */
  disposed: boolean
}

/**
 * Owns the lifecycle of Transport instances, keyed by session key: lazy
 * spawn on first send, reuse a live transport, reap idle transports, fan out
 * events to subscribers, and refuse to spawn a second writer against a session
 * a terminal already holds.
 *
 * There's no limit on how many run at once, so a message never waits for another
 * chat. What keeps the count down is `reapIdle`: a process with nothing running
 * closes after `idleReapMs`, and the chat resumes where it was on its next message.
 */
export class SessionPool {
  private readonly idleReapMs: () => number
  private readonly transportFactory: TransportFactory
  private readonly trustToAttest: (cwd: string) => string | null
  private readonly isExternallyLive: (sessionKey: string) => boolean
  private readonly now: () => number

  private readonly live = new Map<string, Entry>()
  private readonly subscribers = new Map<string, Array<(e: LiveEvent) => void>>()

  /** Set true by `shutdown()`. Terminal: a pool is single-use (shutdown is
   *  meant for app-quit), so once set, `send()`/`interrupt()`/`reapIdle()`
   *  become safe no-ops instead of silently respawning transports as if
   *  shutdown never happened. */
  private stopped = false
  /** Ensures the use-after-shutdown warning is logged once, not once per
   *  stray call, so a caller that keeps poking a shut-down pool doesn't
   *  flood the console. */
  private warnedAfterShutdown = false

  private readonly waitingForExit = new Map<string, Array<HeldSend>>()
  /** Messages Esc stopped before any process had them, so there's nothing to rewind. */
  private readonly neverSent = new Set<string>()

  constructor(opts: {
    /** A function when the limit can change while the app runs. */
    idleReapMs: number | (() => number)
    transportFactory: TransportFactory
    /** Predicate the pool consults before every spawn attempt -- return true when a terminal (or anything outside
     *  the pool) already holds this session's file. Defaults to "never". */
    isExternallyLive?: (sessionKey: string) => boolean
    /** Injectable clock so idle-tracking is deterministic under test (a
     *  fake clock closure). Defaults to `Date.now`. Not part of the task
     *  brief's literal interface, but required to test "updated on send and
     *  on each event" without depending on wall-clock timing. */
    now?: () => number
    /** The folder the user trusted in Delegatto's own prompt, to tell Claude Code at
     *  startup so it records the same answer a terminal would; null to say nothing. */
    trustToAttest?: (cwd: string) => string | null
  }) {
    const idleReapMs = opts.idleReapMs
    this.trustToAttest = opts.trustToAttest ?? (() => null)
    this.idleReapMs = typeof idleReapMs === 'function' ? idleReapMs : () => idleReapMs
    this.transportFactory = opts.transportFactory
    this.isExternallyLive = opts.isExternallyLive ?? (() => false)
    this.now = opts.now ?? Date.now
  }

  /** Lazy-spawns on first send for a key that isn't live; reuses a live
   *  transport's process for subsequent sends; refuses (with a
   *  `refused-external-live` event) instead of spawning when the session is
   *  externally live. */
  send(sessionKey: string, spec: SpawnSpec, msg: object): void {
    if (this.stopped) {
      this.warnUseAfterShutdown()
      return
    }

    // Still waiting for an old process to exit: this message goes after the ones ahead of it.
    const waiting = this.waitingForExit.get(sessionKey)
    if (waiting !== undefined) {
      waiting.push({ uuid: uuidOf(msg), run: () => this.send(sessionKey, spec, msg) })
      return
    }

    const entry = this.live.get(sessionKey)
    // A process keeps the settings it started with, so an idle one whose settings
    // have since changed makes way for a new one, which resumes the same chat. The new
    // one has to wait for the old to exit: until then its session lock still stands,
    // and it would read as another program holding the chat.
    // Not while it has background work: replacing it would kill that work, so this
    // message goes to the process as it is.
    if (entry !== undefined && !entry.busy && !entry.disposed && entry.backgroundTasks.length === 0 && (entry.reload === true || settingsKey(entry.spec) !== settingsKey(spec))) {
      this.closeAndHold(sessionKey, entry).push({ uuid: uuidOf(msg), run: () => this.send(sessionKey, spec, msg) })
      return
    }
    if (entry !== undefined) {
      entry.lastActivity = this.now()
      if (!entry.busy) { entry.turnStartedAt = this.now(); entry.turnTokens = 0 }
      entry.busy = true // a new turn is starting on this reused transport
      entry.transport.send(msg)
      return
    }

    if (this.isExternallyLive(sessionKey)) {
      this.emitTo(sessionKey, refusedExternalLive())
      return
    }

    this.spawn(sessionKey, spec, msg)
  }

  /** Stops the running turn. Between turns there's nothing to stop. */
  interrupt(sessionKey: string): void {
    if (this.stopped) {
      this.warnUseAfterShutdown()
      return
    }

    // Still waiting for an old process to close: what's held simply never goes.
    const waiting = this.waitingForExit.get(sessionKey)
    if (waiting !== undefined && waiting.length > 0) {
      for (const held of waiting.splice(0)) if (held.uuid !== null) this.neverSent.add(held.uuid)
      this.emitTo(sessionKey, { kind: 'result', isError: false, costUsd: 0, text: '', interrupted: true })
      return
    }

    const entry = this.live.get(sessionKey)
    if (entry?.busy === true) entry.transport.interrupt()
  }

  /** Starts a process with no message, for what only a running process can answer. */
  wake(sessionKey: string, spec: SpawnSpec): void {
    if (this.stopped || this.live.has(sessionKey) || this.waitingForExit.has(sessionKey) || this.isExternallyLive(sessionKey)) return
    this.spawn(sessionKey, spec, null)
  }

  /** Puts back files changed since a message, or with `dryRun` says what that would do.
   *  Null if there's no process to ask. */
  async rewindFiles(sessionKey: string, uuid: string, dryRun: boolean): Promise<{ canRewind: boolean; error: string | null; files: string[]; insertions: number; deletions: number } | null> {
    const answer = this.request(sessionKey, 'rewind_files', { user_message_id: uuid, ...(dryRun ? { dry_run: true } : {}) }, REWIND_WAIT_MS)
    if (answer === null) return null
    const r = await answer.catch(err => ({ canRewind: false, error: err instanceof Error ? err.message : String(err) })) as { canRewind?: unknown; error?: unknown; filesChanged?: unknown; insertions?: unknown; deletions?: unknown }
    return {
      canRewind: r.canRewind === true,
      error: typeof r.error === 'string' ? r.error : null,
      files: Array.isArray(r.filesChanged) ? r.filesChanged.filter((f): f is string => typeof f === 'string') : [],
      insertions: typeof r.insertions === 'number' ? r.insertions : 0,
      deletions: typeof r.deletions === 'number' ? r.deletions : 0
    }
  }

  /** Takes the chat back to before a message, and answers with that message's text. Null
   *  if it couldn't be done. */
  async rewindConversation(sessionKey: string, uuid: string): Promise<{ prefill: string } | null> {
    const answer = this.request(sessionKey, 'rewind_conversation', { target_message_uuid: uuid }, REWIND_WAIT_MS)
    if (answer === null) return null
    const r = await answer.catch(() => null) as { rewound?: unknown; prefillText?: unknown } | null
    return r?.rewound === true ? { prefill: typeof r.prefillText === 'string' ? r.prefillText : '' } : null
  }

  /** The end of a background command's output. Null if it can't be read. */
  async taskOutput(sessionKey: string, taskId: string): Promise<{ output: string; truncated: boolean } | null> {
    const answer = this.request(sessionKey, 'get_task_output', { task_id: taskId })
    if (answer === null) return null
    const r = await answer.catch(() => null) as { output?: unknown; truncated?: unknown } | null
    return typeof r?.output === 'string' ? { output: r.output, truncated: r.truncated === true } : null
  }

  /** Takes the chat back to before a message that was stopped before any reply, so Claude
   *  forgets it, as Esc does in a terminal. False if that couldn't be done. */
  async rewind(sessionKey: string, uuid: string): Promise<boolean> {
    if (this.neverSent.delete(uuid)) return true
    const answer = this.request(sessionKey, 'rewind_conversation', { target_message_uuid: uuid })
    if (answer === null) return false
    const response = await answer.catch(() => null) as { rewound?: unknown } | null
    return response?.rewound === true
  }

  /** Stops one background task, leaving the chat and any others running. */
  stopTask(sessionKey: string, taskId: string): void {
    this.request(sessionKey, 'stop_task', { task_id: taskId })?.catch(() => { /* it had finished */ })
  }

  /** Takes back a message that hasn't reached Claude yet. False once it has. */
  async withdraw(sessionKey: string, uuid: string): Promise<boolean> {
    const answer = this.request(sessionKey, 'cancel_async_message', { message_uuid: uuid })
    // No process holds it, so there's nothing it could still reach.
    if (answer === null) return true
    const response = await answer.catch(() => null) as { cancelled?: unknown } | null
    return response?.cancelled === true
  }

  isLive(sessionKey: string): boolean {
    return this.live.has(sessionKey)
  }

  /** Whether a turn is CURRENTLY streaming for this key -- a live entry whose
   *  `busy` flag hasn't been cleared by a terminal `result` yet. Distinct from
   *  `isLive`: an idle-but-pooled transport is live (blocks a
   *  second external writer) but NOT running a turn. The UI's running-state
   *  re-derivation reads THIS, so reopening a chat with an idle pooled process
   *  no longer wrongly wedges the composer into "streaming/queue" mode. */
  isTurnRunning(sessionKey: string): boolean {
    const entry = this.live.get(sessionKey)
    return entry !== undefined && !entry.disposed && entry.busy
  }

  /** The running turn's start, tokens and last sign of life, or null when no turn is running. */
  turnInfo(sessionKey: string): TurnInfo | null {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed || !entry.busy) return null
    return { startedAt: entry.turnStartedAt, tokens: entry.turnTokens, lastActivity: entry.lastActivity }
  }

  /** What this chat's process is running in the background. */
  backgroundTasks(sessionKey: string): BackgroundTask[] {
    return this.live.get(sessionKey)?.backgroundTasks ?? []
  }

  /** A snapshot of every live engine for the pool HUD (engine:list). */
  snapshot(): EngineSnapshot[] {
    const out: EngineSnapshot[] = []
    for (const [sessionKey, entry] of this.live) {
      if (entry.disposed) continue
      out.push({
        sessionKey,
        pid: entry.transport.pid ?? null,
        model: entry.spec.model ?? null,
        effort: entry.spec.effort ?? null,
        startedAt: entry.startedAt,
        lastActivity: entry.lastActivity,
        busy: entry.busy,
        background: entry.backgroundTasks.length
      })
    }
    return out
  }

  /** Gracefully close+dispose the engine with this pid (HUD kill button).
   *  Returns true if one was found. */
  killByPid(pid: number): boolean {
    for (const [key, entry] of this.live) {
      if (!entry.disposed && entry.transport.pid === pid) {
        this.dispose(key, entry)
        return true
      }
    }
    return false
  }

  /** Gracefully close+dispose this session's transport if it is pooled but
   *  IDLE (no turn in flight). Used when another process
   *  (a terminal) takes the chat over: our idle process's in-memory
   *  conversation is now stale, and reusing it on the next send would fork the
   *  transcript -- releasing it means the next send respawns with a fresh
   *  `--resume` that reads the up-to-date JSONL. A mid-turn transport is left
   *  alone (killing it would lose the in-flight turn). Returns true if one
   *  was released. */
  releaseIdle(sessionKey: string): boolean {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed || entry.busy || entry.backgroundTasks.length > 0) return false
    this.dispose(sessionKey, entry)
    return true
  }

  /** Something a process only reads at startup has changed: the chat's next message
   *  starts a new one, which resumes where it was. One mid-reply finishes first. */
  /** The process was told about this folder while running, so the next message's spec, which
   *  now lists it, is no reason to replace the process. */
  noteDirAdded(sessionKey: string, dir: string): void {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed) return
    entry.spec = { ...entry.spec, extraArgs: [...(entry.spec.extraArgs ?? []), '--add-dir', dir] }
  }

  restartForReload(sessionKey: string): 'restarted' | 'afterTurn' | 'none' {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed) return 'none'
    entry.reload = true
    return entry.busy || entry.backgroundTasks.length > 0 ? 'afterTurn' : 'restarted'
  }

  /** Asks a live process something (not a turn: it doesn't count as activity).
   *  Null when this chat has no process running. */
  /** Changes a running chat's model or mode without restarting it, even mid-turn. Afterwards
   *  its spec says the same, so the next message doesn't replace the process over it. False
   *  when no process is running, or it refused, and the next process starts with the change. */
  async changeLive(sessionKey: string, subtype: 'set_model' | 'set_permission_mode', extra: object, spec: Partial<SpawnSpec>): Promise<boolean> {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed) return false
    try {
      const answer = entry.transport.request?.(subtype, extra)
      if (answer === undefined) return false
      await answer
    } catch {
      return false
    }
    entry.spec = { ...entry.spec, ...spec }
    return true
  }

  /** Answers something a chat's process asked. */
  respond(sessionKey: string, requestId: string, response: unknown): void {
    const entry = this.live.get(sessionKey)
    if (entry !== undefined && !entry.disposed) entry.transport.respond?.(requestId, response)
  }

  request(sessionKey: string, subtype: string, extra?: object, timeoutMs?: number): Promise<unknown> | null {
    const entry = this.live.get(sessionKey)
    if (entry === undefined || entry.disposed) return null
    return entry.transport.request?.(subtype, extra, timeoutMs) ?? null
  }

  /** Registers a subscriber for a session's events. Registration is
   *  independent of whether the session is currently live -- a subscriber
   *  registered before the first spawn still receives events once it
   *  spawns (and across any later respawn under the same key). */
  on(sessionKey: string, cb: (e: LiveEvent) => void): void {
    const list = this.subscribers.get(sessionKey)
    if (list !== undefined) list.push(cb)
    else this.subscribers.set(sessionKey, [cb])
  }

  /** Caller-ticked (no internal timer): gracefully closes any process that has had
   *  nothing to do for longer than `idleReapMs`. That loses nothing: all durable
   *  state is in the JSONL the CLI writes.
   *
   *  Idle means nothing is running. A turn can be silent for a long time, on a long
   *  command or waiting for a permission answer, so silence alone isn't idleness. */
  reapIdle(nowMs: number): void {
    if (this.stopped) {
      this.warnUseAfterShutdown()
      return
    }

    const limit = this.idleReapMs()
    for (const [key, entry] of [...this.live.entries()]) {
      if (entry.disposed || entry.busy || entry.backgroundTasks.length > 0) continue
      if (nowMs - entry.lastActivity > limit) this.closeAndHold(key, entry)
    }
  }

  /** Gracefully closes+disposes every live transport.
   *  Idempotent: a second call finds nothing live, so it is a safe no-op.
   *
   *  Terminal: a `SessionPool` is single-use. `shutdown()` is meant for app
   *  quit -- once called, the pool never spawns again. `send()`,
   *  `interrupt()`, and `reapIdle()` all become no-ops afterward (each logs
   *  a one-time warning) rather than silently respawning transports as if
   *  shutdown had never happened. Construct a new `SessionPool` if a fresh
   *  one is needed. */
  shutdown(): void {
    const snapshot = [...this.live.entries()]
    for (const [key, entry] of snapshot) this.dispose(key, entry)
    this.stopped = true
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private warnUseAfterShutdown(): void {
    if (this.warnedAfterShutdown) return
    this.warnedAfterShutdown = true
    console.warn('[pool] use after shutdown')
  }

  private spawn(sessionKey: string, spec: SpawnSpec, msg: object | null): void {
    const transport = this.transportFactory(spec)
    const now = this.now()
    const entry: Entry = { transport, spec, startedAt: now, lastActivity: now, busy: msg !== null, turnStartedAt: now, turnTokens: 0, backgroundTasks: [], disposed: false }
    this.live.set(sessionKey, entry)

    transport.on((e) => {
      // Guards against a stale transport's late event landing after this
      // entry has been reaped/shut down (and possibly replaced by a fresh
      // spawn under the same key, which has its own Entry/closures).
      // Except what a closing process has left to say about its own saving.
      if (entry.disposed && e.kind !== 'writesLost') return
      entry.lastActivity = this.now()
      // The turn's terminal `result` marks the transport idle again -- it stays
      // pooled (isLive true) but is no longer running a turn (isTurnRunning
      // false), so the UI stops showing it as streaming.
      if (e.kind === 'result') entry.busy = false
      if (e.kind === 'usage') entry.turnTokens += e.outputTokens
      // Nobody sent this turn: a background task finished and Claude Code carried on.
      if (e.kind === 'init' && !entry.busy) {
        entry.busy = true
        entry.turnStartedAt = entry.lastActivity
        entry.turnTokens = 0
      }
      if (e.kind === 'background') {
        entry.backgroundTasks = mergeBackgroundTasks(entry.backgroundTasks, e.tasks, entry.lastActivity)
        this.emitTo(sessionKey, { kind: 'background', tasks: entry.backgroundTasks })
        return
      }
      if (e.kind === 'taskProgress') {
        entry.backgroundTasks = entry.backgroundTasks.map(t => t.id === e.taskId ? { ...t, lastTool: e.lastTool ?? t.lastTool, tokens: e.tokens ?? t.tokens } : t)
        this.emitTo(sessionKey, { kind: 'background', tasks: entry.backgroundTasks })
        return
      }
      this.emitTo(sessionKey, e)
    })

    transport.onExit((code) => {
      if (entry.disposed) return
      entry.disposed = true
      // Fan out a terminal `exit` LiveEvent BEFORE removing the entry, so
      // every subscriber (the coordinator, then the renderer) learns the
      // turn ended even when the transport never emitted its own `result`
      // -- a spawn error (claude not on PATH), an Esc-triggered SIGINT, or a
      // mid-turn crash all land here. The `entry.disposed` guard above
      // still applies first, so a reaped/shut-down entry's own late exit
      // (already handled by `dispose()`) never double-fires this.
      this.emitTo(sessionKey, { kind: 'exit', code })
      this.live.delete(sessionKey)
    })

    transport.start()
    // Declares the per-task stop button (background-tasks row). Without this an interrupt
    // kills background agents, which Esc in the terminal never does.
    // workspaceTrust: Claude Code then records the folder as trusted itself, so a terminal
    // there doesn't ask again. Only sent after the user answered Delegatto's own prompt.
    const trusted = this.trustToAttest(spec.cwd)
    transport.request?.('initialize', { perTaskStopAffordance: true, ...(trusted !== null ? { workspaceTrust: { accepted: true, directory: trusted } } : {}) })?.catch(() => { /* an older CLI; the turn still runs */ })
    if (msg !== null) transport.send(msg)
  }

  private dispose(sessionKey: string, entry: Entry): void {
    if (entry.disposed) return
    entry.disposed = true
    this.live.delete(sessionKey)
    // GRACEFUL close (not interrupt): reap/shutdown should let `claude` exit on
    // its own so it removes its ~/.claude/sessions/<pid>.json lock. A hard kill
    // here (the old interrupt() path) orphaned that lock, which then made a
    // later `claude --continue` in the same dir report "no previous conversation".
    entry.transport.close()
  }

  /** Closes a process and returns the list of what has to wait for it to exit. Until
   *  it does, its session lock still stands, and a new process would read as another
   *  program holding the chat. */
  private closeAndHold(sessionKey: string, entry: Entry): Array<HeldSend> {
    const after: Array<HeldSend> = []
    this.waitingForExit.set(sessionKey, after)
    entry.transport.onExit(() => {
      this.waitingForExit.delete(sessionKey)
      for (const next of after) next.run()
    })
    this.dispose(sessionKey, entry)
    return after
  }

  private emitTo(sessionKey: string, e: LiveEvent): void {
    const list = this.subscribers.get(sessionKey)
    if (list === undefined) return
    for (const cb of list) cb(e)
  }
}
