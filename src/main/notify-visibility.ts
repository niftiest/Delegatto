import type { ChatVisibility } from './chat-visibility'

/** Whether a desktop notification for a chat is left out: only when the focused window shows
 *  that chat, since the user is looking at it there. Pure: no electron. */
export function suppressNotification(pk: number, focusedWindowId: number | null, visibility: ChatVisibility): boolean {
  return focusedWindowId !== null && visibility.visibleIn(focusedWindowId, pk)
}
