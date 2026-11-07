import { spawn as nodeSpawn } from 'node:child_process'
import { elicitationFrom, parseControlRequest, parseControlResponse, parseEvent } from './events'
import type { LiveEvent } from '../../shared/engine-types'

/** Everything needed to build one `claude` invocation's argv and spawn it
 *  against a given working directory. Mirrors §2/Task 2 of the write-path
 *  plan -- session identity is always known up front (new chat carries
 *  sessionId, continue carries resumeId), never both. */
export type SpawnSpec = {
  cwd: string
  sessionId?: string
  resumeId?: string
  model?: string
  effort?: string
  permissionMode?: string
  skipPermissions: boolean
  permissionPromptTool?: string
  /** Pass --chrome: headless (-p) runs don't turn on Claude in Chrome by
   *  themselves, even when the user enabled it by default for the CLI. */
  chrome?: boolean
  /** --max-budget-usd: the process stops once it has spent this much. */
  maxBudgetUsd?: number
  extraArgs?: string[]
}

/** Pure argv builder -- no I/O, no side effects. Order is stable so callers
 *  (and tests) can assert on the exact array. */
export function buildArgs(spec: SpawnSpec): string[] {
  if (spec.sessionId !== undefined && spec.resumeId !== undefined) {
    throw new Error('SpawnSpec.sessionId and SpawnSpec.resumeId are mutually exclusive')
  }

  const args: string[] = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Reports when a queued message is taken in, which the composer's queue shows.
    '--replay-user-messages',
    // Hooks running or failing, so a chat they hold up doesn't look stuck.
    '--include-hook-events',
    // Lets the mode change to bypass during a chat. It doesn't start in that mode.
    '--allow-dangerously-skip-permissions'
  ]

  if (spec.sessionId !== undefined) args.push('--session-id', spec.sessionId)
  // Continuing a session resumes in place -- --fork-session is deliberately
  // never added here.
  if (spec.resumeId !== undefined) args.push('--resume', spec.resumeId)

  if (spec.model !== undefined) args.push('--model', spec.model)
  if (spec.effort !== undefined) args.push('--effort', spec.effort)
  if (spec.permissionMode !== undefined) args.push('--permission-mode', spec.permissionMode)
  if (spec.skipPermissions) args.push('--dangerously-skip-permissions')
  if (spec.permissionPromptTool !== undefined) args.push('--permission-prompt-tool', spec.permissionPromptTool)
  if (spec.chrome === true) args.push('--chrome')
  if (spec.maxBudgetUsd !== undefined && spec.maxBudgetUsd > 0) args.push('--max-budget-usd', String(spec.maxBudgetUsd))

  if (spec.extraArgs !== undefined) args.push(...spec.extraArgs)

  return args
}

/** Flags Delegatto itself controls: a user's "extra flags" may not repeat
 *  them (they would break the stream-json protocol or the session identity). */
const RESERVED_FLAGS = new Set([
  '-p', '--print', '--input-format', '--output-format', '--include-partial-messages', '--replay-user-messages',
  '--session-id', '--resume', '-r', '--continue', '-c', '--fork-session',
  '--permission-prompt-tool', '--mcp-config', '--dangerously-skip-permissions', '--worktree', '-w'
])

/** The user's extra CLI flags minus any Delegatto reserves (a reserved flag's
 *  value, the next token when it doesn't start with '-', is dropped too). */
export function safeExtraFlags(flags: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!
    const name = f.split('=')[0]!
    if (RESERVED_FLAGS.has(name)) {
      if (!f.includes('=') && i + 1 < flags.length && !flags[i + 1]!.startsWith('-')) i++
      continue
    }
    out.push(f)
  }
  return out
}

/** Minimal shape of a spawned child that Transport depends on -- narrow
 *  enough that tests can inject a fake without touching node:child_process.
 *  The real default spawnFn hands back an actual ChildProcess, which
 *  satisfies this structurally. */
export interface ChildLike {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdin: NodeJS.WritableStream
  /** OS process id once spawned (the real ChildProcess has it; fakes may omit). */
  pid?: number | null
  kill(signal?: string): void
  on(event: 'exit', cb: (code: number | null) => void): void
}

/** A child object that also emits Node's async spawn-failure event (ENOENT,
 *  EACCES, ...). The real ChildProcess always supports this; it is kept out
 *  of the public ChildLike contract so fakes only need to implement 'exit'. */
interface ErrorCapableChild {
  on(event: 'error', cb: (err: Error) => void): void
}

export type SpawnFn = (bin: string, args: string[], cwd: string) => ChildLike

const NEWLINE = 0x0a
const STDERR_TAIL_BYTES = 4096

