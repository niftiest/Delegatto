import type { Elicitation, LiveEvent } from '../../shared/engine-types'

/** Questions MCP servers are waiting on, by chat, so a window opened after one was asked
 *  still shows it. Claude Code only sends each one once. A question goes when it's answered,
 *  when its request goes away, or when the chat's turn or process ends, which is also when
 *  the renderer drops it. */
export class PendingQuestions {
  private readonly byChat = new Map<number, Elicitation[]>()

  onEvent(sessionPk: number, ev: LiveEvent): void {
    if (ev.kind === 'elicitation') {
      const list = this.byChat.get(sessionPk) ?? []
      if (!list.some(q => q.requestId === ev.request.requestId)) this.byChat.set(sessionPk, [...list, ev.request])
    } else if (ev.kind === 'permissionGone') this.answered(sessionPk, ev.id)
    else if (ev.kind === 'elicitationGone') this.answered(sessionPk, ev.requestId)
    else if (ev.kind === 'exit' || ev.kind === 'result') this.byChat.delete(sessionPk)
  }

  /** The user answered in one window. Returns the event every window gets, so the card goes
   *  from the others too. */
  answer(sessionPk: number, requestId: string): LiveEvent {
    this.answered(sessionPk, requestId)
    return { kind: 'elicitationGone', requestId }
  }

  answered(sessionPk: number, requestId: string): void {
    const list = this.byChat.get(sessionPk)
    if (list === undefined) return
    const left = list.filter(q => q.requestId !== requestId)
    if (left.length > 0) this.byChat.set(sessionPk, left)
    else this.byChat.delete(sessionPk)
  }

  list(): Array<{ sessionPk: number; request: Elicitation }> {
    return [...this.byChat].flatMap(([sessionPk, list]) => list.map(request => ({ sessionPk, request })))
  }
}
