import { describe, it, expect } from 'vitest'
import { parseEvent } from '../src/main/engine/events'

// Fixture lines are verbatim shapes recorded from `claude -p --output-format
// stream-json` (claude 2.1.220).

const INIT =
  '{"type":"system","subtype":"init","cwd":"C:\\\\Users\\\\user\\\\.claude\\\\jobs\\\\f7ef5120\\\\tmp","session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41","tools":["Task","Bash"],"mcp_servers":[],"model":"claude-opus-5[1m]","permissionMode":"bypassPermissions","slash_commands":["build"],"agents":["claude"],"skills":["build"]}'

const ASSISTANT =
  '{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":null,"usage":{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":20327,"cache_creation_input_tokens":15801}},"parent_tool_use_id":null,"session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41","uuid":"c70926a9-f8fc-45e7-9597-9aee05341cd0","timestamp":"2026-07-25T04:50:52.892Z"}'

const DELTA_TEXT_O =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"o"}},"session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41"}'

const DELTA_TEXT_K =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"k"}},"session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41"}'

const RATE_LIMIT =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784971200,"rateLimitType":"five_hour"},"session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41"}'

const RESULT =
  '{"is_error":false,"duration_api_ms":1334,"num_turns":1,"stop_reason":"end_turn","session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41","total_cost_usd":0.16828349999999997,"usage":{"input_tokens":2,"output_tokens":4},"result":"ok","type":"result","subtype":"success","duration_ms":1390,"uuid":"ce1033d1-7bd9-4186-ad42-34e7731c976f"}'

const HOOK =
  '{"type":"system","subtype":"hook_started","hook_id":"b8632878","hook_name":"SessionStart:startup","session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41"}'

describe('parseEvent — malformed input never throws', () => {
  it('returns null for blank lines', () => {
    expect(parseEvent('')).toBeNull()
    expect(parseEvent('   ')).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(parseEvent('not json at all')).toBeNull()
  })

  it('returns null for truncated JSON', () => {
    expect(parseEvent('{"type":"assistant","message":{"content":')).toBeNull()
  })

  it('returns null for bare JSON values (number, string, null, array)', () => {
    expect(parseEvent('42')).toBeNull()
    expect(parseEvent('"oops"')).toBeNull()
    expect(parseEvent('null')).toBeNull()
    expect(parseEvent('[]')).toBeNull()
  })

  it('returns null for an object with no type field', () => {
    expect(parseEvent('{"foo":1}')).toBeNull()
  })
})

describe('parseEvent — init', () => {
  it('parses a system/init line into kind:init with all fields', () => {
    const event = parseEvent(INIT)
    expect(event).toEqual({
      kind: 'init',
      sessionId: '7600a514-8300-4cef-b1c8-8b0cd8123e41',
      cwd: 'C:\\Users\\user\\.claude\\jobs\\f7ef5120\\tmp',
      model: 'claude-opus-5[1m]',
      permissionMode: 'bypassPermissions'
    })
  })

  it('falls back to kind:other when session_id is missing', () => {
    const line = '{"type":"system","subtype":"init","cwd":"/tmp","model":"opus","permissionMode":"default"}'
    expect(parseEvent(line)).toEqual({ kind: 'other', type: 'system' })
  })

  it('falls back to kind:other when session_id is non-string', () => {
    const line = '{"type":"system","subtype":"init","cwd":"/tmp","session_id":42,"model":"opus","permissionMode":"default"}'
    expect(parseEvent(line)).toEqual({ kind: 'other', type: 'system' })
  })

  it('falls back to kind:other when cwd/model/permissionMode are missing or non-string', () => {
    const missingCwd = '{"type":"system","subtype":"init","session_id":"s1","model":"opus","permissionMode":"default"}'
    expect(parseEvent(missingCwd)).toEqual({ kind: 'other', type: 'system' })

    const nonStringModel = '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":7,"permissionMode":"default"}'
    expect(parseEvent(nonStringModel)).toEqual({ kind: 'other', type: 'system' })

    const missingPermissionMode = '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp","model":"opus"}'
    expect(parseEvent(missingPermissionMode)).toEqual({ kind: 'other', type: 'system' })
  })

  it('maps a hook system event to kind:hook', () => {
    expect(parseEvent(HOOK)).toMatchObject({ kind: 'hook' })
  })
})

