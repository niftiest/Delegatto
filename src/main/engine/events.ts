import { stepLabel, textStep } from '../../shared/subagent-activity'
import type { PlanReading, PlanWindow } from '../../shared/plan-usage'
import type { Usage } from '../../shared/types'
import type { BackgroundTask, Elicitation, LiveEvent } from '../../shared/engine-types'
import { blocksFromContent } from '../jsonl/parse'
import { parseMcpServers } from './mcp-status'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Usage's fields are all optional numbers; keep only the ones that are
 *  actually numbers rather than trusting the object shape wholesale. */
function extractUsage(raw: unknown): Usage | undefined {
  if (!isPlainObject(raw)) return undefined
  const usage: Usage = {}
  if (typeof raw.input_tokens === 'number') usage.input_tokens = raw.input_tokens
  if (typeof raw.output_tokens === 'number') usage.output_tokens = raw.output_tokens
  if (typeof raw.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = raw.cache_read_input_tokens
  if (typeof raw.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = raw.cache_creation_input_tokens
  return usage
}

/** Claude Code sends its whole list each time it changes. Start times are the pool's to add. */
function parseBackgroundTasks(raw: unknown): BackgroundTask[] {
  if (!Array.isArray(raw)) return []
  const tasks: BackgroundTask[] = []
  for (const t of raw) {
    if (!isPlainObject(t) || typeof t.task_id !== 'string') continue
    tasks.push({
      id: t.task_id,
      type: typeof t.task_type === 'string' ? t.task_type : 'task',
      description: typeof t.description === 'string' ? t.description : '',
      agent: typeof t.subagent_type === 'string' ? t.subagent_type : null,
      startedAt: 0,
      lastTool: null,
      tokens: null
    })
  }
  return tasks
}

function parseSystem(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'system' }
  if (row.subtype === 'status') return { kind: 'status', status: typeof row.status === 'string' ? row.status : null, ...(typeof row.permissionMode === 'string' ? { permissionMode: row.permissionMode } : {}) }
  if (row.subtype === 'background_tasks_changed') return { kind: 'background', tasks: parseBackgroundTasks(row.tasks) }
  if (row.subtype === 'task_started' && row.task_type === 'local_agent' && typeof row.tool_use_id === 'string') {
    return { kind: 'taskStarted', toolUseId: row.tool_use_id, description: typeof row.description === 'string' ? row.description : '' }
  }
  if (row.subtype === 'task_notification' && typeof row.tool_use_id === 'string') return { kind: 'taskEnded', toolUseId: row.tool_use_id }
  if (row.subtype === 'task_progress' && typeof row.task_id === 'string') {
    const tokens = isPlainObject(row.usage) && typeof row.usage.total_tokens === 'number' ? row.usage.total_tokens : null
    return { kind: 'taskProgress', taskId: row.task_id, lastTool: typeof row.last_tool_name === 'string' ? row.last_tool_name : null, tokens }
  }
  if (row.subtype === 'api_retry') {
    return {
      kind: 'retry',
      attempt: typeof row.attempt === 'number' ? row.attempt : 0,
      maxRetries: typeof row.max_retries === 'number' ? row.max_retries : 0,
      delayMs: typeof row.retry_delay_ms === 'number' ? row.retry_delay_ms : 0,
      error: typeof row.error === 'string' ? row.error : null
    }
  }
  if (row.subtype === 'hook_started' || row.subtype === 'hook_response') {
    const output = [row.stderr, row.stdout, row.output].find((t): t is string => typeof t === 'string' && t.trim().length > 0) ?? ''
    return {
      kind: 'hook',
      phase: row.subtype === 'hook_started' ? 'started' : 'finished',
      name: typeof row.hook_name === 'string' ? row.hook_name : 'hook',
      hookEvent: typeof row.hook_event === 'string' ? row.hook_event : '',
      outcome: typeof row.outcome === 'string' ? row.outcome : null,
      output: output.trim(),
      ...(typeof row.exit_code === 'number' ? { exitCode: row.exit_code } : {})
    }
  }
  if (row.subtype === 'informational' && typeof row.content === 'string') {
    const o = row.prompt_submit_outcome
    return {
      kind: 'informational',
      text: row.content,
      level: typeof row.level === 'string' ? row.level : 'info',
      ...(isPlainObject(o) ? { ending: { kind: typeof o.kind === 'string' ? o.kind : null, kept: o.prompt_kept === true, reason: typeof o.reason === 'string' ? o.reason : null } } : {})
    }
  }
  if (row.subtype === 'session_writes_lost') {
    return {
      kind: 'writesLost',
      errorCode: typeof row.error_code === 'string' ? row.error_code : '',
      lost: Array.isArray(row.lost) ? row.lost.filter((l): l is string => typeof l === 'string') : []
    }
  }
  if (row.subtype !== 'init') return other
  const sessionId = row.session_id
  const cwd = row.cwd
  const model = row.model
  const permissionMode = row.permissionMode
  if (typeof sessionId !== 'string' || sessionId.length === 0) return other
  if (typeof cwd !== 'string') return other
  if (typeof model !== 'string') return other
  if (typeof permissionMode !== 'string') return other
  const init: LiveEvent = { kind: 'init', sessionId, cwd, model, permissionMode }
  const mcpServers = parseMcpServers(row.mcp_servers)
  return mcpServers.length > 0 ? { ...init, mcpServers } : init
}

function parseAssistant(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'assistant' }
  const uuid = row.uuid
  if (typeof uuid !== 'string' || uuid.length === 0) return other
  const message = row.message
  if (!isPlainObject(message)) return other

  const blocks = blocksFromContent(message.content)
  const usage = extractUsage(message.usage)
  return usage === undefined ? { kind: 'assistant', uuid, blocks } : { kind: 'assistant', uuid, blocks, usage }
}

