import type { AppDialogRequest } from '../shared/app-dialog'

/** How long the window gets to say it's showing a question before a native box takes over. */
const SHOWN_WITHIN_MS = 1500

type Pending = { request: AppDialogRequest; resolve: (index: number) => void; timer: ReturnType<typeof setTimeout> | null }

/** Asks questions in the app's own window. A window that has crashed or hung can't answer, and
 *  closing must never get stuck behind it, so after a moment `fallback` asks instead. */
export class AppDialogs {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly send: (request: AppDialogRequest) => void,
    private readonly fallback: (request: AppDialogRequest) => Promise<number>,
    private readonly shownWithinMs: number = SHOWN_WITHIN_MS
  ) {}

  ask(question: Omit<AppDialogRequest, 'id'>): Promise<number> {
    const request: AppDialogRequest = { ...question, id: this.nextId++ }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        void this.fallback(request).then(resolve, () => resolve(request.cancelIndex))
      }, this.shownWithinMs)
      this.pending.set(request.id, { request, resolve, timer })
      try {
        this.send(request)
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

  /** The window went: nobody is left to answer, so each question takes its cancel answer. */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.resolve(entry.request.cancelIndex)
    }
    this.pending.clear()
  }
}