/** What a Claude Code session sets for its own children. Delegatto can be started
 *  from inside one, and its chats must not inherit that: the child marker turns off
 *  transcript saving and session registration, and the rest would tie them to a
 *  session that isn't theirs. The user's own settings (CLAUDE_CONFIG_DIR, ...) stay. */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'
]

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const name of Object.keys(clean)) {
    if (INHERITED_SESSION_VARS.includes(name.toUpperCase())) delete clean[name]
  }
  // Keeps the file copies Rewind restores from, as the terminal always does. Off by default
  // for a process run this way.
  clean.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ??= '1'
  return clean
}

export function defaultSpawn(bin: string, args: string[], cwd: string): ChildLike {
  // windowsHide: a GUI (packaged) Electron app spawning a console program
  // would otherwise pop a visible console window per claude process.
  const child = nodeSpawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  return child as unknown as ChildLike
}

/** Wraps one spawned `claude` process: frames its stdout into LiveEvents,
 *  writes stream-json user turns to stdin, and forwards interrupt/exit.
 *  Node-only (child_process) -- must never import electron; the pool and
 *  IPC layer built on top of this are the electron-aware boundary. */
const INTERRUPT_GRACE_MS = 5000

export class Transport {
  private readonly spec: SpawnSpec
  private readonly claudeBin: string
  private readonly spawnFn: SpawnFn
  private child: ChildLike | null = null
  private started = false
  private exited = false
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null
  /** Set from asking a turn to stop until it has. */
  private interruptTimer: ReturnType<typeof setTimeout> | null = null

  private pendingStdout: Buffer = Buffer.alloc(0)
  private stderrTail = ''
  private nextRequestId = 0
  private readonly pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private readonly eventListeners: Array<(e: LiveEvent) => void> = []
  private readonly exitListeners: Array<(code: number | null) => void> = []

  /** Constructor shape: `new Transport(spec, opts)`, where `opts.claudeBin`
   *  is the resolved `claude` executable path/name and `opts.spawnFn` is an
   *  optional injection point -- omit it in production (defaults to a real
   *  `node:child_process.spawn` wrapped as `ChildLike`), or pass a fake to
   *  test against an in-memory child (see `tests/engine-transport.test.ts`'s
   *  `FakeChild`). Task 4 (pool) should construct via
   *  `new Transport(spec, { claudeBin })` and only pass `spawnFn` in tests. */
  constructor(spec: SpawnSpec, opts: { claudeBin: string; spawnFn?: SpawnFn }) {
    this.spec = spec
    this.claudeBin = opts.claudeBin
    this.spawnFn = opts.spawnFn ?? defaultSpawn
  }

  start(): void {
    if (this.started) throw new Error('Transport.start() called twice')
    this.started = true

    const args = buildArgs(this.spec)
    const child = this.spawnFn(this.claudeBin, args, this.spec.cwd)
    this.child = child

    child.stdout.on('data', (chunk: Buffer | string) => this.onStdoutChunk(chunk))
    child.stderr.on('data', (chunk: Buffer | string) => this.onStderrChunk(chunk))

    // Node emits 'error' (not 'exit') for spawn-time failures like a bad
    // claudeBin (ENOENT). Surface it as an event and a synthetic exit
    // instead of letting it become an uncaught exception that kills the app.
    ;(child as unknown as ErrorCapableChild).on('error', (err: Error) => {
      this.emitEvent({ kind: 'other', type: `spawn-error: ${err.message}` })
      this.fireExit(null)
    })

    child.on('exit', (code) => {
      if (code !== 0 && code !== null && this.stderrTail.length > 0) {
        this.emitEvent({ kind: 'other', type: `process-exit ${code}: ${this.stderrTail}` })
      }
      this.fireExit(code)
    })
  }

  /** Writes one stream-json user turn to stdin: JSON + '\n'. */
  send(userMessage: object): void {
    if (this.child === null) throw new Error('Transport.send() called before start()')
    this.child.stdin.write(JSON.stringify(userMessage) + '\n')
  }

  /** Answers something the process asked. */
  respond(requestId: string, response: unknown, error?: string): void {
    if (this.child === null || this.exited) return
    const body = error !== undefined
      ? { subtype: 'error', request_id: requestId, error }
      : { subtype: 'success', request_id: requestId, response }
    this.child.stdin.write(JSON.stringify({ type: 'control_response', response: body }) + '\n')
  }

