import { describe, it, expect } from 'vitest'
import { reduceLivePreview, mergeReloadedPage, stableItemKeys, groupIntoTurns, suppressSealedPreview } from '../src/renderer/lib'
import type { RenderItem } from '../src/shared/types'

const text = (uuid: string, role: 'user' | 'assistant' = 'assistant', body = uuid): RenderItem =>
  ({ kind: 'text', uuid, role, text: body, ts: null }) as RenderItem
const firstTurnKey = (items: RenderItem[]): string => stableItemKeys(items)[groupIntoTurns(items)[0]!.startIndex]!

describe('reloading a chat while Claude works', () => {
  it('keeps what is above the page, so a long turn is not rebuilt', () => {
    const current = ['u', 'a1', 'a2', 'a3'].map((id, i) => text(id, i === 0 ? 'user' : 'assistant'))
    const page = ['a2', 'a3', 'a4'].map(id => text(id))
    const merged = mergeReloadedPage(current, page)
    expect(merged.items.map(i => i.uuid)).toEqual(['u', 'a1', 'a2', 'a3', 'a4'])
    expect(merged.keptAbove).toBe(2)
    expect(firstTurnKey(merged.items)).toBe(firstTurnKey(current))
  })

  it('keeps the first turn the same when the page has moved inside it', () => {
    const current = ['a1', 'a2', 'a3'].map(id => text(id))
    const page = ['a2', 'a3', 'a4'].map(id => text(id))
    expect(firstTurnKey(mergeReloadedPage(current, page).items)).toBe(firstTurnKey(current))
  })

  it('takes the fresh copy of everything the page covers', () => {
    const merged = mergeReloadedPage([text('a1'), text('a2', 'assistant', 'old')], [text('a2', 'assistant', 'new')])
    expect(merged.items.map(i => (i as { text: string }).text)).toEqual(['a1', 'new'])
  })

  it('does not repeat a message that made several items', () => {
    const current = [text('a1'), text('a2', 'assistant', 'one'), text('a2', 'assistant', 'two')]
    const merged = mergeReloadedPage(current, [text('a2', 'assistant', 'one'), text('a2', 'assistant', 'two'), text('a3')])
    expect(merged.items.map(i => i.uuid)).toEqual(['a1', 'a2', 'a2', 'a3'])
    expect(new Set(stableItemKeys(merged.items)).size).toBe(4)
  })

  it('replaces everything when the page shares nothing with the view', () => {
    const merged = mergeReloadedPage([text('old')], [text('new')])
    expect(merged.items.map(i => i.uuid)).toEqual(['new'])
    expect(merged.keptAbove).toBe(0)
  })

  it('accepts an empty page as it is', () => {
    expect(mergeReloadedPage([text('a')], [])).toEqual({ items: [], keptAbove: 0 })
  })

  it('leaves text still being typed alone, and clears a finished bubble', () => {
    expect(suppressSealedPreview({ text: 'half a sen', sealed: false }, true)).toEqual({ text: 'half a sen', sealed: false })
    expect(suppressSealedPreview({ text: 'done', sealed: true }, true)).toBeNull()
    expect(suppressSealedPreview(null, true)).toBeNull()
  })

  it('keeps a finished bubble past the end of the turn, until the saved row replaces it', () => {
    const result = { kind: 'result', isError: false, costUsd: 0, text: '' } as const
    const kept = reduceLivePreview({ text: 'all done', sealed: true }, result)
    expect(kept).toEqual({ text: 'all done', sealed: true })
    expect(suppressSealedPreview(kept, true)).toBeNull()
    expect(reduceLivePreview({ text: 'half a sen', sealed: false }, result)).toBeNull()
    expect(reduceLivePreview({ text: 'all done', sealed: true }, { kind: 'exit', code: 1 } as never)).toBeNull()
  })
})
