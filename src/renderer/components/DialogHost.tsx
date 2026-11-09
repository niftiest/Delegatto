import { createContext, useContext } from 'react'

/** Where a chat's own small dialogs (Rewind, task output, the terminal prompt, the command
 *  screens) go. A split pane gives its own box, so they cover that pane only; with nothing
 *  given they go to the page, as in the main window. */
export const DialogTarget = createContext<HTMLElement | null>(null)

export function useDialogTarget(): HTMLElement {
  return useContext(DialogTarget) ?? document.body
}