/** A subagent's message, as one line for showing what it's doing. */
function parseSubagentStep(row: Record<string, unknown>, parent: string): LiveEvent | null {
  const message = row.message
  const content = isPlainObject(message) ? message.content : null
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!isPlainObject(block)) continue
    if (block.type === 'tool_use' && typeof block.name === 'string') return { kind: 'subagentStep', parent, label: stepLabel(block.name, block.input) }
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) return { kind: 'subagentStep', parent, label: textStep(block.text) }
  }
  return null
}

function parseStreamEvent(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'stream_event' }
  const inner = row.event
  if (!isPlainObject(inner)) return other
  if (inner.type === 'message_delta' && isPlainObject(inner.usage) && typeof inner.usage.output_tokens === 'number') {
    return { kind: 'usage', outputTokens: inner.usage.output_tokens }
  }
  if (inner.type !== 'content_block_delta') return other
  const delta = inner.delta
  if (!isPlainObject(delta)) return other
  if (delta.type === 'thinking_delta') return typeof delta.thinking === 'string' && delta.thinking.length > 0 ? { kind: 'thinkingDelta', text: delta.thinking } : other
  if (delta.type !== 'text_delta') return other
  const text = delta.text
  if (typeof text !== 'string') return other
  return { kind: 'delta', text }
}

function parseRateLimit(row: Record<string, unknown>): LiveEvent {
  const other: LiveEvent = { kind: 'other', type: 'rate_limit_event' }
  const info = row.rate_limit_info
  if (!isPlainObject(info)) return other
  const status = info.status
  if (typeof status !== 'string') return other
  const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null
  const reading = planReading(info)
  return reading === null ? { kind: 'rate_limit', status, resetsAt } : { kind: 'rate_limit', status, resetsAt, reading }
}

/** A window in `rate_limit_info`'s form: a 0-1 fraction, reset time in epoch seconds. */
function fractionWindow(utilization: unknown, resetsAt: unknown): PlanWindow | undefined {
  if (typeof utilization !== 'number') return undefined
  return { percent: Math.round(utilization * 100), resetsAt: typeof resetsAt === 'number' ? resetsAt * 1000 : null }
}

/** `unifiedWindows` carries both windows. It's marked internal, so if it ever goes,
 *  the plain fields still report whichever window this event is about. */
function planReading(info: Record<string, unknown>): PlanReading | null {
  const reading: PlanReading = {}
  const windows = info.unifiedWindows
  if (isPlainObject(windows)) {
    const five = windows.five_hour
    const seven = windows.seven_day
    if (isPlainObject(five)) { const w = fractionWindow(five.utilization, five.resetsAt); if (w !== undefined) reading.fiveHour = w }
    if (isPlainObject(seven)) { const w = fractionWindow(seven.utilization, seven.resetsAt); if (w !== undefined) reading.sevenDay = w }
  } else {
    const w = fractionWindow(info.utilization, info.resetsAt)
    if (w !== undefined && info.rateLimitType === 'five_hour') reading.fiveHour = w
    if (w !== undefined && info.rateLimitType === 'seven_day') reading.sevenDay = w
  }
  if (typeof info.isUsingOverage === 'boolean') reading.usingExtra = info.isUsingOverage
  return Object.keys(reading).length === 0 ? null : reading
}

const FAILURES: Record<string, string> = {
  error_max_turns: 'Claude stopped: it reached the limit on turns.',
  error_max_budget_usd: 'Claude stopped: it reached the budget limit for this chat.',
  error_max_structured_output_retries: 'Claude stopped: it could not produce the required output format.'
}

