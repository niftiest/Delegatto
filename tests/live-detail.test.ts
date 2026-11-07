import { describe, it, expect } from 'vitest'
import { parseEvent } from '../src/main/engine/events'
import { reduceAgentRuns, stepLabel, textStep, type AgentRun } from '../src/shared/subagent-activity'
import { supportsLiveDetail } from '../src/main/engine/find-claude'
import { childEnv } from '../src/main/engine/transport'
import { plainTerminalText, reduceLivePreview, taskHasOutput } from '../src/renderer/lib'
import type { LiveEvent } from '../src/shared/engine-types'

// Lines recorded from Claude Code 2.1.318.
const line = (o: object): string => JSON.stringify(o)
const AGENT = 'toolu_agent'
const STARTED = line({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: AGENT, description: 'Read a.txt and summarize', subagent_type: 'general-purpose', is_backgrounded: false, task_type: 'local_agent' })
const BASH_STARTED = line({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_bash', description: 'node ticker', task_type: 'local_bash' })
const ENDED = line({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: AGENT, status: 'completed', output_file: 'x', summary: 'ok' })
const STEP = line({ type: 'assistant', parent_tool_use_id: AGENT, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'C:\\work\\a.txt' } }] } })
const SAID = line({ type: 'assistant', parent_tool_use_id: AGENT, message: { role: 'assistant', content: [{ type: 'text', text: 'The file has one line.\nAnd more.' }] } })

describe('reading the live frames', () => {
  it('reads thinking as it comes', () => {
    expect(parseEvent(line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I need', estimated_tokens: null } } })))
      .toEqual({ kind: 'thinkingDelta', text: 'I need' })
  })

  it('does not take a signature or empty thinking for text', () => {
    expect(parseEvent(line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'abc' } } }))).toMatchObject({ kind: 'other' })
    expect(parseEvent(line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } } }))).toMatchObject({ kind: 'other' })
  })

  it("keeps a subagent's thinking and tokens out of the chat", () => {
    expect(parseEvent(line({ type: 'stream_event', parent_tool_use_id: AGENT, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'mine' } } }))).toMatchObject({ kind: 'other' })
    expect(parseEvent(line({ type: 'stream_event', parent_tool_use_id: AGENT, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'mine' } } }))).toMatchObject({ kind: 'other' })
  })

  it('reads a subagent starting, working and ending', () => {
    expect(parseEvent(STARTED)).toEqual({ kind: 'taskStarted', toolUseId: AGENT, description: 'Read a.txt and summarize' })
    expect(parseEvent(STEP)).toEqual({ kind: 'subagentStep', parent: AGENT, label: 'Read a.txt' })
    expect(parseEvent(SAID)).toEqual({ kind: 'subagentStep', parent: AGENT, label: 'The file has one line.' })
    expect(parseEvent(ENDED)).toEqual({ kind: 'taskEnded', toolUseId: AGENT })
  })

  it('leaves a background command to its own list', () => {
    expect(parseEvent(BASH_STARTED)).not.toMatchObject({ kind: 'taskStarted' })
  })

  it("still doesn't put a subagent's words in the chat", () => {
    const ev = parseEvent(SAID) as LiveEvent
    expect(reduceLivePreview({ text: 'mine', sealed: false }, ev)).toEqual({ text: 'mine', sealed: false })
  })
})

