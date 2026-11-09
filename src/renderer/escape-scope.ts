/** Just what the check needs of an element, so it can be tested without a page. */
export type EscapeScopeElement = {
  contains(other: unknown): boolean
  closest(selector: string): EscapeScopeElement | null
}
export type EscapeDoc = { body: unknown; activeElement: unknown }

/** Whether an Esc is for the dialog that goes in `target` (from useDialogTarget). In the main
 *  window the target is the page, and every Esc is the dialog's, as it always was. A split
 *  pane gives its own box: there an Esc is the dialog's only when it was pressed in that
 *  pane, so Esc in one pane doesn't close another pane's dialog. A pane's dialog can open
 *  with the focus left in its message box, so the whole pane counts, not just the box. */
export function escapeIsFor(target: EscapeScopeElement, event: { target: unknown }, doc: EscapeDoc = document): boolean {
  if (target === doc.body) return true
  const scope = target.closest('[data-pane]') ?? target
  const inside = (n: unknown): boolean => n !== null && n !== undefined && scope.contains(n)
  return inside(event.target) || inside(doc.activeElement)
}
