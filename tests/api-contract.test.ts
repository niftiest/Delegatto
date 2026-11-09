import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc'
import { ENGINE_IPC } from '../src/shared/engine-ipc-contract'

const root = join(__dirname, '..')
const ipcSrc = readFileSync(join(root, 'src/main/ipc.ts'), 'utf8')
const engineIpcSrc = readFileSync(join(root, 'src/main/engine/engine-ipc.ts'), 'utf8')
const preloadSrc = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
const mainSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8')

// invoke-style channels: renderer calls ipcRenderer.invoke, main answers with ipcMain.handle.
const INVOKE_KEYS = [
  'listProjects', 'listSessions', 'loadTranscript', 'listSubagents', 'search', 'indexRun',
  // Channel metadata (Plan 3 Task 2) -- rename/favorite/group/icon.
  'listChannels', 'listGroups', 'setFriendlyName', 'setStarred', 'setChannelIcon', 'setChannelGroup',
  'createGroup', 'renameGroup', 'deleteGroup'
] as const

// fire-and-forget command channels: renderer calls ipcRenderer.send, main
// listens with ipcMain.on (no reply -- EngineApi's send/interrupt/
// resolvePermission all return void).
const ENGINE_COMMAND_KEYS = ['send', 'interrupt', 'resolvePermission'] as const

// invoke-style engine channels (Task 8): renderer calls ipcRenderer.invoke,
// main answers with ipcMain.handle -- newChat/pickDirectory both need a
// reply (the new session's ids, or the chosen folder), unlike the
// fire-and-forget command channels above.
const ENGINE_INVOKE_KEYS = ['newChat', 'pickDirectory', 'pendingPermissions', 'pendingQuestions'] as const

// broadcast channels: main pushes to every window with hub.send, renderer subscribes
// with ipcRenderer.on.
const ENGINE_BROADCAST_KEYS = ['event', 'rows', 'permission', 'indexed'] as const

