import type { BrowserWindow } from 'electron'
import { ChatVisibility } from './chat-visibility'

/** What the hub needs from a window. A real BrowserWindow fits, and so does a test fake. */
export interface HubWindow {
  readonly id: number
  readonly webContents: {
    send(channel: string, ...args: any[]): void
    on?(event: 'render-process-gone', listener: () => void): unknown
  }
  isDestroyed(): boolean
  on(event: 'closed', listener: () => void): unknown
  on(event: 'focus', listener: () => void): unknown
}

export type WindowRole = 'main' | 'split'

type Entry<W> = { win: W; role: WindowRole }

/** Every open window: renderer events go to all of them, and each one's shown chats are kept. */
export class WindowHub<W extends HubWindow = BrowserWindow> {
  readonly visibility = new ChatVisibility()
  private readonly windows = new Map<number, Entry<W>>()
  private readonly focusListeners = new Set<() => void>()

  register(win: W, role: WindowRole): void {
    const id = win.id
    const onFocus = (): void => {
      for (const cb of [...this.focusListeners]) {
        try { cb() } catch (err) { console.error('[windows] focus listener failed', err) }
      }
    }
    this.windows.set(id, { win, role })
    win.on('focus', onFocus)
    win.on('closed', () => {
      if (this.windows.get(id)?.win === win) this.windows.delete(id)
      this.visibility.remove(id)
    })
    // A crashed page shows nothing. If it's reloaded, the new page says again what it shows.
    win.webContents.on?.('render-process-gone', () => this.visibility.remove(id))
  }

  send(channel: string, ...args: unknown[]): void {
    for (const { win } of [...this.windows.values()]) {
      if (win.isDestroyed()) continue
      try { win.webContents.send(channel, ...args) } catch (err) { console.error(`[windows] couldn't send ${channel}`, err) }
    }
  }

  main(): W | null {
    return this.byRole('main')
  }

  split(): W | null {
    return this.byRole('split')
  }

  /** The registered window showing these contents, if any. */
  fromContents(c: unknown): W | null {
    for (const { win } of this.windows.values()) {
      if (!win.isDestroyed() && win.webContents === c) return win
    }
    return null
  }

  /** Called whenever any registered window gains focus. */
  onAnyFocus(cb: () => void): () => void {
    this.focusListeners.add(cb)
    return () => { this.focusListeners.delete(cb) }
  }

  onVisibilityChange(cb: () => void): () => void {
    return this.visibility.onChange(cb)
  }

  private byRole(role: WindowRole): W | null {
    // The newest window with the role wins (only one split exists at a time).
    let found: W | null = null
    for (const e of this.windows.values()) {
      if (e.role === role && !e.win.isDestroyed()) found = e.win
    }
    return found
  }
}
