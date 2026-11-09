import type { MainDialogRequest } from '../shared/app-dialog'

/** How long the window gets to say it's showing a question before a native box takes over. */
const SHOWN_WITHIN_MS = 1500

type Pending<T> = { request: MainDialogRequest; to: T | undefined; resolve: (index: number) => void; timer: ReturnType<typeof setTimeout> | null }

/** Asks questions in the app's own window. A window that has crashed or hung can't answer, and
 *  closing must never get stuck behind it, so after a moment `fallback` asks instead.
 *  `T` names the window a question is for; with none given, `send` picks the main window. */
export class AppDialogs<T = unknown> {
  private nextId = 1
  private readonly pending = new Map<number, Pending<T>>()

  constructor(
    private readonly send: (request: MainDialogRequest, to: T | undefined) => void,
    private readonly fallback: (request: MainDialogRequest, to: T | undefined) => Promise<number>,
    private readonly shownWithinMs: number = SHOWN_WITHIN_MS
  ) {}

  ask(question: Omit<MainDialogRequest, 'id'>, to?: T): Promise<number> {
    const request: MainDialogRequest = { ...question, id: this.nextId++ }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        void this.fallback(request, to).then(resolve, () => resolve(request.cancelIndex))
      }, this.shownWithinMs)
      this.pending.set(request.id, { request, to, resolve, timer })
      try {
        this.send(request, to)
      } catch {
        // The window has gone. The timer hands this to the fallback.
      }
    })
  }

  shown(id: number): void {
    const entry = this.pending.get(id)
    if (entry === undefined || entry.timer === null) return
    clearTimeout(entry.timer)
    entry.timer = null
  }

  answer(id: number, index: number): void {
    const entry = this.pending.get(id)
    if (entry === undefined || !Number.isInteger(index) || index < 0 || index >= entry.request.buttons.length) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(index)
  }

  /** One window went: its questions take their cancel answer. */
  cancelFor(to: T): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.to !== to) continue
      if (entry.timer !== null) clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.resolve(entry.request.cancelIndex)
    }
  }

  /** The window went: nobody is left to answer, so each question takes its cancel answer. */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.resolve(entry.request.cancelIndex)
    }
    this.pending.clear()
  }
}