describe('parseEvent — assistant', () => {
  it('parses an assistant line into kind:assistant with blocks and usage', () => {
    const event = parseEvent(ASSISTANT)
    expect(event).toEqual({
      kind: 'assistant',
      uuid: 'c70926a9-f8fc-45e7-9597-9aee05341cd0',
      blocks: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 2,
        output_tokens: 4,
        cache_read_input_tokens: 20327,
        cache_creation_input_tokens: 15801
      }
    })
  })

  it('normalizes bare-string content into a single text block (mirrors blocksOf)', () => {
    const line =
      '{"type":"assistant","message":{"role":"assistant","content":"hi there"},"uuid":"u1"}'
    const event = parseEvent(line)
    expect(event).toEqual({ kind: 'assistant', uuid: 'u1', blocks: [{ type: 'text', text: 'hi there' }] })
  })

  it('drops malformed blocks but keeps well-formed ones', () => {
    const line =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"},"garbage",42,null,{"notype":true}]},"uuid":"u1"}'
    const event = parseEvent(line)
    expect(event).toEqual({ kind: 'assistant', uuid: 'u1', blocks: [{ type: 'text', text: 'ok' }] })
  })

  it('drops a non-number usage field but keeps the well-formed ones', () => {
    const line =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":2,"output_tokens":"lots"}},"uuid":"u1"}'
    const event = parseEvent(line) as { kind: 'assistant'; usage?: object }
    expect(event.usage).toEqual({ input_tokens: 2 })
  })

  it('omits usage when absent', () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"uuid":"u1"}'
    const event = parseEvent(line) as { kind: 'assistant'; usage?: unknown }
    expect(event.kind).toBe('assistant')
    expect(event.usage).toBeUndefined()
  })

  it('falls back to kind:other when uuid is missing or non-string', () => {
    const missing = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}'
    expect(parseEvent(missing)).toEqual({ kind: 'other', type: 'assistant' })

    const nonString = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"uuid":7}'
    expect(parseEvent(nonString)).toEqual({ kind: 'other', type: 'assistant' })
  })

  it('falls back to kind:other when message is missing or malformed', () => {
    const missingMessage = '{"type":"assistant","uuid":"u1"}'
    expect(parseEvent(missingMessage)).toEqual({ kind: 'other', type: 'assistant' })

    const arrayMessage = '{"type":"assistant","message":[1,2,3],"uuid":"u1"}'
    expect(parseEvent(arrayMessage)).toEqual({ kind: 'other', type: 'assistant' })
  })
})

describe('parseEvent — stream_event deltas', () => {
  it('parses a content_block_delta text_delta into kind:delta', () => {
    expect(parseEvent(DELTA_TEXT_O)).toEqual({ kind: 'delta', text: 'o' })
    expect(parseEvent(DELTA_TEXT_K)).toEqual({ kind: 'delta', text: 'k' })
  })

  it('does not emit a text delta for a non-text_delta inner delta (input_json_delta)', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1"}},"session_id":"s1"}'
    expect(parseEvent(line)).toEqual({ kind: 'other', type: 'stream_event' })
  })

  it('reads a thinking_delta as thinking, not as reply text', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}},"session_id":"s1"}'
    expect(parseEvent(line)).toEqual({ kind: 'thinkingDelta', text: 'hmm' })
  })

  it('falls back to kind:other for a stream_event with no event field', () => {
    expect(parseEvent('{"type":"stream_event","session_id":"s1"}')).toEqual({ kind: 'other', type: 'stream_event' })
  })

  it('falls back to kind:other for a stream_event whose inner event has no delta (e.g. message_start)', () => {
    const line = '{"type":"stream_event","event":{"type":"message_start"},"session_id":"s1"}'
    expect(parseEvent(line)).toEqual({ kind: 'other', type: 'stream_event' })
  })

  it('falls back to kind:other for a stream_event whose inner event type is not content_block_delta', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"s1"}'
    expect(parseEvent(line)).toEqual({ kind: 'other', type: 'stream_event' })
  })

  it('falls back to kind:other when delta.text is missing or non-string', () => {
    const missingText = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta"}},"session_id":"s1"}'
    expect(parseEvent(missingText)).toEqual({ kind: 'other', type: 'stream_event' })

    const nonStringText = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":7}},"session_id":"s1"}'
    expect(parseEvent(nonStringText)).toEqual({ kind: 'other', type: 'stream_event' })
  })
})

