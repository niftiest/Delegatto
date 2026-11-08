import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, powerMonitor, safeStorage, type IpcMainInvokeEvent } from 'electron'
import type { Catalog } from './catalog/db'
import { getEngineSessionInfo } from './catalog/repos'
import { getSettings, updateSettings } from './catalog/settings'
import type { EngineIpcHandle } from './engine/engine-ipc'
import { githubStatus, ghPath, privateReposWithFile, realRunner, cleanOutput, type Runner } from './engine/github'
import { getLiveSessions } from './manage/live'
import { defaultPaths, type ClaudePaths } from './manage/paths'
import { SyncService, type KeyStore, type SyncHub } from './sync/service'
import { SYNC_IPC, type FindingDecisions, type SyncChatInfo } from '../shared/sync-types'

/** Electron boundary for project sync: the user's own `gh` for GitHub, Windows' own
 *  protection for the key on this PC, timers, and the window. */

const CHECK_EVERY_MS = 90_000
const FIRST_CHECK_MS = 20_000
const AFTER_TURN_MS = 5_000
const BEFORE_SEND_WAIT_MS = 2_000

function repoApiError(text: string): boolean {
  return /HTTP 404|Not Found/i.test(text)
}

export function githubHub(run: Runner): SyncHub {
  return {
    async status() {
      // Sync drives git itself, and gh can be installed without it.
      const git = await run('git', ['--version']).catch(() => null)
      if (git === null || git.code !== 0) return { state: 'missing', account: null }
      return githubStatus(run)
    },
    async view(repo) {
      const r = await run('gh', ['api', `repos/${repo}`, '--jq', '.private'])
      if (r.code !== 0) {
        if (repoApiError(`${r.stderr}${r.stdout}`)) return { exists: false, isPrivate: null }
        throw new Error(cleanOutput(r.stderr) || `Couldn't look up ${repo}.`)
      }
      return { exists: true, isPrivate: r.stdout.trim() === 'true' }
    },
    async create(repo) {
      const r = await run('gh', ['repo', 'create', repo, '--private', '--description', 'Delegatto project sync'], { timeoutMs: 60_000 })
      if (r.code !== 0) throw new Error(`Couldn't create ${repo}: ${cleanOutput(r.stderr) || 'gh gave no reason.'}`)
    },
    async sizeBytes(repo) {
      const r = await run('gh', ['api', `repos/${repo}`, '--jq', '.size'])
      const kb = Number(r.stdout.trim())
      // GitHub takes a while to count a new repo, and says 0 until then.
      return r.code === 0 && Number.isFinite(kb) && kb > 0 ? kb * 1024 : null
    },
    async header(repo) {
      const r = await run('gh', ['api', `repos/${repo}/contents/delegatto-sync.json`, '--jq', '.content'])
      if (r.code !== 0) {
        // An empty repo answers 404 as well.
        if (repoApiError(`${r.stderr}${r.stdout}`) || /empty/i.test(r.stderr)) return null
        throw new Error(cleanOutput(r.stderr) || `Couldn't read ${repo}.`)
      }
      return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64').toString('utf8')
    },
    privateReposWithFile: file => privateReposWithFile(run, file)
  }
}

/** The key and its recovery key, kept so only this Windows account can read them. Encryption
 *  guards the copy on GitHub; anyone who can read these files can already read the chats here. */
function protectedKeyStore(file: string, recoveryFile: string): KeyStore {
  const read = (path: string): string | null => {
    try {
      return safeStorage.decryptString(readFileSync(path))
    } catch {
      return null
    }
  }
  return {
    load() {
      const text = read(file)
      return text === null ? null : Buffer.from(text, 'base64')
    },
    loadRecovery: () => read(recoveryFile),
    canSave: () => safeStorage.isEncryptionAvailable(),
    save(key, recoveryKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows can't protect the sync key on this PC.")
      writeFileSync(file, safeStorage.encryptString(key.toString('base64')))
      if (recoveryKey === null) rmSync(recoveryFile, { force: true })
      else writeFileSync(recoveryFile, safeStorage.encryptString(recoveryKey))
    },
    clear() {
      rmSync(file, { force: true })
      rmSync(recoveryFile, { force: true })
    }
  }
}