describe('IPC contract', () => {
  it('registers a main-process handler for every invoke-style channel the preload calls', () => {
    for (const key of INVOKE_KEYS) {
      expect(ipcSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*IPC\\.${key}\\b`))
      expect(preloadSrc).toContain(`IPC.${key}`)
    }
  })

  it('broadcasts index progress on the channel the preload subscribes to', () => {
    expect(ipcSrc).toMatch(/hub\.send\(\s*IPC\.indexProgress\b/)
    expect(preloadSrc).toMatch(/ipcRenderer\.on\(\s*IPC\.indexProgress\b/)
  })

  it('exposes exactly the channels declared in IPC — no more, no fewer', () => {
    // \b (not a bare /IPC\./) so this doesn't also match ENGINE_IPC.* --
    // "_" is a word character, so there's no word boundary between it and
    // the "I" of "IPC" in "ENGINE_IPC", but there is one before a
    // standalone "IPC.".
    const referenced = new Set([...preloadSrc.matchAll(/\bIPC\.(\w+)/g)].map(m => m[1]))
    expect(referenced).toEqual(new Set(Object.keys(IPC)))
  })

  it('records the chats each window reports on the visibleChats channel', () => {
    expect(mainSrc).toMatch(/ipcMain\.on\(\s*IPC\.visibleChats\b/)
    expect(preloadSrc).toMatch(/ipcRenderer\.send\(\s*IPC\.visibleChats\b/)
  })

  it('broadcasts every window\'s shown chats on the visibleChatsChanged channel', () => {
    expect(mainSrc).toMatch(/hub\.send\(\s*IPC\.visibleChatsChanged\b/)
    expect(preloadSrc).toMatch(/ipcRenderer\.on\(\s*IPC\.visibleChatsChanged\b/)
  })

  it('broadcasts saved settings on the settingsChanged channel', () => {
    expect(mainSrc).toMatch(/hub\.send\(\s*IPC\.settingsChanged\b/)
    expect(preloadSrc).toMatch(/ipcRenderer\.on\(\s*IPC\.settingsChanged\b/)
  })

  it('handles every split view channel the preload calls, and broadcasts its state to every window', () => {
    const splitSrc = readFileSync(join(root, 'src/main/split-window.ts'), 'utf8')
    for (const key of ['splitViewOpen', 'splitViewGet', 'splitViewSetLayout', 'splitViewSetPane', 'splitViewSetRatios', 'splitViewSwap']) {
      expect(splitSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*IPC\\.${key}\\b`))
      expect(preloadSrc).toMatch(new RegExp(`ipcRenderer\\.invoke\\(\\s*IPC\\.${key}\\b`))
    }
    expect(splitSrc).toMatch(/hub\.send\(\s*IPC\.splitViewChanged\b/)
    expect(preloadSrc).toMatch(/ipcRenderer\.on\(\s*IPC\.splitViewChanged\b/)
  })

  it('brings the main window forward for a pane, and hands the action to the main window only', () => {
    const splitSrc = readFileSync(join(root, 'src/main/split-window.ts'), 'utf8')
    expect(splitSrc).toMatch(/ipcMain\.on\(\s*IPC\.focusMain\b/)
    expect(preloadSrc).toMatch(/ipcRenderer\.send\(\s*IPC\.focusMain\b/)
    expect(splitSrc).toMatch(/main\.webContents\.send\(\s*IPC\.mainAction\b/)
    expect(splitSrc).not.toMatch(/hub\.send\(\s*IPC\.mainAction\b/)
    expect(preloadSrc).toMatch(/ipcRenderer\.on\(\s*IPC\.mainAction\b/)
  })

  it('creates the split window with nodeIntegration disabled and contextIsolation enabled', () => {
    const splitSrc = readFileSync(join(root, 'src/main/split-window.ts'), 'utf8')
    expect(splitSrc).toMatch(/contextIsolation:\s*true/)
    expect(splitSrc).toMatch(/nodeIntegration:\s*false/)
  })

  it('no longer has the one-chat sync presence channel', () => {
    const syncTypes = readFileSync(join(root, 'src/shared/sync-types.ts'), 'utf8')
    const syncIpcSrc = readFileSync(join(root, 'src/main/sync-ipc.ts'), 'utf8')
    for (const src of [syncTypes, syncIpcSrc, preloadSrc]) expect(src).not.toMatch(/chatOpened|syncChatOpened/)
  })

  it('creates the window with nodeIntegration disabled and contextIsolation enabled', () => {
    expect(mainSrc).toMatch(/contextIsolation:\s*true/)
    expect(mainSrc).toMatch(/nodeIntegration:\s*false/)
  })
})

describe('Engine IPC contract', () => {
  it('registers a main-process listener for every fire-and-forget command channel the preload sends', () => {
    for (const key of ENGINE_COMMAND_KEYS) {
      expect(engineIpcSrc).toMatch(new RegExp(`ipcMain\\.on\\(\\s*ENGINE_IPC\\.${key}\\b`))
      expect(preloadSrc).toMatch(new RegExp(`ipcRenderer\\.send\\(\\s*ENGINE_IPC\\.${key}\\b`))
    }
  })

  it('registers a main-process handler for every invoke-style engine channel the preload calls', () => {
    for (const key of ENGINE_INVOKE_KEYS) {
      expect(engineIpcSrc).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*ENGINE_IPC\\.${key}\\b`))
      expect(preloadSrc).toMatch(new RegExp(`ipcRenderer\\.invoke\\(\\s*ENGINE_IPC\\.${key}\\b`))
    }
  })

  it('keeps the questions MCP servers ask, and forgets one once it is answered, in every window', () => {
    expect(engineIpcSrc).toMatch(/questions\.onEvent\(\s*sessionPk,\s*e\s*\)/)
    // The answer goes to every window, so the card leaves the other one too.
    expect(engineIpcSrc).toMatch(/hub\.send\(\s*ENGINE_IPC\.event,\s*sessionPk,\s*questions\.answer\(\s*sessionPk,\s*requestId\s*\)\s*\)/)
  })

  it('broadcasts every live channel the preload subscribes to', () => {
    for (const key of ENGINE_BROADCAST_KEYS) {
      expect(engineIpcSrc).toMatch(new RegExp(`hub\\.send\\(\\s*ENGINE_IPC\\.${key}\\b`))
      expect(preloadSrc).toMatch(new RegExp(`ipcRenderer\\.on\\(\\s*ENGINE_IPC\\.${key}\\b`))
    }
  })

  it('exposes exactly the channels declared in ENGINE_IPC — no more, no fewer', () => {
    const referenced = new Set([...preloadSrc.matchAll(/ENGINE_IPC\.(\w+)/g)].map(m => m[1]))
    expect(referenced).toEqual(new Set(Object.keys(ENGINE_IPC)))
  })

  it('the preload module keeps nodeIntegration:false / contextIsolation:true intact (unchanged by the engine wiring)', () => {
    expect(mainSrc).toMatch(/contextIsolation:\s*true/)
    expect(mainSrc).toMatch(/nodeIntegration:\s*false/)
  })
})
