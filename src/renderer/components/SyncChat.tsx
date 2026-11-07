import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { syncOffer, type SyncChatInfo, type SyncConflict, type SyncOffer, type SyncStatus } from '../../shared/sync-types'

const NOTHING: SyncChatInfo = { synced: false, elsewhere: null, conflict: null, pendingSecrets: 0, codeNote: null }

export function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** What sync knows about the open chat. Stays current as sync runs. */
export function useSyncChat(sessionPk: number | null) {
  const [info, setInfo] = useState<SyncChatInfo>(NOTHING)
  const [conflicts, setConflicts] = useState<SyncConflict[]>([])
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const bypass = useRef(false)

  const refresh = useCallback(() => {
    if (sessionPk === null) { setInfo(NOTHING); return }
    void api.syncChatInfo(sessionPk).then(setInfo).catch(() => setInfo(NOTHING))
  }, [sessionPk])

  useEffect(() => {
    refresh()
    api.syncChatOpened(sessionPk)
    return api.onSyncChanged(s => {
      setConflicts(s.conflicts)
      refresh()
    })
  }, [sessionPk, refresh])
  useEffect(() => { void api.syncStatus().then(s => setConflicts(s.conflicts)).catch(() => {}) }, [])

  /** The open chat's first, then any other chat: being out of sync shouldn't wait to be noticed. */
  const showing = [info.conflict, ...conflicts].find((c): c is SyncConflict => c !== null && !dismissed.has(c.sessionId)) ?? null
  // Stays up after the chats are separated, because its second page reports what happened
  // and a held message is still waiting on it.
  const [pinned, setPinned] = useState<SyncConflict | null>(null)
  useEffect(() => { if (showing !== null) setPinned(p => p ?? showing) }, [showing])
  return {
    info,
    conflict: pinned,
    setInfo,
    refresh,
    bypass,
    finish: () => setPinned(null),
    dismiss: (id: string) => {
      setDismissed(d => new Set(d).add(id))
      setPinned(null)
    },
    /** Asks again, such as when a message is sent to a chat that was put off with Later. */
    undismiss: (id: string) => setDismissed(d => { const n = new Set(d); n.delete(id); return n })
  }
}

/** One line under the chat header when another PC or a decision matters here. */
export function SyncChatBanner({ info, onOpenSettings }: { info: SyncChatInfo; onOpenSettings: () => void }) {
  const lines: Array<{ key: string; text: string; warn?: boolean; action?: boolean }> = []
  if (info.elsewhere !== null) {
    const who = info.elsewhere.device === info.elsewhere.hostname ? info.elsewhere.device : `${info.elsewhere.device} (${info.elsewhere.hostname})`
    lines.push({
      key: 'elsewhere',
      text: info.elsewhere.active
        ? `Open on ${who}, last seen ${ago(info.elsewhere.lastSeenAt)}. Sending from both at once will split this chat.`
        : `Last seen on ${who} ${ago(info.elsewhere.lastSeenAt)}.`,
      warn: info.elsewhere.active
    })
  }
  if (info.conflict !== null) {
    lines.push({ key: 'conflict', text: `Out of sync with ${info.conflict.otherDevice}. This chat isn’t uploading until you choose.`, warn: true, action: true })
  }
  if (info.pendingSecrets > 0) {
    lines.push({ key: 'secrets', text: `Not uploading: ${info.pendingSecrets} likely secret${info.pendingSecrets === 1 ? '' : 's'} in this chat need a decision.`, warn: true, action: true })
  }
  if (info.codeNote !== null) lines.push({ key: 'code', text: info.codeNote })
  if (lines.length === 0) return null
  return (
    <div className="sync-banner">
      {lines.map(l => (
        <div key={l.key} className={l.warn === true ? 'sync-banner-line warn' : 'sync-banner-line'}>
          <span>{l.text}</span>
          {l.action === true && <button type="button" className="sync-banner-action" onClick={onOpenSettings}>Review</button>}
        </div>
      ))}
    </div>
  )
}

