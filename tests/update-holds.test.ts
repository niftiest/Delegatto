import { describe, expect, it } from 'vitest'
import { UpdateHolds, type HoldSender } from '../src/main/update-holds'

/** A window's webContents, as far as the holds care: an id, and the moment it goes. */
function sender(id: number): HoldSender & { goes: Map<string, () => void>; go(event: string): void } {
  const goes = new Map<string, () => void>()
  return {
    id,
    goes,
    once(event: string, cb: () => void) { goes.set(event, cb) },
    go(event: string) { const cb = goes.get(event); goes.delete(event); cb?.() }
  }
}

describe('update holds, one per window', () => {
  it('is held while any window holds', () => {
    const holds = new UpdateHolds()
    const main = sender(1)
    const split = sender(2)
    holds.set(main, false)
    holds.set(split, true)
    expect(holds.held()).toBe(true)
    // The main window having nothing unsent doesn't let a pane's draft go.
    holds.set(main, false)
    expect(holds.held()).toBe(true)
    holds.set(split, false)
    expect(holds.held()).toBe(false)
  })

  it('a second window holding and letting go leaves the first one\'s hold alone', () => {
    const holds = new UpdateHolds()
    const main = sender(1)
    const split = sender(2)
    holds.set(main, true)
    holds.set(split, true)
    holds.set(split, false)
    expect(holds.held()).toBe(true)
  })

  it('lets go of a window\'s hold when the window goes', () => {
    const holds = new UpdateHolds()
    const main = sender(1)
    const split = sender(2)
    holds.set(main, false)
    holds.set(split, true)
    split.go('destroyed')
    expect(holds.held()).toBe(false)
  })

  it('lets go of a window\'s hold when its page crashes, which forgets what was typed', () => {
    const holds = new UpdateHolds()
    const split = sender(2)
    holds.set(split, true)
    split.go('render-process-gone')
    expect(holds.held()).toBe(false)
    // Holding again after the reload still counts, and still lets go when the window goes.
    holds.set(split, true)
    expect(holds.held()).toBe(true)
    split.go('destroyed')
    expect(holds.held()).toBe(false)
  })

  it('watches each window once, however often it reports', () => {
    const holds = new UpdateHolds()
    let watched = 0
    const s: HoldSender = { id: 3, once: () => { watched++ } }
    holds.set(s, true)
    holds.set(s, false)
    holds.set(s, true)
    expect(watched).toBe(2) // destroyed and render-process-gone, once each
  })
})
