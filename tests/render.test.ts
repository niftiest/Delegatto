import { describe, it, expect } from 'vitest'
import { buildRenderItems } from '../src/main/jsonl/render'
import type { MessageRow } from '../src/main/jsonl/rows'

const assistant = (uuid: string, content: unknown[]): MessageRow => ({
  type: 'assistant', uuid, parentUuid: null, timestamp: '2026-07-23T10:00:00Z',
  message: { role: 'assistant', model: 'claude-opus-4-8', content: content as never }
})
const user = (uuid: string, content: unknown): MessageRow => ({
  type: 'user', uuid, parentUuid: null, timestamp: '2026-07-23T10:01:00Z',
  message: { role: 'user', content: content as never }
})

describe('buildRenderItems', () => {
  it('emits text and thinking as separate items', () => {
    const items = buildRenderItems([assistant('a1', [
      { type: 'thinking', thinking: 'considering' }, { type: 'text', text: 'Done' }
    ])])
    expect(items.map(i => i.kind)).toEqual(['thinking', 'text'])
  })

  it('pairs a tool_use with the tool_result in the next user row', () => {
    const items = buildRenderItems([
      assistant('a1', [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'x.ts' } }]),
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '340 lines' }])
    ])
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.name).toBe('Read')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('340 lines')
    expect(tool && tool.kind === 'tool' && tool.result?.isError).toBe(false)
  })

  it('marks an errored tool result', () => {
    const items = buildRenderItems([
      assistant('a1', [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} }]),
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'boom', is_error: true }])
    ])
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.isError).toBe(true)
  })

  it('leaves an unmatched tool_use with a null result rather than dropping it', () => {
    const items = buildRenderItems([assistant('a1', [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }])])
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result).toBeNull()
  })

  it('flags a Task tool so the UI can load its subagent transcript', () => {
    const items = buildRenderItems([assistant('a1', [{ type: 'tool_use', id: 'toolu_09', name: 'Task', input: {} }])])
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.subagentToolUseId).toBe('toolu_09')
  })

  it('does not render tool_result blocks as user text', () => {
    const items = buildRenderItems([
      assistant('a1', [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }]),
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }])
    ])
    expect(items.filter(i => i.kind === 'text')).toHaveLength(0)
  })

  it('keeps images', () => {
    const items = buildRenderItems([user('u1', [{ type: 'image', source: { media_type: 'image/png' } }])])
    expect(items[0]!.kind).toBe('image')
  })

  it('drops the synthetic image coordinate-mapping metadata line the CLI injects', () => {
    const items = buildRenderItems([user('u1', [
      { type: 'text', text: '[Image: original 3296x514, displayed at 2000x312. Multiply coordinates by 1.65 to map to original image.]' }
    ])])
    expect(items).toHaveLength(0)
  })

  it('does not drop an ordinary message that merely starts with "[Image:"', () => {
    const items = buildRenderItems([user('u1', [
      { type: 'text', text: '[Image: my screenshot] can you look at this and tell me what is wrong?' }
    ])])
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('text')
  })

  it('renders a Claude Code background-task ping as a notice, not a user turn', () => {
    const items = buildRenderItems([user('u1', [
      { type: 'text', text: '<task-notification>\n<task-id>bik7o3uel</task-id>\n<summary>Wait for deploy completed (exit code 0)</summary>\n</task-notification>' }
    ])])
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('notice')
    expect(items[0]!.kind === 'notice' && items[0]!.text).toContain('<task-notification>')
  })

  it('does not treat an assistant message quoting the tag as a notice', () => {
    const items = buildRenderItems([assistant('a1', [
      { type: 'text', text: '<task-notification>example</task-notification>' }
    ])])
    expect(items[0]!.kind).toBe('text')
  })

  it('does not misclassify an ordinary message that merely mentions the tag', () => {
    const items = buildRenderItems([user('u1', [
      { type: 'text', text: 'why do I keep seeing <task-notification> in my chats?' }
    ])])
    expect(items[0]!.kind).toBe('text')
  })

  it('renders only rows in emitFor but still resolves results from lookahead rows', () => {
    // 'u2' is a lookahead row: it must supply the tool_result without rendering.
    const items = buildRenderItems(
      [
        assistant('a1', [{ type: 'text', text: 'LIVE' }, { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }]),
        user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '340 lines' }]),
        assistant('a3', [{ type: 'text', text: 'LOOKAHEAD' }])
      ],
      new Set(['a1'])
    )
    expect(items.map(i => i.uuid)).toEqual(['a1', 'a1'])
    expect(items.some(i => i.kind === 'text' && i.text === 'LOOKAHEAD')).toBe(false)
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('340 lines')
  })

  it('renders every row when emitFor is omitted', () => {
    const items = buildRenderItems([assistant('a1', [{ type: 'text', text: 'one' }]), assistant('a2', [{ type: 'text', text: 'two' }])])
    expect(items.map(i => i.uuid)).toEqual(['a1', 'a2'])
  })

  // Regression test: Fix 1 — array tool_result content must not inject blank lines
  it('does not inject blank lines between text blocks separated by non-text blocks in tool_result array content', () => {
    const items = buildRenderItems([
      assistant('a1', [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }]),
      user('u2', [{
        type: 'tool_result',
        tool_use_id: 'toolu_01',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'image', source: { media_type: 'image/png' } },
          { type: 'text', text: 'line two' }
        ]
      } as never])
    ])
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('line one\nline two')
  })

  it('preserves string tool_result content unchanged', () => {
    const items = buildRenderItems([
      assistant('a1', [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }]),
      user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'just text' }])
    ])
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('just text')
  })

  // Regression test: Fix 2 — empty-string tool_use_id must fail closed
  it('fails closed on empty-string tool_use_id — does not pair', () => {
    const items = buildRenderItems([
      assistant('a1', [{ type: 'tool_use', id: '', name: 'Read', input: {} } as never]),
      user('u2', [{ type: 'tool_result', tool_use_id: '', content: 'result text' } as never])
    ])
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result).toBeNull()
  })
})
