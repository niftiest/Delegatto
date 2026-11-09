import { describe, it, expect, vi } from 'vitest'
import { ChatVisibility } from '../src/main/chat-visibility'
import { WindowHub, type HubWindow } from '../src/main/window-hub'

describe('ChatVisibility', () => {
  it('holds the union of every window\'s chats, sorted', () => {
    const v = new ChatVisibility()
    v.set(1, [2, 1])
    v.set(7, [3, 2])
    expect(v.all()).toEqual([1, 2, 3])
    expect(v.windowsShowing(2).sort()).toEqual([1, 7])
    expect(v.windowsShowing(3)).toEqual([7])
    expect(v.windowsShowing(9)).toEqual([])
    expect(v.visibleIn(1, 1)).toBe(true)
    expect(v.visibleIn(7, 1)).toBe(false)
  })

  it('drops only the removed window\'s chats', () => {
    const v = new ChatVisibility()
    v.set(1, [1, 2])
    v.set(7, [2, 3])
    v.remove(1)
    expect(v.all()).toEqual([2, 3])
    expect(v.windowsShowing(2)).toEqual([7])
  })

  it('clears a window that reports no chats', () => {
    const v = new ChatVisibility()
    v.set(1, [1, 2])
    v.set(1, [])
    expect(v.all()).toEqual([])
    expect(v.visibleIn(1, 1)).toBe(false)
  })

  it('says when a window\'s set changes', () => {
    const v = new ChatVisibility()
    const cb = vi.fn()
    const off = v.onChange(cb)
    v.set(1, [1])
    v.remove(1)
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    v.set(1, [2])
    expect(cb).toHaveBeenCalledTimes(2)
  })
})

type Listener = () => void
type FakeWindow = HubWindow & { emit(event: string): void; destroyed: boolean; sent: unknown[][] }

function fakeWindow(id: number): FakeWindow {
  const listeners = new Map<string, Listener[]>()
  const sent: unknown[][] = []
  const w: FakeWindow = {
    id,
    destroyed: false,
    sent,
    webContents: { send: (channel: string, ...args: unknown[]) => { sent.push([channel, ...args]) } },
    isDestroyed: () => w.destroyed,
    on(event: string, l: Listener) { listeners.set(event, [...(listeners.get(event) ?? []), l]); return w },
    emit(event: string) { for (const l of listeners.get(event) ?? []) l() }
  }
  return w
}

describe('WindowHub', () => {
  it('sends to every registered window and skips a destroyed one', () => {
    const hub = new WindowHub<FakeWindow>()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    const c = fakeWindow(3)
    hub.register(a, 'main')
    hub.register(b, 'split')
    hub.register(c, 'split')
    c.destroyed = true
    hub.send('engine:event', 5, { kind: 'x' })
    expect(a.sent).toEqual([['engine:event', 5, { kind: 'x' }]])
    expect(b.sent).toEqual([['engine:event', 5, { kind: 'x' }]])
    expect(c.sent).toEqual([])
  })

  it('knows the main and split windows, and finds a window by its contents', () => {
    const hub = new WindowHub<FakeWindow>()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    expect(hub.main()).toBeNull()
    hub.register(a, 'main')
    hub.register(b, 'split')
    expect(hub.main()).toBe(a)
    expect(hub.split()).toBe(b)
    expect(hub.fromContents(b.webContents)).toBe(b)
    expect(hub.fromContents({ send: () => {} })).toBeNull()
  })

  it('forgets a closed window and its chats', () => {
    const hub = new WindowHub<FakeWindow>()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    hub.register(a, 'main')
    hub.register(b, 'split')
    hub.visibility.set(1, [1, 2])
    hub.visibility.set(2, [2, 3])
    const changed = vi.fn()
    hub.onVisibilityChange(changed)
    b.emit('closed')
    expect(hub.split()).toBeNull()
    expect(hub.visibility.all()).toEqual([1, 2])
    expect(changed).toHaveBeenCalled()
    hub.send('x')
    expect(b.sent).toEqual([])
    expect(a.sent).toEqual([['x']])
  })

  it('stops counting a window\'s chats when its page crashes, and keeps the window', () => {
    const hub = new WindowHub<FakeWindow>()
    const a = fakeWindow(1)
    const crashed: Listener[] = []
    const b: FakeWindow = { ...fakeWindow(2), webContents: { send: () => {}, on: (_event: 'render-process-gone', l: Listener) => { crashed.push(l) } } }
    hub.register(a, 'main')
    hub.register(b, 'split')
    hub.visibility.set(1, [1])
    hub.visibility.set(2, [2, 3])
    const changed = vi.fn()
    hub.onVisibilityChange(changed)
    expect(crashed).toHaveLength(1)
    crashed[0]!()
    expect(hub.visibility.all()).toEqual([1])
    expect(changed).toHaveBeenCalled()
    expect(hub.split()).toBe(b)
    // The reloaded page says again what it shows.
    hub.visibility.set(2, [2])
    expect(hub.visibility.all()).toEqual([1, 2])
  })

  it('calls focus listeners when any window gains focus', () => {
    const hub = new WindowHub<FakeWindow>()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    hub.register(a, 'main')
    hub.register(b, 'split')
    const cb = vi.fn()
    const off = hub.onAnyFocus(cb)
    a.emit('focus')
    b.emit('focus')
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    a.emit('focus')
    expect(cb).toHaveBeenCalledTimes(2)
  })
})
