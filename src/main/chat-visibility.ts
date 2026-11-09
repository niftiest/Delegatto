/** Which chats each window shows, by window id. Pure: no electron. */
export class ChatVisibility {
  private readonly byWindow = new Map<number, Set<number>>()
  private readonly listeners = new Set<() => void>()

  set(windowId: number, pks: number[]): void {
    const clean = [...new Set(pks.filter(pk => Number.isInteger(pk)))]
    const before = this.byWindow.get(windowId)
    if ((before?.size ?? 0) === clean.length && clean.every(pk => before?.has(pk) === true)) return
    if (clean.length === 0) this.byWindow.delete(windowId)
    else this.byWindow.set(windowId, new Set(clean))
    this.changed()
  }

  remove(windowId: number): void {
    if (!this.byWindow.delete(windowId)) return
    this.changed()
  }

  /** Every chat shown in any window, sorted. */
  all(): number[] {
    const union = new Set<number>()
    for (const pks of this.byWindow.values()) for (const pk of pks) union.add(pk)
    return [...union].sort((a, b) => a - b)
  }

  windowsShowing(pk: number): number[] {
    return [...this.byWindow].filter(([, pks]) => pks.has(pk)).map(([id]) => id)
  }

  visibleIn(windowId: number, pk: number): boolean {
    return this.byWindow.get(windowId)?.has(pk) ?? false
  }

  /** Called whenever any window's set changes, including a window going away. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private changed(): void {
    for (const cb of [...this.listeners]) {
      try { cb() } catch (err) { console.error('[visibility] listener failed', err) }
    }
  }
}
