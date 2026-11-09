import { describe, expect, it } from 'vitest'
import { escapeIsFor, type EscapeDoc, type EscapeScopeElement } from '../src/renderer/escape-scope'

/** Just enough of a DOM: each node knows its parent, and a pane is marked as one. */
type FakeNode = EscapeScopeElement & { parent: FakeNode | null; pane: boolean }
function node(parent: FakeNode | null, pane = false): FakeNode {
  const n: FakeNode = {
    parent,
    pane,
    contains(other: unknown) {
      for (let at = other as FakeNode | null; at !== null && at !== undefined; at = at.parent) if (at === n) return true
      return false
    },
    closest(selector: string) {
      if (selector !== '[data-pane]') throw new Error(`unexpected selector ${selector}`)
      for (let at: FakeNode | null = n; at !== null; at = at.parent) if (at.pane) return at
      return null
    }
  }
  return n
}

describe('which Esc belongs to a dialog', () => {
  const body = node(null)
  const paneA = node(body, true)
  const paneAComposer = node(paneA)
  const paneASlot = node(paneA)
  const paneADialogButton = node(paneASlot)
  const paneB = node(body, true)
  const paneBComposer = node(paneB)
  const paneBSlot = node(paneB)
  const doc = (active: unknown): EscapeDoc => ({ body, activeElement: active })

  it('in the main window, every Esc is the dialog\'s, as before', () => {
    expect(escapeIsFor(body, { target: body }, doc(body))).toBe(true)
    expect(escapeIsFor(body, { target: paneBComposer }, doc(paneBComposer))).toBe(true)
  })

  it('in a pane, Esc pressed in that pane or its dialog is the dialog\'s', () => {
    expect(escapeIsFor(paneASlot, { target: paneADialogButton }, doc(paneADialogButton))).toBe(true)
    // Opened from the message box, which keeps the focus.
    expect(escapeIsFor(paneASlot, { target: paneAComposer }, doc(paneAComposer))).toBe(true)
  })

  it('Esc pressed in another pane leaves this pane\'s dialog open', () => {
    expect(escapeIsFor(paneASlot, { target: paneBComposer }, doc(paneBComposer))).toBe(false)
    expect(escapeIsFor(paneASlot, { target: body }, doc(paneBSlot))).toBe(false)
  })

  it('takes the focused element when the key comes from the page itself', () => {
    expect(escapeIsFor(paneASlot, { target: body }, doc(paneADialogButton))).toBe(true)
  })

  it('a box outside any pane only answers for what is inside it', () => {
    const loose = node(body)
    const inside = node(loose)
    expect(escapeIsFor(loose, { target: inside }, doc(inside))).toBe(true)
    expect(escapeIsFor(loose, { target: paneAComposer }, doc(paneAComposer))).toBe(false)
  })
})
