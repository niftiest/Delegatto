import type { PermissionDecision, PermissionRequest, PermissionSuggestion } from '../../shared/engine-types'

/** Engine core: parks a tool-permission request Claude Code sent over stdio until the user
 *  answers it. Node-only -- must never import electron; enforced by
 *  tests/architecture.test.ts the same as the rest of src/main/engine. engine-ipc.ts is the
 *  electron boundary that wires PermissionBridge.onRequest/resolve to the renderer. */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// (A) Pure functions -- the documented response contract + tolerant request
//     parsing (the request shape was captured from a live CLI run).
// ---------------------------------------------------------------------------

export type PermissionResultPayload = { behavior: string; updatedInput?: unknown; updatedPermissions?: PermissionSuggestion[]; message?: string }

/** Builds the exact MCP-result JSON the CLI expects, given a decision + the
 *  original (pre-edit) tool input. DOCUMENTED contract, pinned exactly by
 *  tests -- do not "simplify" this away:
 *   - allow: ALWAYS includes `updatedInput`, defaulted to the original input
 *     when the decision didn't supply an edited one (some CLI versions
 *     reject an allow without `updatedInput` at all).
 *   - deny: `behavior` + `message` only -- no `updatedInput` field. */
export function buildPermissionResult(decision: PermissionDecision, originalInput: unknown): PermissionResultPayload {
  if (decision.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: decision.updatedInput ?? originalInput,
      ...(decision.updatedPermissions !== undefined && decision.updatedPermissions.length > 0 ? { updatedPermissions: decision.updatedPermissions } : {})
    }
  }
  return { behavior: 'deny', message: decision.message }
}

/** Tolerant parse of the CLI's `tools/call` arguments into a PermissionRequest.
 *  `tool_name`/`input` are solid per the SDK's `canUseTool(tool_name,
 *  input_data, context)` mirror; `tool_use_id` is likely-but-unconfirmed, so
 *  it stays optional and is omitted (not set to `undefined`) when absent.
 *  Never throws: junk/non-object args, a missing `tool_name`, or unexpected
 *  extra fields all degrade to a defensible request rather than a crash --
 *  the CLI is waiting on a reply either way, and a hard failure here would
 *  hang the whole turn. Unknown fields are intentionally NOT enumerated/
 *  logged from inside this pure function (that would make it impure and
 *  untestable-by-equality); the MCP server layer that calls this with the
 *  raw `arguments` is the right place to log the raw payload once, for the
 *  live-run confirmation Task 10 needs against the real, undocumented shape. */
export function parsePermissionArgs(args: unknown, id: string, sessionKey: string): PermissionRequest {
  const obj = isPlainObject(args) ? args : {}

  const toolName = typeof obj.tool_name === 'string' && obj.tool_name.length > 0 ? obj.tool_name : 'unknown'
  const input = 'input' in obj ? obj.input : undefined
  const toolUseId = typeof obj.tool_use_id === 'string' && obj.tool_use_id.length > 0 ? obj.tool_use_id : undefined

  const text = (key: string): Record<string, string> => (typeof obj[key] === 'string' && (obj[key] as string).length > 0 ? { [key]: obj[key] as string } : {})
  const base: PermissionRequest = { id, tool: toolName, input, sessionKey }
  return {
    ...base,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...text('title'),
    ...text('description'),
    ...(typeof obj.decision_reason === 'string' && obj.decision_reason.length > 0 ? { reason: obj.decision_reason } : {}),
    ...(typeof obj.decision_reason_type === 'string' && obj.decision_reason_type.length > 0 ? { reasonType: obj.decision_reason_type } : {}),
    ...(typeof obj.blocked_path === 'string' && obj.blocked_path.length > 0 ? { blockedPath: obj.blocked_path } : {}),
    ...(Array.isArray(obj.permission_suggestions) ? { suggestions: obj.permission_suggestions.filter(isPlainObject) as PermissionSuggestion[] } : {})
  }
}

function firstStringField(input: unknown, keys: string[]): string | null {
  if (!isPlainObject(input)) return null
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** Bash rule heuristic: keep the command's stable prefix, wildcard the final
 *  (usually variable) token -- `"npx playwright test"` -> `"npx playwright *"`,
 *  `"npm run build"` -> `"npm run *"`. A single-token command still gets a
 *  wildcard suffix (`"ls"` -> `"ls *"`) rather than a bare-word rule, since a
 *  bare `ls` with no arguments is a degenerate case of the same pattern, not a
 *  different one. No `command` string at all -> the bare tool name, same as
 *  every other tool with nothing to scope on. */
function bashRule(input: unknown): string {
  const command = firstStringField(input, ['command'])
  if (command === null) return 'Bash'
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return 'Bash'
  if (tokens.length === 1) return `Bash(${tokens[0]} *)`
  return `Bash(${tokens.slice(0, -1).join(' ')} *)`
}

/** Derives an "allow always" rule string from a request, for the app to
 *  persist and pass on the NEXT spawn via `--allowedTools` (no documented
 *  over-the-wire field persists this from an external prompt tool -- see the
 *  contract file's "Allow-always / rules" section). This function only
 *  derives the string; actually persisting/wiring it into a future spawn is
 *  the app's job (outside this task). `Bash` gets the command-prefix
 *  heuristic above; `Read`/`Edit`/`Write` get a path-scoped rule when the
 *  input carries a path (`file_path`, matching the CLI's own tool input
 *  field, or `path` as a fallback); anything else -- including Read/Edit/
 *  Write with no discoverable path -- falls back to the bare tool name. */
export function allowAlwaysRule(tool: string, input: unknown): string {
  if (tool === 'Bash') return bashRule(input)

  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    const path = firstStringField(input, ['file_path', 'path'])
    if (path !== null) return `${tool}(${path})`
  }

  return tool
}