function credentialArgs(): string[] {
  const gh = ghPath().replace(/\\/g, '/')
  // Uses the sign-in gh already holds, so no token is stored here or in the repo's config.
  return ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=!"${gh}" auth git-credential`]
}

export type SyncIpcHandle = {
  dispose(): void
  turnEnded(sessionPk: number): void
  projectFolderRenamed(fromEncoded: string, toEncoded: string): Promise<void>
}

export function registerSyncIpc(db: Catalog, window: BrowserWindow, engine: EngineIpcHandle, paths: ClaudePaths = defaultPaths()): SyncIpcHandle {
  const dataDir = app.getPath('userData')
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }

  let pushTimer: NodeJS.Timeout | null = null
  const service: SyncService = new SyncService({
    paths,
    run: realRunner,
    hub: githubHub(realRunner),
    keys: protectedKeyStore(join(dataDir, 'sync-key.bin'), join(dataDir, 'sync-recovery-key.bin')),
    dataDir,
    hostname: process.env.COMPUTERNAME ?? hostname(),
    remoteUrl: repo => `https://github.com/${repo}.git`,
    credentialArgs: credentialArgs(),
    isChatBusy: id => engine.busySessionIds().includes(id.toLowerCase()),
    isChatOpen: id => engine.ownedProcesses().some(o => o.sessionId.toLowerCase() === id.toLowerCase()),
    isExternallyLive: id => {
      const owned = new Set(engine.ownedProcesses().map(o => o.pid))
      return getLiveSessions(paths).some(s => s.sessionId.toLowerCase() === id.toLowerCase() && !owned.has(s.pid))
    },
    stopChat: id => { engine.stopOwned([id]) },
    afterLocalChange: () => engine.resync(),
    sessionPkOf: file => {
      const row = db.prepare('SELECT id FROM sessions WHERE file_path = ? COLLATE NOCASE').get(file) as { id: number } | undefined
      return row?.id ?? null
    },
    setChatTitle: (file, title) => {
      db.prepare('UPDATE sessions SET title = ? WHERE file_path = ? COLLATE NOCASE').run(title.slice(0, 120), file)
    },
    trustFolder: folder => {
      const current = getSettings(db).trustedFolders
      if (!current.includes(folder)) updateSettings(db, { trustedFolders: [...current, folder] })
    },
    onChange: () => {
      // Coalesced: the status walks the project folders.
      if (pushTimer !== null) return
      pushTimer = setTimeout(() => {
        pushTimer = null
        void service.status().then(s => send(SYNC_IPC.changed, s)).catch(err => console.error('[sync] status failed', err))
      }, 250)
    }
  })

  const infoFor = (pk: number): { sessionId: string; cwd: string } | null => {
    const info = getEngineSessionInfo(db, pk)
    return info === null ? null : { sessionId: info.resumeId, cwd: info.cwd }
  }
  const noInfo: SyncChatInfo = { synced: false, elsewhere: null, conflict: null, pendingSecrets: 0, codeNote: null }
  const noDecisions: FindingDecisions = { redact: [], allow: [], excludeChats: [] }
  const decisionsOf = (d: FindingDecisions | undefined): FindingDecisions => ({
    redact: Array.isArray(d?.redact) ? d.redact : noDecisions.redact,
    allow: Array.isArray(d?.allow) ? d.allow : noDecisions.allow,
    excludeChats: Array.isArray(d?.excludeChats) ? d.excludeChats : noDecisions.excludeChats
  })

  const handlers: Record<string, (e: IpcMainInvokeEvent, ...args: never[]) => unknown> = {
    [SYNC_IPC.status]: () => service.status(),
    [SYNC_IPC.findRepo]: (_e, name: string) => service.findRepo(String(name ?? '')),
    [SYNC_IPC.setupNew]: (_e, o: { name: string; encrypted: boolean }) => service.setupNew({ name: String(o?.name ?? ''), encrypted: o?.encrypted !== false }),
    [SYNC_IPC.setupExisting]: (_e, o: { name: string; recoveryKey: string }) => service.setupExisting({ name: String(o?.name ?? ''), recoveryKey: String(o?.recoveryKey ?? '') }),
    [SYNC_IPC.setDeviceName]: (_e, name: string) => service.setDeviceName(String(name ?? '')),
    [SYNC_IPC.setAuto]: (_e, on: boolean) => service.setAuto(on === true),
    [SYNC_IPC.scanProject]: (e, dir: string) => {
      const sender = e.sender
      return service.scanProjectFor(String(dir ?? ''), p => { if (!sender.isDestroyed()) sender.send(SYNC_IPC.scanProgress, p) })
    },
    [SYNC_IPC.enableProject]: (e, dir: string, d: FindingDecisions) => {
      const sender = e.sender
      return service.enableProject(String(dir ?? ''), decisionsOf(d), p => { if (!sender.isDestroyed()) sender.send(SYNC_IPC.enableProgress, p) })
    },
    [SYNC_IPC.disableProject]: (_e, id: string) => service.disableProject(String(id ?? '')),
    [SYNC_IPC.linkProject]: (_e, id: string, folder: string) => service.linkProject(String(id ?? ''), String(folder ?? '')),
    [SYNC_IPC.syncNow]: () => service.syncNow(),
    [SYNC_IPC.decideFindings]: (_e, id: string, d: FindingDecisions) => service.decideFindings(String(id ?? ''), decisionsOf(d)),
    [SYNC_IPC.resolveConflict]: (_e, id: string) => service.resolveConflict(String(id ?? '')),
    [SYNC_IPC.chatInfo]: (_e, pk: number) => {
      const i = infoFor(pk)
      return i === null ? noInfo : service.chatInfo(i.sessionId, i.cwd)
    },
    [SYNC_IPC.beforeSend]: (_e, pk: number) => {
      const i = infoFor(pk)
      return i === null ? noInfo : service.beforeSend(i.sessionId, i.cwd, BEFORE_SEND_WAIT_MS)
    },
    [SYNC_IPC.removeFromGithub]: (_e, id: string) => service.removeFromGithub(String(id ?? '')),
    [SYNC_IPC.startFresh]: () => service.startFresh(),
    [SYNC_IPC.recoveryKey]: () => service.recoveryKey(),
    [SYNC_IPC.replaceRecoveryKey]: () => service.replaceRecoveryKey(),
    [SYNC_IPC.disconnect]: () => service.disconnect()
  }
  for (const [channel, fn] of Object.entries(handlers)) ipcMain.handle(channel, fn as (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown)

  const onChatOpened = (_e: unknown, pk: number | null): void => {
    service.chatOpened(typeof pk === 'number' ? infoFor(pk)?.sessionId ?? null : null)
  }
  ipcMain.on(SYNC_IPC.chatOpened, onChatOpened)

  const check = (): void => { void service.tick() }
  const first = setTimeout(check, FIRST_CHECK_MS)
  const every = setInterval(check, CHECK_EVERY_MS)
  powerMonitor.on('resume', check)

  let afterTurn: NodeJS.Timeout | null = null
  return {
    turnEnded() {
      if (afterTurn !== null) clearTimeout(afterTurn)
      afterTurn = setTimeout(check, AFTER_TURN_MS)
    },
    projectFolderRenamed: (from, to) => service.projectFolderRenamed(from, to),
    dispose() {
      clearTimeout(first)
      clearInterval(every)
      if (afterTurn !== null) clearTimeout(afterTurn)
      if (pushTimer !== null) clearTimeout(pushTimer)
      powerMonitor.removeListener('resume', check)
      ipcMain.removeListener(SYNC_IPC.chatOpened, onChatOpened)
      for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    }
  }
}
