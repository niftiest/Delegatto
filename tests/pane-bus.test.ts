import { describe, it, expect } from 'vitest'
import { PaneBus, type PaneMessage } from '../src/renderer/pane-bus'

const drop = (uuid: string): PaneMessage => ({ kind: 'dropCancelled', uuid })

describe('messages for the pane showing a chat', () => {
  it('reaches only the listeners for that chat', () => {
    const bus = new PaneBus()
    const one: PaneMessage[] = []
    const two: PaneMessage[] = []
    bus.on(1, m => one.push(m))
    bus.on(2, m => two.push(m))
    bus.emit(1, drop('a'))
    expect(one).toEqual([drop('a')])
    expect(two).toEqual([])
  })

  it('reaches every view of the same chat', () => {
    const bus = new PaneBus()
    const seen: string[] = []
    bus.on(3, () => seen.push('main'))
    bus.on(3, () => seen.push('pane'))
    bus.emit(3, drop('b'))
    expect(seen).toEqual(['main', 'pane'])
  })

  it('stops delivering once unsubscribed, leaving the other listeners', () => {
    const bus = new PaneBus()
    const first: PaneMessage[] = []
    const second: PaneMessage[] = []
    const off = bus.on(4, m => first.push(m))
    bus.on(4, m => second.push(m))
    off()
    bus.emit(4, drop('c'))
    expect(first).toEqual([])
    expect(second).toEqual([drop('c')])
  })

  it('goes nowhere when no pane shows the chat', () => {
    const bus = new PaneBus()
    expect(() => bus.emit(9, drop('d'))).not.toThrow()
  })

  it('unsubscribing twice does not remove another listener', () => {
    const bus = new PaneBus()
    const seen: PaneMessage[] = []
    const cb = (m: PaneMessage): void => { seen.push(m) }
    const off = bus.on(5, cb)
    bus.on(5, cb)
    off()
    off()
    bus.emit(5, drop('e'))
    expect(seen).toEqual([drop('e')])
  })
})