// ---------------------------------------------------------------------------
// (B) PermissionBridge -- the parking coordinator. Zero JSON-RPC knowledge.
// ---------------------------------------------------------------------------

/** How long a parked request waits for `resolve()` before this bridge gives
 *  up and denies it on the CLI's behalf. The SDK's own equivalent
 *  (`canUseTool`) can apparently stay pending indefinitely (per the contract
 *  file's gotchas -- undocumented), but that would let one forgotten UI
 *  prompt hang an entire turn (and the process behind it) forever. Denying
 *  after a generous wait is the safer default for an interactive app: the CLI
 *  gets an answer and can report it to the user instead of hanging silently.
 *  Generous on purpose (a human may be away from the keyboard) -- tests
 *  override this via the constructor to exercise the timeout path quickly. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

type PendingEntry = {
  resolvePromise: (result: PermissionResultPayload) => void
  originalInput: unknown
  timeoutHandle: NodeJS.Timeout | null
  settled: boolean
}

/** Parks each `tools/call` invocation as a promise keyed by a fresh id,
 *  fans the parsed request out to `onRequest` subscribers, and completes the
 *  parked promise -- with the exact MCP tool-result shape -- once `resolve()`
 *  is called (by the app, once the renderer answers) or the per-request
 *  timeout fires. Has no idea it's being driven over JSON-RPC/stdio; that
 *  wiring lives in `routeMcpRequest`/`McpStdioServer` below. */
export class PermissionBridge {
  readonly toolName: string
  private readonly timeoutMs: number

  private nextId = 0
  private readonly pending = new Map<string, PendingEntry>()
  private readonly requestListeners: Array<(req: PermissionRequest) => void> = []

  /** Set by shutdown(). Terminal, like SessionPool's `stopped`: once a bridge
   *  has been shut down, any further handleToolCall() is denied immediately
   *  instead of parking a promise that has no server left to answer it. */
  private shuttingDown = false

  constructor(opts?: { toolName?: string; timeoutMs?: number }) {
    this.toolName = opts?.toolName ?? 'approve'
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Registers a subscriber notified of every parked request (the app's IPC
   *  layer forwards these to the renderer as `engine:permission` events). */
  onRequest(cb: (req: PermissionRequest) => void): void {
    this.requestListeners.push(cb)
  }

  /** Parses a request, parks it under a fresh id, tells listeners, and resolves to the answer
   *  once `resolve()` is called for that id (or the timeout, if any, denies it first). */
  handleRequest(args: unknown, sessionKey: string): { id: string; answer: Promise<PermissionResultPayload> } {
    this.nextId += 1
    const id = `perm-${this.nextId}`
    const req = parsePermissionArgs(args, id, sessionKey)

    const answer = new Promise<PermissionResultPayload>((resolvePromise) => {
      const entry: PendingEntry = {
        resolvePromise,
        originalInput: req.input,
        timeoutHandle: null,
        settled: false
      }

      if (this.shuttingDown) {
        this.settle(entry, { behavior: 'deny', message: 'permission bridge is shutting down' })
        return
      }

      this.pending.set(id, entry)

      if (this.timeoutMs > 0) {
        const handle = setTimeout(() => this.expireTimeout(id), this.timeoutMs)
        // Never let this timer alone keep the process alive.
        handle.unref?.()
        entry.timeoutHandle = handle
      }

      for (const cb of this.requestListeners) cb(req)
    })
    return { id, answer }
  }

  /** Claude Code stopped waiting, so nobody needs an answer any more. */
  cancel(id: string): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    this.pending.delete(id)
    if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
    this.settle(entry, { behavior: 'deny', message: 'The request was cancelled.' })
    return true
  }

  /** Completes the parked promise for `id` with the given decision, wrapped
   *  in the exact MCP result shape. An unknown id -- never parked, already
   *  resolved, already timed out, or already denied by shutdown() -- is a
   *  safe no-op: this covers both "resolve after the process died" (nothing
   *  is listening to the settled promise anymore, which is harmless) and "two
   *  resolves for one id" (the first resolve already removed the entry). */
  resolve(id: string, decision: PermissionDecision): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
    this.settle(entry, buildPermissionResult(decision, entry.originalInput))
  }

  /** Denies every currently-parked request -- the app calls this when the MCP
   *  server (or the whole engine) is shutting down with requests still
   *  awaiting a UI answer, so the CLI gets a clean deny instead of the pipe
   *  just dying mid-wait. Also flips the bridge into a terminal
   *  deny-immediately state (see `shuttingDown` above) so a `handleToolCall`
   *  racing with this shutdown doesn't park a promise nothing will ever
   *  settle. Idempotent: a second call finds nothing parked. */
  shutdown(message = 'permission bridge shut down'): void {
    this.shuttingDown = true
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timeoutHandle !== null) clearTimeout(entry.timeoutHandle)
      this.settle(entry, { behavior: 'deny', message })
    }
  }

  private expireTimeout(id: string): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    this.settle(entry, { behavior: 'deny', message: 'permission request timed out waiting for a decision' })
  }

  private settle(entry: PendingEntry, payload: PermissionResultPayload): void {
    if (entry.settled) return
    entry.settled = true
    entry.resolvePromise(payload)
  }
}
