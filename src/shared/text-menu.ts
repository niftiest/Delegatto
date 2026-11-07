/** The right-click menu for text: copying, links and spelling. Chromium says what's under
 *  the pointer, including what Windows' spell checker suggests, and the window draws it. */

export type TextMenuRequest = {
  x: number
  y: number
  linkUrl: string | null
  editable: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  misspelled: string | null
  suggestions: string[]
}

export type TextMenuAction =
  | { kind: 'copy' | 'cut' | 'paste' | 'copyLink' | 'addWord' }
  | { kind: 'replace'; word: string }

/** The part of Electron's context-menu details this reads. */
export type ContextMenuDetails = {
  x: number
  y: number
  linkURL: string
  selectionText: string
  isEditable: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean }
}

const MAX_SUGGESTIONS = 5
const COPYABLE_LINK = /^(https?:|mailto:)/i

/** What the menu should offer here, or null if there's nothing to offer. */
export function textMenuRequest(details: ContextMenuDetails): TextMenuRequest | null {
  const linkUrl = COPYABLE_LINK.test(details.linkURL) ? details.linkURL : null
  const selected = details.selectionText.trim().length > 0
  const misspelled = details.misspelledWord.length > 0 ? details.misspelledWord : null
  if (linkUrl === null && !selected && !details.isEditable) return null
  return {
    x: details.x,
    y: details.y,
    linkUrl,
    editable: details.isEditable,
    canCut: details.isEditable && details.editFlags.canCut,
    canCopy: selected,
    canPaste: details.isEditable && details.editFlags.canPaste,
    misspelled,
    suggestions: misspelled === null ? [] : details.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)
  }
}
