/** A question main asks through the app's own window, so it looks like the rest of the app. */
export type AppDialogRequest = {
  id: number
  title: string
  /** Paragraphs under the title. */
  detail: string[]
  /** A short list between the paragraphs and the buttons, such as the chats a choice affects. */
  items?: string[]
  /** Options to pick before answering: a dropdown when `count` is 1, otherwise a checkbox list
   *  where exactly `count` must be checked. Until then every button but `cancelIndex` is
   *  disabled. `selected` holds the option indexes picked at the start. Only a window's own
   *  questions (askChoiceInApp) get the picks back. */
  choice?: { label: string; options: string[]; count: number; selected: number[] }
  /** In display order, left to right. */
  buttons: Array<{ label: string; kind: 'primary' | 'secondary' | 'danger' }>
  /** The button that starts focused, so Enter presses it. */
  defaultIndex: number
  /** What Esc answers. */
  cancelIndex: number
}

export type AppDialogChoice = NonNullable<AppDialogRequest['choice']>

/** A question main asks. Main only hears which button was pressed, never the picks, so its
 *  questions can't have a choice. */
export type MainDialogRequest = Omit<AppDialogRequest, 'choice'> & { choice?: never }

/** Whether the picks are exactly `count` different options. */
export function choiceReady(choice: AppDialogChoice, picked: readonly number[]): boolean {
  const set = new Set(picked)
  return set.size === picked.length && set.size === choice.count && picked.every(i => Number.isInteger(i) && i >= 0 && i < choice.options.length)
}

/** The picks after the user chooses option `index`: it replaces the pick when one is asked
 *  for, otherwise it is checked or unchecked. Kept in option order. */
export function toggleChoice(picked: readonly number[], index: number, count: number): number[] {
  if (count === 1) return [index]
  const next = picked.includes(index) ? picked.filter(i => i !== index) : [...picked, index]
  return next.sort((a, b) => a - b)
}