describe('parseEvent — rate_limit_event', () => {
  it('parses a rate_limit_event into kind:rate_limit', () => {
    expect(parseEvent(RATE_LIMIT)).toEqual({ kind: 'rate_limit', status: 'allowed', resetsAt: 1784971200 })
  })

  it('resetsAt is null when absent or non-number', () => {
    const absent = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s1"}'
    expect(parseEvent(absent)).toEqual({ kind: 'rate_limit', status: 'allowed', resetsAt: null })

    const nonNumber = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":"soon"},"session_id":"s1"}'
    expect(parseEvent(nonNumber)).toEqual({ kind: 'rate_limit', status: 'allowed', resetsAt: null })
  })

  it('falls back to kind:other when rate_limit_info or status is missing/non-string', () => {
    const missingInfo = '{"type":"rate_limit_event","session_id":"s1"}'
    expect(parseEvent(missingInfo)).toEqual({ kind: 'other', type: 'rate_limit_event' })

    const nonStringStatus = '{"type":"rate_limit_event","rate_limit_info":{"status":7},"session_id":"s1"}'
    expect(parseEvent(nonStringStatus)).toEqual({ kind: 'other', type: 'rate_limit_event' })
  })
})

describe('parseEvent — result', () => {
  it('parses a result line into kind:result with cost/isError/text', () => {
    expect(parseEvent(RESULT)).toEqual({ kind: 'result', isError: false, costUsd: 0.16828349999999997, text: 'ok' })
  })

  it('is_error:true maps to isError:true', () => {
    const line = '{"type":"result","is_error":true,"total_cost_usd":0.01,"result":"boom"}'
    expect(parseEvent(line)).toEqual({ kind: 'result', isError: true, costUsd: 0.01, text: 'boom' })
  })

  it('defaults costUsd to 0 when total_cost_usd is missing or non-number', () => {
    const missing = '{"type":"result","is_error":false,"result":"ok"}'
    expect(parseEvent(missing)).toEqual({ kind: 'result', isError: false, costUsd: 0, text: 'ok' })

    const nonNumber = '{"type":"result","is_error":false,"total_cost_usd":"lots","result":"ok"}'
    expect(parseEvent(nonNumber)).toEqual({ kind: 'result', isError: false, costUsd: 0, text: 'ok' })
  })

  it('defaults text to empty string when result is missing or non-string', () => {
    const missing = '{"type":"result","is_error":false,"total_cost_usd":0.5}'
    expect(parseEvent(missing)).toEqual({ kind: 'result', isError: false, costUsd: 0.5, text: '' })

    const nonString = '{"type":"result","is_error":false,"total_cost_usd":0.5,"result":42}'
    expect(parseEvent(nonString)).toEqual({ kind: 'result', isError: false, costUsd: 0.5, text: '' })
  })

  it('defaults isError to false when is_error is missing or not exactly true', () => {
    const missing = '{"type":"result","result":"ok"}'
    expect(parseEvent(missing)).toEqual({ kind: 'result', isError: false, costUsd: 0, text: 'ok' })

    const truthyString = '{"type":"result","is_error":"true","result":"ok"}'
    expect(parseEvent(truthyString)).toEqual({ kind: 'result', isError: false, costUsd: 0, text: 'ok' })
  })
})

describe('parseEvent — other/unknown types', () => {
  it('maps an unrecognized type to kind:other carrying the raw type', () => {
    expect(parseEvent('{"type":"weird_future_event","foo":1}')).toEqual({ kind: 'other', type: 'weird_future_event' })
  })
})