  /** Asks the process something without starting a turn. Rejects if it refuses,
   *  doesn't answer in time, or exits first. */
  request(subtype: string, extra: object = {}, timeoutMs = 10_000): Promise<unknown> {
    const child = this.child
    if (child === null || this.exited) return Promise.reject(new Error('This chat has no process running.'))
    const id = `delegatto-${++this.nextRequestId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('Claude Code took too long to answer.'))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRequests.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) }
      })
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...extra } }) + '\n')
    })
  }

  /** OS pid of the spawned `claude`, or null before start / after exit. Used by
   *  the engine pool HUD to identify and kill a specific process. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** Stops the running turn, as Esc does in a terminal: the process stays up, with the
   *  conversation intact. Killing it instead (all SIGINT does on Windows) makes the next
   *  message resume an interrupted transcript, which Claude Code patches over with a
   *  made-up "No response requested." reply. A process too stuck to answer is killed. */
  interrupt(): void {
    if (this.child === null) throw new Error('Transport.interrupt() called before start()')
    if (this.exited || this.interruptTimer !== null) return
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null
      if (!this.exited) try { this.child?.kill() } catch { /* already gone */ }
    }, INTERRUPT_GRACE_MS)
    this.interruptTimer.unref?.()
    this.request('interrupt').catch(() => { /* the timer above covers no answer */ })
  }

  /** GRACEFUL shutdown of a pooled process (reap / app-quit) -- distinct from
   *  interrupt(). Closes the child's stdin so the headless `claude -p` reaches
   *  end-of-input, finishes, and removes its OWN `~/.claude/sessions/<pid>.json`
   *  registration on the way out. A hard kill (what interrupt/SIGINT becomes on
   *  Windows, where it maps to TerminateProcess) skips that cleanup and orphans
   *  the lock, which then blocks a later `claude --continue` in that directory.
   *  Force-kills only as a fallback if the process hasn't exited within
   *  `graceMs`. Safe to call before start() or after exit -- a no-op then. */
  close(graceMs = 4000): void {
    if (this.child === null || this.exited) return
    try { this.child.stdin.end() } catch { /* stdin may already be closed */ }
    if (this.forceKillTimer === null) {
      this.forceKillTimer = setTimeout(() => {
        if (!this.exited && this.child !== null) {
          try { this.child.kill() } catch { /* already gone */ }
        }
      }, graceMs)
      this.forceKillTimer.unref?.()
    }
  }

  on(cb: (e: LiveEvent) => void): void {
    this.eventListeners.push(cb)
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitListeners.push(cb)
  }

  private onStdoutChunk(chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    this.pendingStdout = Buffer.concat([this.pendingStdout, buf])

    let index: number
    // Byte-safe framing: split on \n, hold back any trailing partial line
    // (a JSON line can arrive split across chunks) -- same discipline as
    // src/main/jsonl/stream.ts's readLines.
    while ((index = this.pendingStdout.indexOf(NEWLINE)) !== -1) {
      const lineBuf = this.pendingStdout.subarray(0, index)
      this.pendingStdout = this.pendingStdout.subarray(index + 1)
      const line = lineBuf.toString('utf8')
      const asked = parseControlRequest(line)
      if (asked !== null) {
        if (asked.subtype === 'elicitation') this.emitEvent({ kind: 'elicitation', request: elicitationFrom(asked) })
        else if (asked.subtype === 'can_use_tool') this.emitEvent({ kind: 'permissionAsked', requestId: asked.requestId, args: asked.request })
        // Nothing else is ever asked of this app. Silence would leave Claude Code waiting.
        else this.respond(asked.requestId, null, `Delegatto can't answer ${asked.subtype || 'that request'}.`)
        continue
      }
      const control = parseControlResponse(line)
      if (control !== null) {
        const waiter = this.pendingRequests.get(control.requestId)
        this.pendingRequests.delete(control.requestId)
        if (control.ok) waiter?.resolve(control.response)
        else waiter?.reject(new Error(control.error))
        continue
      }
      const event = parseEvent(line)
      if (event === null) continue
      if (event.kind === 'result' && this.interruptTimer !== null) {
        // Claude Code reports a stopped turn as an error; here it's what was asked for.
        clearTimeout(this.interruptTimer)
        this.interruptTimer = null
        this.emitEvent({ ...event, isError: false, text: '', interrupted: true })
      } else {
        this.emitEvent(event)
      }
    }
    // Any bytes left in this.pendingStdout are an incomplete final line --
    // held until its newline arrives. If the process exits mid-line, those
    // bytes are simply never parsed (matches the read-path's guarantee that
    // an unterminated line is not a row).
  }

  private onStderrChunk(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES)
  }

  private emitEvent(e: LiveEvent): void {
    for (const cb of this.eventListeners) cb(e)
  }

  private fireExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    for (const waiter of this.pendingRequests.values()) waiter.reject(new Error('The chat\'s process has stopped.'))
    this.pendingRequests.clear()
    if (this.forceKillTimer !== null) { clearTimeout(this.forceKillTimer); this.forceKillTimer = null }
    if (this.interruptTimer !== null) { clearTimeout(this.interruptTimer); this.interruptTimer = null }
    for (const cb of this.exitListeners) cb(code)
  }
}