describe('one tool call in a line', () => {
  it('says what it worked on', () => {
    expect(stepLabel('Read', { file_path: 'D:\\GIT\\x\\a.txt' })).toBe('Read a.txt')
    expect(stepLabel('Edit', { file_path: '/home/me/b.ts' })).toBe('Edit b.ts')
    expect(stepLabel('Bash', { command: 'npm test\nand more' })).toBe('Bash npm test')
    expect(stepLabel('Grep', { pattern: 'foo' })).toBe('Grep foo')
    expect(stepLabel('WebSearch', { query: 'hello' })).toBe('WebSearch hello')
  })

  it('copes with nothing useful', () => {
    expect(stepLabel('Thing', {})).toBe('Thing')
    expect(stepLabel('Thing', null)).toBe('Thing')
    expect(stepLabel('Thing', { command: 5 })).toBe('Thing')
  })

  it('stays short', () => {
    expect(stepLabel('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(90)
    expect(textStep('y'.repeat(500)).length).toBeLessThanOrEqual(90)
  })
})

describe('following subagents', () => {
  const start = (id: string): LiveEvent => ({ kind: 'taskStarted', toolUseId: id, description: `task ${id}` })
  const step = (id: string, label: string): LiveEvent => ({ kind: 'subagentStep', parent: id, label })
  const run = (events: LiveEvent[], from: AgentRun[] = []): AgentRun[] => events.reduce(reduceAgentRuns, from)

  it('keeps each one apart, with its latest few steps', () => {
    const runs = run([start('a'), start('b'), step('a', '1'), step('a', '2'), step('a', '3'), step('a', '4'), step('a', '5'), step('b', 'x')])
    expect(runs[0]).toEqual({ toolUseId: 'a', description: 'task a', steps: ['2', '3', '4', '5'] })
    expect(runs[1]!.steps).toEqual(['x'])
  })

  it('drops one when it ends, and ignores a step for one it has not seen', () => {
    expect(run([start('a'), start('b'), { kind: 'taskEnded', toolUseId: 'a' }]).map(r => r.toolUseId)).toEqual(['b'])
    expect(run([step('nobody', 'x')])).toEqual([])
  })

  it('does not start one twice', () => {
    expect(run([start('a'), step('a', '1'), start('a')])[0]!.steps).toEqual(['1'])
  })

  it('clears them all when the process goes', () => {
    expect(run([start('a'), { kind: 'exit', code: 1 }])).toEqual([])
  })

  it('keeps background agents going past the end of a turn', () => {
    expect(run([start('a'), { kind: 'result', isError: false, costUsd: 0, text: '' }])).toHaveLength(1)
  })

  it('returns the same list when nothing changed, so nothing redraws', () => {
    const runs: AgentRun[] = []
    expect(reduceAgentRuns(runs, { kind: 'delta', text: 'x' })).toBe(runs)
    expect(reduceAgentRuns(runs, { kind: 'exit', code: 0 })).toBe(runs)
  })
})

describe('the flags for live detail', () => {
  it('go only to a version known to have them', () => {
    expect(supportsLiveDetail('2.1.318 (Claude Code)')).toBe(true)
    expect(supportsLiveDetail('2.2.0 (Claude Code)')).toBe(true)
    expect(supportsLiveDetail('2.1.317 (Claude Code)')).toBe(false)
    expect(supportsLiveDetail('1.0.0')).toBe(false)
    expect(supportsLiveDetail('no idea')).toBe(false)
  })
})

describe('keeping file copies for Rewind', () => {
  it('turns them on for every chat, unless the user set it', () => {
    expect(childEnv({}).CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1')
    expect(childEnv({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '0' }).CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('0')
  })
})

describe('background command output', () => {
  it('is offered for shell commands and monitors, not agents', () => {
    expect(taskHasOutput('local_bash')).toBe(true)
    expect(taskHasOutput('monitor')).toBe(true)
    expect(taskHasOutput('local_agent')).toBe(false)
  })

  it('shows as plain text', () => {
    expect(plainTerminalText('\x1b[31mred\x1b[0m plain')).toBe('red plain')
    expect(plainTerminalText('\x1b]0;title\x07after')).toBe('after')
    expect(plainTerminalText('one\r\ntwo\n')).toBe('one\ntwo\n')
    expect(plainTerminalText('10%\r50%\r100%\nnext')).toBe('100%\nnext')
    expect(plainTerminalText('untouched')).toBe('untouched')
  })
})
