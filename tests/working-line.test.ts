import { describe, expect, it } from 'vitest'
import { applyStreamedToolResults, pendingTools, renderItemsFromStreamedRows, workingDetails } from '../src/renderer/lib'
import type { RenderItem } from '../src/shared/types'
import type { StreamedRow } from '../src/main/jsonl/stream'

const row = (uuid: string, type: 'user' | 'assistant', content: unknown[], timestamp = '2026-11-02T10:00:00.000Z'): StreamedRow =>
  ({ row: { type, uuid, parentUuid: null, timestamp, message: { role: type, content } } }) as unknown as StreamedRow
const toolUse = (id: string, name = 'Bash') => row(`a-${id}`, 'assistant', [{ type: 'tool_use', id, name, input: {} }])
const toolResult = (id: string, text = 'output') => row(`u-${id}`, 'user', [{ type: 'tool_result', tool_use_id: id, content: text }])
const said = (text: string) => row(`u-${text}`, 'user', [{ type: 'text', text }])

describe('tool results arriving after their call', () => {
  it('completes a call from an earlier batch', () => {
    const items = renderItemsFromStreamedRows([toolUse('t1')])
    expect(items[0]).toMatchObject({ kind: 'tool', result: null })
    const next = applyStreamedToolResults(items, [toolResult('t1', 'hello')])
    expect(next[0]).toMatchObject({ kind: 'tool', result: { text: 'hello', isError: false } })
  })

  it('returns the same array when the batch has no result for anything showing', () => {
    const items = renderItemsFromStreamedRows([toolUse('t1')])
    expect(applyStreamedToolResults(items, [said('hi')])).toBe(items)
    expect(applyStreamedToolResults(items, [toolResult('other')])).toBe(items)
  })
})

describe('pendingTools', () => {
  const items = (rows: StreamedRow[]): RenderItem[] => renderItemsFromStreamedRows(rows)

  it('is empty when no turn is running', () => {
    expect(pendingTools(items([said('go'), toolUse('t1')]), false)).toEqual([])
  })

  it('lists unanswered calls oldest first, with when they started', () => {
    const list = pendingTools(items([said('go'), toolUse('t1'), toolUse('t2', 'Read'), toolResult('t1')]), true)
    expect(list).toEqual([{ toolUseId: 't2', name: 'Read', ts: '2026-11-02T10:00:00.000Z' }])
  })

  it('ignores a call left unanswered by an earlier, interrupted turn', () => {
    const list = pendingTools(items([said('first'), toolUse('old'), said('second'), toolUse('new')]), true)
    expect(list.map(p => p.toolUseId)).toEqual(['new'])
  })
})

describe('workingDetails', () => {
  const start = Date.parse('2026-11-02T10:00:00.000Z')
  const base = { startedAt: start, tokens: 0, pending: [], lastActivity: start, quiet: false }
  const bash = { toolUseId: 't', name: 'Bash', ts: '2026-11-02T10:05:33.000Z' }

  it('shows the running step on its own timer, separate from the turn', () => {
    const now = start + 7 * 60_000 + 43_000
    expect(workingDetails({ ...base, now, pending: [bash], lastActivity: now, tokens: 11000 }))
      .toEqual(['Bash running 2m 10s', 'turn 7m 43s', '↓ 11.0k tokens'])
  })

  it('counts other calls running alongside', () => {
    const now = start + 400_000
    expect(workingDetails({ ...base, now, pending: [bash, { ...bash, toolUseId: 'u' }], lastActivity: now })[0]).toMatch(/^Bash \+1 running/)
  })

  it('only mentions silence after two minutes with no tool running', () => {
    expect(workingDetails({ ...base, now: start + 119_000 })).toEqual(['turn 1m 59s'])
    expect(workingDetails({ ...base, now: start + 180_000 })).toEqual(['turn 3m 0s', 'no output for 3m 0s'])
    const withTool = workingDetails({ ...base, now: start + 400_000, pending: [bash] })
    expect(withTool.some(d => d.startsWith('no output'))).toBe(false)
  })

  it('keeps to the turn time while compacting or waiting on the user', () => {
    expect(workingDetails({ ...base, now: start + 400_000, pending: [bash], quiet: true })).toEqual(['turn 6m 40s'])
  })
})
