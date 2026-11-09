/** A window's webContents, as far as the update holds care. */
export type HoldSender = {
  readonly id: number
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown
}

/** Which windows have something unsent (a draft, a queued message, an attachment), so a
 *  restart for an update waits for any of them. A window's hold goes with the window, and
 *  with its page when that crashes, since a reloaded page has lost what was typed. */
export class UpdateHolds {
  private readonly holding = new Set<number>()
  private readonly watched = new Set<number>()
  private readonly crashWatched = new Set<number>()

  set(sender: HoldSender, held: boolean): void {
    const id = sender.id
    if (!this.watched.has(id)) {
      this.watched.add(id)
      sender.once('destroyed', () => {
        this.holding.delete(id)
        this.watched.delete(id)
        this.crashWatched.delete(id)
      })
    }
    if (!this.crashWatched.has(id)) {
      this.crashWatched.add(id)
      sender.once('render-process-gone', () => {
        this.holding.delete(id)
        this.crashWatched.delete(id)
      })
    }
    if (held) this.holding.add(id)
    else this.holding.delete(id)
  }

  held(): boolean {
    return this.holding.size > 0
  }
}
