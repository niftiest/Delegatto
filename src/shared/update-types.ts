/** Self-update surface (renderer <-> main). Installed and portable builds both
 *  check GitHub Releases for new versions, download one only when the user clicks
 *  Download, and then restart into it; development runs don't update at all. */

export const UPDATE_IPC = {
  getStatus: 'update:getStatus',
  check: 'update:check',
  install: 'update:install',
  download: 'update:download',
  setHold: 'update:setHold',
  work: 'update:work',
  restartWhenFinished: 'update:restartWhenFinished',
  cancelRestart: 'update:cancelRestart',
  openDownload: 'update:openDownload',
  setOpenChat: 'update:setOpenChat',
  takeResumedChat: 'update:takeResumedChat',
  status: 'update:status'
} as const

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none'; checkedAt: number }
  /** Found, not downloaded: waiting for the user to click Download. With `reason`, it
   *  can't be downloaded from here (why), and `url` is the release page instead. */
  | { state: 'available'; version: string; url: string | null; reason?: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; reason: string }

export type UpdateStatus = UpdateState & {
  currentVersion: string
  channel: 'installer' | 'portable' | 'dev'
  /** This launch is a portable update that just took over from the previous version. */
  justUpdated: boolean
  /** Restarting once this is done, because the user asked for that. */
  restartWaiting: RestartWork | null
}

/** What a restart would interrupt right now. */
export type RestartWork = {
  /** Titles of the chats with a turn or background task running. */
  chats: string[]
  /** A message typed, queued or attached, which only exists in the window. */
  unsent: boolean
}

export function nothingToInterrupt(w: RestartWork): boolean {
  return w.chats.length === 0 && !w.unsent
}

/** What "Restart when finished" is still waiting for. */
export function describeRestartWait(w: RestartWork): string {
  const parts: string[] = []
  if (w.chats.length > 0) parts.push(w.chats.length === 1 ? '1 chat finishes' : `${w.chats.length} chats finish`)
  if (w.unsent) parts.push('your unsent message is sent or cleared')
  return parts.length === 0 ? 'Restarting in a moment' : `Restarts once ${parts.join(' and ')}`
}

/** How long everything has to stay quiet before "Restart when finished" goes ahead. One
 *  turn ending is often followed at once by a queued message or Claude carrying on. */
export const RESTART_SETTLE_MS = 10_000

/** One step of waiting to restart: when things went quiet, and whether that's long enough. */
export function settleForRestart(work: RestartWork, quietSince: number | null, now: number): { quietSince: number | null; restart: boolean } {
  if (!nothingToInterrupt(work)) return { quietSince: null, restart: false }
  const since = quietSince ?? now
  return { quietSince: since, restart: now - since >= RESTART_SETTLE_MS }
}

/** Only restart by itself once nobody has touched the computer for this long. */
export const AWAY_SECONDS = 5 * 60

/** Whether to restart into a downloaded update unasked. A restart interrupts, so it
 *  waits until it can't: nothing running, nothing half-typed, and nobody at the computer. */
export function canRestartForUpdate(c: { autoInstall: boolean; ready: boolean; unsent: boolean; activeWork: number; idleSeconds: number }): boolean {
  return c.autoInstall && c.ready && !c.unsent && c.activeWork === 0 && c.idleSeconds >= AWAY_SECONDS
}

export type UpdateApi = {
  getUpdateStatus(): Promise<UpdateStatus>
  /** Manual "Check for updates". */
  checkForUpdates(): Promise<UpdateStatus>
  /** Restart into a downloaded update, right now. */
  installUpdate(): Promise<void>
  /** Download the version a check found. Nothing is downloaded until this is called. */
  downloadUpdate(): Promise<void>
  /** What restarting now would interrupt. */
  updateRestartWork(): Promise<RestartWork>
  /** Restart once nothing is running and nothing is unsent. */
  restartWhenFinished(): Promise<void>
  /** Stop waiting to restart. */
  cancelUpdateRestart(): Promise<void>
  /** Don't restart by itself for now: there's something unsent in the window. */
  setUpdateHold(hold: boolean): Promise<void>
  /** Which chat is on screen, to come back to after an update. */
  setUpdateOpenChat(chat: { sessionPk: number; projectDir: string } | null): Promise<void>
  /** The chat to reopen if this launch follows an update. Answers once. */
  takeResumedChat(): Promise<{ sessionPk: number; projectDir: string } | null>
  /** Open the release page for a newer version (portable builds, if the download failed). */
  openUpdateDownload(): Promise<void>
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void
}
