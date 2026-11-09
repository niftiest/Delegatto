// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from '../../src/renderer/components/Markdown'
import { Transcript } from '../../src/renderer/components/Transcript'
import { PinnedMessages } from '../../src/renderer/components/PinBadge'

const badge = (el: Element | null): Element | null => el?.querySelector(':scope > .pin-badge') ?? null

describe('the pin on a pinned message', () => {
  it('marks a pinned reply at its corner, and no other', () => {
    const { container } = render(
      <PinnedMessages.Provider value={new Set(['a1'])}>
        <Markdown text="pinned reply" anchor="a1" />
        <Markdown text="ordinary reply" anchor="a2" />
      </PinnedMessages.Provider>
    )
    expect(badge(container.querySelector('[data-msg="a1"]'))?.getAttribute('aria-label')).toBe('Pinned')
    expect(badge(container.querySelector('[data-msg="a2"]'))).toBeNull()
  })

  it('marks the user\'s own pinned message in the chat', () => {
    const items = [
      { kind: 'text' as const, uuid: 'u1', role: 'user' as const, ts: '2026-11-09T10:00:00Z', model: null, text: 'please pin this' },
      { kind: 'text' as const, uuid: 'a1', role: 'assistant' as const, ts: '2026-11-09T10:00:05Z', model: null, text: 'a reply' }
    ]
    const { container } = render(<Transcript items={items} hasMore={false} loadingOlder={false} loading={false} onReachTop={() => {}} pinnedUuids={new Set(['u1'])} />)
    expect(badge(container.querySelector('[data-msg="u1"]'))).not.toBeNull()
    expect(badge(container.querySelector('[data-msg="a1"]'))).toBeNull()
  })

  it('shows nothing without any pins', () => {
    const { container } = render(<Markdown text="reply" anchor="a1" />)
    expect(container.querySelector('.pin-badge')).toBeNull()
  })
})