/** The chat changed on two PCs. Nothing is lost whichever button is pressed. */
export function SyncConflictDialog({ conflict, heldMessage, onLater, onResolved, onOpenChat }: {
  conflict: SyncConflict
  heldMessage: boolean
  onLater: () => void
  onResolved: () => void
  onOpenChat: (sessionPk: number, projectDir: string) => void
}) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ summary: string; pk: number | null; branchPk: number | null; projectDir: string } | null>(null)

  async function resolve(): Promise<void> {
    setWorking(true)
    setError(null)
    const r = await api.syncResolveConflict(conflict.sessionId)
    setWorking(false)
    if (r.ok) setDone({ summary: r.summary, pk: r.sessionPk, branchPk: r.branchPk, projectDir: r.projectDir })
    else setError(r.error)
  }

  if (done !== null) {
    return (
      <div className="modal-overlay">
        <div className="modal sync-dialog">
          <h2 className="modal-title">Both versions are kept</h2>
          <p className="settings-note">This chat now continues from what {conflict.otherDevice} synced. Your messages from this PC are in their own chat, labeled “from” this PC, in the same project.</p>
          <p className="settings-note">You can tell Claude what happened here too. It goes in as a clearly labeled report, because Claude in this chat never saw that work.</p>
          <pre className="sync-summary">{done.summary}</pre>
          <div className="modal-actions">
            {done.branchPk !== null && (
              <button type="button" className="btn-secondary" onClick={() => { onResolved(); onOpenChat(done.branchPk!, done.projectDir) }}>Open that chat</button>
            )}
            <button type="button" className="btn-secondary" onClick={onResolved}>Don’t add it</button>
            <button type="button" className="btn-primary" disabled={done.pk === null} onClick={() => {
              if (done.pk !== null) api.send(done.pk, done.summary, [])
              onResolved()
            }}>Add the report to this chat</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay">
      <div className="modal sync-dialog">
        <h2 className="modal-title">Stop: this chat is out of sync</h2>
        <p className="settings-note">“{conflict.title}” changed on {conflict.otherDevice} {ago(conflict.otherAt)} while it also changed here. This PC has {conflict.localRows} new row{conflict.localRows === 1 ? '' : 's'} and {conflict.otherDevice} has {conflict.remoteRows}.</p>
        <p className="settings-note">Claude’s replies on each PC were written without seeing the other’s, so they can’t be stitched into one history. The version already synced stays as this chat, and yours becomes its own chat, so nothing is lost.</p>
        {heldMessage && <p className="settings-note">The message you just sent is held and goes to this chat once they’re separated.</p>}
        {error !== null && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" disabled={working} onClick={onLater}>Later</button>
          <button type="button" className="btn-primary" disabled={working} onClick={() => void resolve()}>{working ? 'Separating…' : 'Keep both'}</button>
        </div>
      </div>
    </div>
  )
}

const DISMISSED_OFFERS = 'cc.sync.dismissedOffers'

function readDismissedOffers(): Set<string> {
  try {
    const list = JSON.parse(window.localStorage.getItem(DISMISSED_OFFERS) ?? '[]') as unknown
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** What's waiting on GitHub for this PC, for the chat list to mention. */
export function useSyncOffer(status: SyncStatus | null): { offer: SyncOffer | null; dismiss: () => void } {
  const [dismissed, setDismissed] = useState(readDismissedOffers)
  const offer = status === null ? null : syncOffer(status, dismissed)
  const dismiss = (): void => {
    if (offer === null) return
    const next = new Set([...dismissed, ...offer.ids])
    window.localStorage.setItem(DISMISSED_OFFERS, JSON.stringify([...next]))
    setDismissed(next)
  }
  return { offer, dismiss }
}

const UNLINKED_CHECK_MS = 5 * 60_000

/** Sync's current state, for anything outside Settings that depends on it. */
export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const linkedRef = useRef(false)
  linkedRef.current = status?.configured === true
  useEffect(() => {
    const refresh = (): void => { void api.syncStatus().then(setStatus).catch(() => { /* treated as sync not applying */ }) }
    refresh()
    // Until this PC is linked, asking is what looks for a repo another PC may have just made.
    const timer = setInterval(() => { if (!linkedRef.current) refresh() }, UNLINKED_CHECK_MS)
    const off = api.onSyncChanged(setStatus)
    return () => { clearInterval(timer); off() }
  }, [])
  return status
}
