/** Something app-wide code has for whichever pane shows one chat. */
export type PaneMessage =
  // Esc before any reply took a message back: it leaves that chat's transcript.
  | { kind: 'dropCancelled'; uuid: string }
  // A notice for the chat's notice line, from the window around it (the nav, a pin).
  | { kind: 'notice'; text: string }

type Listener = { cb: (msg: PaneMessage) => void }

/** Routes a message to the panes showing a chat, by its pk. A chat no pane shows drops it:
 *  it reads its state from disk when it's opened. */
export class PaneBus {
  private listeners = new Map<number, Set<Listener>>()

  on(sessionPk: number, cb: (msg: PaneMessage) => void): () => void {
    // Each subscription is its own entry, so the same callback twice is two listeners.
    const entry: Listener = { cb }
    let set = this.listeners.get(sessionPk)
    if (set === undefined) { set = new Set(); this.listeners.set(sessionPk, set) }
    set.add(entry)
    return () => {
      const now = this.listeners.get(sessionPk)
      if (now === undefined) return
      now.delete(entry)
      if (now.size === 0) this.listeners.delete(sessionPk)
    }
  }

  emit(sessionPk: number, msg: PaneMessage): void {
    const set = this.listeners.get(sessionPk)
    if (set === undefined) return
    for (const l of [...set]) l.cb(msg)
  }
}

export const paneBus = new PaneBus()
