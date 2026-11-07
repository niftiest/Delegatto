import { clipboard, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { textMenuRequest, type TextMenuAction, type TextMenuRequest } from '../shared/text-menu'

/** Passes right-clicks on text to the window, and carries out what's picked. Only what the
 *  last menu offered can be done, so a stray message can't write just anything. */
export function registerTextMenu(win: BrowserWindow): () => void {
  const contents = win.webContents
  let offered: TextMenuRequest | null = null

  const onContextMenu = (_e: Electron.Event, details: Electron.ContextMenuParams): void => {
    // Even with nothing here to offer: the window may have something, like pinning a message.
    offered = textMenuRequest(details) ?? { x: details.x, y: details.y, linkUrl: null, editable: false, canCut: false, canCopy: false, canPaste: false, misspelled: null, suggestions: [] }
    contents.send(IPC.textMenuOpen, offered)
  }
  contents.on('context-menu', onContextMenu)

  const onAction = (e: Electron.IpcMainEvent, action: TextMenuAction): void => {
    if (e.sender !== contents || offered === null) return
    const menu = offered
    offered = null
    switch (action.kind) {
      case 'copy': contents.copy(); break
      case 'cut': contents.cut(); break
      case 'paste': contents.paste(); break
      case 'copyLink': if (menu.linkUrl !== null) clipboard.writeText(menu.linkUrl); break
      case 'addWord': if (menu.misspelled !== null) contents.session.addWordToSpellCheckerDictionary(menu.misspelled); break
      case 'replace': if (menu.suggestions.includes(action.word)) contents.replaceMisspelling(action.word); break
    }
  }
  ipcMain.on(IPC.textMenuAction, onAction)

  return () => {
    if (!contents.isDestroyed()) contents.off('context-menu', onContextMenu)
    ipcMain.removeListener(IPC.textMenuAction, onAction)
  }
}
