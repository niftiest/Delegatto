// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { hideClearedLimitNotices, isLimitNotice, limitCleared } from '../src/renderer/usage-limit'
import type { RenderItem } from '../src/shared/types'

const limit = (uuid: string, ts: string): RenderItem => ({ kind: 'notice', uuid, ts, text: "You've hit your 5-hour limit · resets 2pm (America/New_York)", label: "You've hit your 5-hour limit" })
const reply = (uuid: string, extra: Partial<Extract<RenderItem, { kind: 'text' }>> = {}): RenderItem => ({ kind: 'text', uuid, role: 'assistant', ts: '2026-11-09T15:00:00Z', model: 'claude-opus-5-5', text: 'ok', ...extra })
const ask = (uuid: string): RenderItem => ({ kind: 'text', uuid, role: 'user', ts: '2026-11-09T15:00:00Z', model: null, text: 'go on' })
const uuids = (items: RenderItem[]): string[] => items.map(i => i.uuid)

describe('the you-have-hit-your-limit notice', () => {
  it('knows a limit notice, and no other', () => {
    expect(isLimitNotice(limit('n', '2026-11-09T12:00:00Z'))).toBe(true)
    expect(isLimitNotice({ kind: 'notice', uuid: 'n', ts: null, text: "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage" })).toBe(true)
    expect(isLimitNotice({ kind: 'notice', uuid: 'n', ts: null, text: 'API Error: 500 Internal server error.' })).toBe(false)
    expect(isLimitNotice(reply('t', { text: "You've hit your limit" }))).toBe(false)
  })

  it('stays while it is the last word in the chat', () => {
    const items = [ask('u1'), limit('n1', '2026-11-09T12:00:00Z')]
    expect(uuids(hideClearedLimitNotices(items, null))).toEqual(['u1', 'n1'])
  })

  it('goes once Claude has replied after it in the same chat', () => {
    const items = [ask('u1'), limit('n1', '2026-11-09T12:00:00Z'), ask('u2'), reply('a2')]
    expect(uuids(hideClearedLimitNotices(items, null))).toEqual(['u1', 'u2', 'a2'])
  })

  it('stays when only a ! command or a slash command answered after it', () => {
    const items = [limit('n1', '2026-11-09T12:00:00Z'), reply('s1', { literal: true }), reply('c1', { command: 'output' })]
    expect(uuids(hideClearedLimitNotices(items, null))).toEqual(['n1', 's1', 'c1'])
  })

  it('goes when another chat got a reply after it was written, and a newer one shows', () => {
    const items = [limit('old', '2026-11-09T12:00:00Z'), ask('u'), limit('new', '2026-11-09T18:00:00Z')]
    expect(uuids(hideClearedLimitNotices(items, Date.parse('2026-11-09T15:00:00Z')))).toEqual(['u', 'new'])
  })
})

describe('when a reply last came', () => {
  beforeEach(() => window.localStorage.clear())

  it('only moves forward, and tells whoever is listening', () => {
    let heard = 0
    const stop = limitCleared.subscribe(() => { heard++ })
    expect(limitCleared.get()).toBeNull()
    limitCleared.mark(2000)
    limitCleared.mark(1000)
    expect(limitCleared.get()).toBe(2000)
    expect(heard).toBe(1)
    stop()
  })
})
