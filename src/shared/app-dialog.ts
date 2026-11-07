/** A question main asks through the app's own window, so it looks like the rest of the app. */
export type AppDialogRequest = {
  id: number
  title: string
  /** Paragraphs under the title. */
  detail: string[]
  /** A short list between the paragraphs and the buttons, such as the chats a choice affects. */
  items?: string[]
  /** In display order, left to right. */
  buttons: Array<{ label: string; kind: 'primary' | 'secondary' | 'danger' }>
  /** The button that starts focused, so Enter presses it. */
  defaultIndex: number
  /** What Esc answers. */
  cancelIndex: number
}