/** Why a turn failed: failed turns carry `errors` instead of `result`. Claude Code's
 *  `[ede_diagnostic]` entries are for its own developers. */
function failureText(row: Record<string, unknown>): string {
  const errors = Array.isArray(row.errors) ? row.errors.filter((e): e is string => typeof e === 'string' && !e.startsWith('[ede_diagnostic]')) : []
  if (errors.length > 0) return errors.join('\n')
  const known = typeof row.subtype === 'string' ? FAILURES[row.subtype] : undefined
  if (known !== undefined) return known
  const reason = typeof row.terminal_reason === 'string' ? ` (${row.terminal_reason.replace(/_/g, ' ')})` : ''
  return `Claude stopped because of an error${reason}.`
}

function parseResult(row: Record<string, unknown>): LiveEvent {
  const isError = row.is_error === true
  const costUsd = typeof row.total_cost_usd === 'number' ? row.total_cost_usd : 0
  const text = typeof row.result === 'string' ? row.result : ''
  return { kind: 'result', isError, costUsd, text: text.length === 0 && isError ? failureText(row) : text }
}

export type ControlResponse =
  | { requestId: string; ok: true; response: unknown }
  | { requestId: string; ok: false; error: string }

/** The answer to a control request we sent, or null for any other line. */
export function parseControlResponse(line: string): ControlResponse | null {
  if (!line.includes('control_response')) return null
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!isPlainObject(value) || value.type !== 'control_response' || !isPlainObject(value.response)) return null
  const r = value.response
  if (typeof r.request_id !== 'string') return null
  if (r.subtype === 'success') return { requestId: r.request_id, ok: true, response: r.response }
  return { requestId: r.request_id, ok: false, error: typeof r.error === 'string' ? r.error : 'Claude Code refused the request.' }
}

export type ControlRequest = { requestId: string; subtype: string; request: Record<string, unknown> }

/** Something Claude Code is asking this app, or null for any other line. */
export function parseControlRequest(line: string): ControlRequest | null {
  if (!line.includes('"control_request"')) return null
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!isPlainObject(value) || value.type !== 'control_request' || typeof value.request_id !== 'string' || !isPlainObject(value.request)) return null
  return { requestId: value.request_id, subtype: typeof value.request.subtype === 'string' ? value.request.subtype : '', request: value.request }
}

/** The form or page an elicitation request is asking the user about. */
export function elicitationFrom(c: ControlRequest): Elicitation {
  const r = c.request
  return {
    requestId: c.requestId,
    server: typeof r.display_name === 'string' ? r.display_name : typeof r.mcp_server_name === 'string' ? r.mcp_server_name : 'An MCP server',
    message: typeof r.message === 'string' ? r.message : '',
    title: typeof r.title === 'string' ? r.title : null,
    mode: r.mode === 'url' ? 'url' : 'form',
    url: typeof r.url === 'string' && /^https?:\/\//i.test(r.url) ? r.url : null,
    schema: r.requested_schema,
    propertyOrder: r.property_order
  }
}

/** Tolerant, never-throwing parse of one stream-json stdout line into a
 *  typed LiveEvent. Mirrors jsonl/parse.ts's parseLine: blank, non-JSON,
 *  non-object, or type-less lines all yield null. Every field narrowed off
 *  the parsed JSON is validated before being trusted. */
export function parseEvent(line: string): LiveEvent | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isPlainObject(value)) return null
  const type = value.type
  if (typeof type !== 'string') return null

  // A subagent's own messages and tokens share this stream. It reports through its
  // task; showing them as Claude's would put its words in the chat's reply.
  if ((type === 'assistant' || type === 'stream_event') && typeof value.parent_tool_use_id === 'string') {
    return (type === 'assistant' ? parseSubagentStep(value, value.parent_tool_use_id) : null) ?? { kind: 'other', type }
  }

  switch (type) {
    case 'system':
      return parseSystem(value)
    case 'assistant':
      return parseAssistant(value)
    case 'stream_event':
      return parseStreamEvent(value)
    case 'rate_limit_event':
      return parseRateLimit(value)
    case 'result':
      return parseResult(value)
    case 'control_cancel_request':
      return typeof value.request_id === 'string' ? { kind: 'permissionCancelled', requestId: value.request_id } : { kind: 'other', type }
    case 'command_lifecycle':
      return typeof value.command_uuid === 'string' && typeof value.state === 'string'
        ? { kind: 'commandLifecycle', uuid: value.command_uuid, state: value.state }
        : { kind: 'other', type }
    case 'prompt_suggestion':
      return typeof value.suggestion === 'string' && value.suggestion.trim().length > 0
        ? { kind: 'suggestion', text: value.suggestion.trim() }
        : { kind: 'other', type }
    default:
      return { kind: 'other', type }
  }
}
