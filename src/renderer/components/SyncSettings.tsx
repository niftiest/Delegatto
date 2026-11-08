import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { ago } from './SyncChat'
import type {
  EnableProgress, FindingDecisions, ProjectScan, SecretFinding, SyncProjectRow, SyncStatus
} from '../../shared/sync-types'


function size(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(2)} GB`
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Settings > Project sync: connect a private repo, choose projects, set up projects from other PCs. */
export function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [scanning, setScanning] = useState<string | null>(null)
  const [review, setReview] = useState<{ row: SyncProjectRow; scan: ProjectScan } | null>(null)
  const [pending, setPending] = useState<SyncProjectRow | null>(null)
  const [turnedOff, setTurnedOff] = useState<SyncProjectRow[]>([])

  useEffect(() => {
    void api.syncStatus().then(setStatus)
    return api.onSyncChanged(setStatus)
  }, [])

  if (status === null) return <p className="settings-note">Loading…</p>

  if (recoveryKey !== null) return <RecoveryKeyPanel recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />
  if (status.github.state !== 'ready') return <GithubNeeded state={status.github.state} onRecheck={() => void api.syncStatus().then(setStatus)} />
  if (!status.configured) return <TurnOnPanel account={status.github.account} onKey={setRecoveryKey} />

  const report = (r: { ok: true } | { ok: false; error: string }): void => setMessage(r.ok ? null : r.error)
  const synced = status.projects.filter(p => p.projectId !== null)
  // Ones turned off during this visit stay listed, so a slip can be undone.
  const justOff = turnedOff.filter(p => !synced.some(s => s.workingDir === p.workingDir))

  async function optIn(row: SyncProjectRow): Promise<void> {
    setMessage(null)
    setScanning(row.workingDir)
    try {
      setReview({ row, scan: await api.syncScanProject(row.workingDir) })
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setScanning(null)
    }
  }

  return (
    <>
      <p className="settings-note">
        {status.busy ? `${status.activity ?? 'Working'}…` : status.lastSyncAt === null ? 'Project sync is on.' : `Project sync is on. Last synced ${ago(status.lastSyncAt)}.`}
      </p>
      {status.lastError !== null && <div className="modal-error">{status.lastError}</div>}
      {message !== null && <div className="modal-error">{message}</div>}
      <p className="settings-note">To sync a project, right-click it in the project list and choose <strong>Sync across PCs</strong>. To bring a synced project to this PC, start a New chat and pick it from your GitHub projects: synced ones are marked ⟳.</p>

      {status.conflicts.length > 0 && (
        <>
          <h3 className="settings-sub">Out of sync</h3>
          {status.conflicts.map(c => (
            <div key={c.sessionId} className="sync-row warn">
              <div><strong>{c.title}</strong><div className="settings-note">Changed here and on {c.otherDevice}. Nothing’s lost, and it isn’t uploading until you choose.</div></div>
              <button type="button" className="btn-secondary" disabled={status.busy} onClick={() => void api.syncResolveConflict(c.sessionId).then(r => setMessage(r.ok ? null : r.error))}>Keep both</button>
            </div>
          ))}
        </>
      )}

      <h3 className="settings-sub">Synced projects ({synced.length})</h3>
      {synced.length === 0 && justOff.length === 0 && <p className="settings-note">None yet.</p>}
      {synced.map(p => (
        <div key={p.workingDir} className={p.pendingFindings.length > 0 ? 'sync-row warn' : 'sync-row'}>
          <div>
            <strong>{p.name}</strong>
            <div className="settings-note">{p.workingDir}</div>
            <div className="settings-note">{p.chats} chat{p.chats === 1 ? '' : 's'}, {size(p.sizeBytes)}{p.excludedChats > 0 ? `, ${p.excludedChats} left out` : ''}{p.lastSyncAt !== null ? ` · synced ${ago(p.lastSyncAt)}` : ''}</div>
            {p.pendingFindings.length > 0 && <div className="sync-warn-text">{p.pendingFindings.length} likely secret{p.pendingFindings.length === 1 ? '' : 's'} found. Those chats aren’t uploading until you choose.</div>}
            {p.warnings.map(w => <div key={w} className="sync-warn-text">{w}</div>)}
          </div>
          <div className="sync-actions">
            {p.pendingFindings.length > 0 && <button type="button" className="btn-primary" onClick={() => setPending(p)}>Review</button>}
            <button type="button" className="btn-secondary" disabled={status.busy} title="Stops syncing it on this PC. Your other PCs and the copy on GitHub carry on."
              onClick={() => { setTurnedOff(off => [...off.filter(o => o.workingDir !== p.workingDir), { ...p, projectId: null }]); void api.syncDisableProject(p.projectId!).then(report) }}>
              De-sync
            </button>
          </div>
        </div>
      ))}
      {justOff.map(p => (
        <div key={p.workingDir} className="sync-row">
          <div>
            <strong>{p.name}</strong>
            <div className="settings-note">{p.workingDir}</div>
            <div className="settings-note">Not syncing on this PC. Its chats stay here, and on GitHub for your other PCs.</div>
          </div>
          <div className="sync-actions">
            <button type="button" className="btn-secondary" disabled={scanning !== null || status.busy} onClick={() => void optIn(p)}>
              {scanning === p.workingDir ? 'Checking…' : 'Sync'}
            </button>
          </div>
        </div>
      ))}

      <h3 className="settings-sub">Recovery key</h3>
      {status.hasRecoveryKey
        ? <RecoveryKeyReveal />
        : (
          <>
            <p className="settings-note">This PC doesn’t have the recovery key saved. It was set up before Delegatto kept a copy. If no PC has it, make a new one.</p>
            <DangerButton label="Make a new recovery key" busy={status.busy}
              confirm="This encrypts everything in the sync repo again under a new key, and removes its old history, which used the old key. Your chats stay. Other PCs stop syncing until you disconnect them and link them again with the new key."
              onConfirm={() => void api.syncReplaceRecoveryKey().then(r => { if (r.ok) { setMessage(null); setRecoveryKey(r.recoveryKey) } else setMessage(r.error) })} />
          </>
        )}

      <details className="sync-advanced">
        <summary>Advanced</summary>
        <label className="settings-row">
          <div className="settings-row-label">This PC’s name<span className="settings-hint">Shown on other PCs, as in “Open on {status.deviceName}”.</span></div>
          <input type="text" defaultValue={status.deviceName} placeholder={status.hostname}
            onBlur={e => { void api.syncSetDeviceName(e.target.value) }} />
        </label>
        <label className="settings-row">
          <div className="settings-row-label">Sync automatically<span className="settings-hint">Checks GitHub every minute or two, and after each reply. Off: only when you press Sync now.</span></div>
          <input type="checkbox" checked={status.auto} onChange={e => { void api.syncSetAuto(e.target.checked) }} />
        </label>
        <div className="sync-actions">
          <button type="button" className="btn-secondary" disabled={status.busy} onClick={() => void api.syncNow().then(report)}>Sync now</button>
        </div>
        <p className="settings-note">Sync repo: {status.repo}{status.repoSizeBytes !== null ? `, ${size(status.repoSizeBytes)} on GitHub` : ''}.</p>
        {status.repoSizeBytes !== null && status.repoSizeBytes > 2 ** 30 && (
          <p className="settings-note">GitHub suggests keeping repos under 1 GB. “Start fresh” removes old versions, and syncing fewer projects helps too.</p>
        )}

        {status.devices.length > 0 && (
          <>
            <h3 className="settings-sub">PCs</h3>
            {status.devices.map(d => (
              <div key={d.id} className="sync-row">
                <div><strong>{d.name}{d.isThisPc ? ' (this PC)' : ''}</strong><div className="settings-note">{d.hostname} · last seen {ago(d.lastSeenAt)}</div></div>
              </div>
            ))}
          </>
        )}

        {synced.length > 0 && (
          <>
            <h3 className="settings-sub">Remove from sync everywhere</h3>
            <p className="settings-note">Deletes a project’s synced chats from GitHub, for every PC. The chats on each PC stay.</p>
            {synced.map(p => (
              <DangerButton key={p.workingDir} label={`Remove ${p.name} from GitHub`} busy={status.busy}
                confirm={`This deletes ${p.name}’s synced chats from GitHub, so no PC can bring them over any more. The chats already on each PC stay. Use “Start fresh” afterwards to clear them from the repo’s history too.`}
                onConfirm={() => void api.syncRemoveFromGithub(p.projectId!).then(report)} />
            ))}
          </>
        )}

        <h3 className="settings-sub">Maintenance</h3>
        <DangerButton label="Start fresh" busy={status.busy} confirm="This rebuilds the repo's history so old versions no longer count towards its size. It's also how to clear a leaked secret after removing its chat. Current chats stay. GitHub may keep old data for a while, so change any leaked key regardless. Other PCs catch up by themselves."
          onConfirm={() => void api.syncStartFresh().then(report)} />
        {status.hasRecoveryKey && (
          <DangerButton label="Make a new recovery key" busy={status.busy}
            confirm="This encrypts everything in the sync repo again under a new key, and removes its old history, which used the old key. Your chats stay. Other PCs stop syncing until you disconnect them and link them again with the new key."
            onConfirm={() => void api.syncReplaceRecoveryKey().then(r => { if (r.ok) { setMessage(null); setRecoveryKey(r.recoveryKey) } else setMessage(r.error) })} />
        )}
        <DangerButton label="Disconnect this PC" busy={status.busy} confirm="This PC stops syncing and forgets the key. Your chats here and the repo on GitHub stay as they are. You'd need the recovery key to link again."
          onConfirm={() => void api.syncDisconnect().then(report)} />
      </details>

      {review !== null && (
        <ReviewDialog title={`Sync ${review.row.name}?`} findings={review.scan.findings} encrypted={status.encrypted}
          intro={`${review.scan.chats} chat${review.scan.chats === 1 ? '' : 's'}, ${size(review.scan.bytes)}.`} images={review.scan.images} actionLabel="Start syncing"
          onCancel={() => setReview(null)}
          onDone={d => { const dir = review.row.workingDir; setReview(null); void api.syncEnableProject(dir, d).then(report) }} />
      )}
      {pending !== null && pending.projectId !== null && (
        <ReviewDialog title={`New likely secrets in ${pending.name}`} findings={pending.pendingFindings} encrypted={status.encrypted} intro="Found since the project was opted in." images={0} actionLabel="Continue syncing"
          onCancel={() => setPending(null)}
          onDone={d => { const id = pending.projectId!; setPending(null); void api.syncDecideFindings(id, d).then(report) }} />
      )}
    </>
  )
}

/** Before sync is on: one button. Links to the account's sync repo when there is one, which
 *  needs its recovery key, or makes one. */
function TurnOnPanel({ account, onKey }: { account: string | null; onKey: (key: string) => void }) {
  const [needsKey, setNeedsKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  async function turnOn(): Promise<void> {
    setWorking(true); setError(null)
    const r = await api.syncTurnOn(null)
    setWorking(false)
    if (r.ok) { if (r.recoveryKey !== null) onKey(r.recoveryKey) }
    else if ('needsKey' in r) setNeedsKey(true)
    else setError(r.error)
  }

  return (
    <>
      <p className="settings-note">Keeps a project’s chats the same on all your PCs, through a private repo on your GitHub account{account !== null ? ` (${account})` : ''}. Chats are encrypted before they leave this PC. Only chats sync, not code: a project’s own repo is cloned when you set it up on another PC.</p>
      {needsKey ? (
        <SyncKeyEntry onLinked={() => { /* status updates by itself */ }} />
      ) : (
        <>
          {error !== null && <div className="modal-error">{error}</div>}
          <div className="sync-actions">
            <button type="button" className="btn-primary" disabled={working} onClick={() => void turnOn()}>{working ? 'Turning on…' : 'Turn on project sync'}</button>
          </div>
        </>
      )}
    </>
  )
}

/** Asks for the recovery key of the account's existing sync repo, and links this PC with it. */
export function SyncKeyEntry({ onLinked }: { onLinked: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  async function link(): Promise<void> {
    setWorking(true); setError(null)
    const r = await api.syncTurnOn(key)
    setWorking(false)
    if (r.ok) onLinked()
    else setError('needsKey' in r ? 'Enter the recovery key.' : r.error)
  }
  return (
    <div className="sync-card">
      <p className="settings-note">Your GitHub account already syncs projects from another PC. Enter its recovery key to link this PC. On a PC that already syncs, it’s in Settings &gt; Project sync &gt; Recovery key.</p>
      <input className="field-input" type="password" value={key} autoFocus placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Recovery key"
        onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && key.trim().length > 0 && !working) void link() }} />
      {error !== null && <div className="modal-error">{error}</div>}
      <div className="sync-actions">
        <button type="button" className="btn-primary" disabled={working || key.trim().length === 0} onClick={() => void link()}>{working ? 'Linking…' : 'Link this PC'}</button>
      </div>
    </div>
  )
}

/** Shows the saved recovery key on request, so another PC can be linked. It's only fetched
 *  when asked for, and hidden again when Settings closes. */
function RecoveryKeyReveal() {
  const [key, setKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  async function load(): Promise<string | null> {
    if (key !== null) return key
    const k = await api.syncRecoveryKey()
    setKey(k)
    return k
  }
  async function copy(): Promise<void> {
    const k = key ?? await api.syncRecoveryKey()
    if (k === null) return
    await navigator.clipboard.writeText(k)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="sync-card">
      <div className="sync-card-title">Recovery key</div>
      <p className="settings-note">Another PC needs this to link to the sync repo.</p>
      <code className="sync-key">{key ?? '•••••-•••••-•••••-•••••-•••••'}</code>
      <div className="sync-actions">
        <button type="button" className="btn-secondary" onClick={() => { if (key === null) void load(); else setKey(null) }}>{key === null ? 'Reveal' : 'Hide'}</button>
        <button type="button" className="btn-secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}

function DangerButton({ label, confirm, busy, onConfirm }: { label: string; confirm: string; busy: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <div className="sync-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={() => setAsking(true)}>{label}…</button></div>
  return (
    <div className="sync-card">
      <p className="settings-note">{confirm}</p>
      <div className="sync-actions">
        <button type="button" className="btn-secondary" onClick={() => setAsking(false)}>Cancel</button>
        <button type="button" className="btn-danger" onClick={() => { setAsking(false); onConfirm() }}>{label}</button>
      </div>
    </div>
  )
}

function GithubNeeded({ state, onRecheck }: { state: 'missing' | 'signed_out' | 'ready'; onRecheck: () => void }) {
  return (
    <div className="sync-card">
      <p className="settings-note">Keeps chosen projects’ chats the same on your PCs, through a private GitHub repo you own. It uses your own GitHub sign-in, and nothing goes anywhere else.</p>
      {state === 'missing'
        ? <p className="settings-note">First install the GitHub CLI from <code>cli.github.com</code>, or run <code>winget install GitHub.cli</code>. You’ll need a free GitHub account too.</p>
        : <p className="settings-note">Sign in to GitHub first: run <code>gh auth login</code> in a terminal.</p>}
      <div className="sync-actions"><button type="button" className="btn-primary" onClick={onRecheck}>Check again</button></div>
    </div>
  )
}

function RecoveryKeyPanel({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  return (
    <div className="sync-card">
      <div className="sync-card-title">Save your recovery key</div>
      <p className="settings-note">You need it to link another PC. You can see it again any time in Settings &gt; Project sync on this PC, or on any PC linked with it.</p>
      <code className="sync-key">{recoveryKey}</code>
      <div className="sync-actions">
        <button type="button" className="btn-secondary" onClick={() => { void navigator.clipboard.writeText(recoveryKey) }}>Copy</button>
      </div>
      <label className="field-checkbox"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />I’ve saved it somewhere safe, like a password manager</label>
      <div className="sync-actions"><button type="button" className="btn-primary" disabled={!saved} onClick={onDone}>Continue</button></div>
    </div>
  )
}

type Choice = 'redact' | 'allow' | 'exclude'

/** Starts syncing a project from outside Settings: checks it for likely secrets, then shows the
 *  same review, which a project with nothing in it yet doesn't need. Closing this while the
 *  first upload runs doesn't stop it, and Settings shows any error from then on. */
export function StartProjectSync({ workingDir, name, encrypted, onClose }: {
  workingDir: string
  name: string
  encrypted: boolean
  onClose: () => void
}) {
  const [scan, setScan] = useState<ProjectScan | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<{ done: number; total: number } | null>(null)
  const [progress, setProgress] = useState<EnableProgress | null>(null)
  useEffect(() => {
    const mine = (dir: string): boolean => samePath(dir, workingDir)
    const offScan = api.onSyncScanProgress(p => { if (mine(p.workingDir)) setChecked({ done: p.done, total: p.total }) })
    const offEnable = api.onSyncEnableProgress(p => { if (mine(p.workingDir)) setProgress(p) })
    return () => { offScan(); offEnable() }
  }, [workingDir])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  function start(decisions: FindingDecisions): void {
    setStarting(true)
    void api.syncEnableProject(workingDir, decisions).then(r => {
      if (!aliveRef.current) return
      if (r.ok) closeRef.current()
      else { setStarting(false); setError(r.error) }
    })
  }
  useEffect(() => {
    let alive = true
    api.syncScanProject(workingDir).then(s => {
      if (!alive) return
      if (s.chats === 0 && s.findings.length === 0) start({ redact: [], allow: [], excludeChats: [] })
      else setScan(s)
    }, (e: Error) => { if (alive) setError(e.message) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for this folder
  }, [workingDir])

  if (scan !== null && !starting && error === null) {
    return (
      <ReviewDialog title={`Sync ${name}?`} findings={scan.findings} encrypted={encrypted}
        intro={`${scan.chats} chat${scan.chats === 1 ? '' : 's'}, ${size(scan.bytes)}.`} images={scan.images} actionLabel="Start syncing"
        onCancel={onClose} onDone={start} />
    )
  }
  return (
    <div className="modal-overlay" onClick={e => e.stopPropagation()}>
      <div className="modal sync-dialog">
        <h2 className="modal-title">Sync {name}?</h2>
        {error !== null && <div className="modal-error">{error}</div>}
        {error === null && starting && <>
          <p className="settings-note">{progressLabel(progress)}</p>
          <ProgressBar fraction={progress === null || progress.total === 0 ? null : progress.done / progress.total} />
          <p className="settings-note">This keeps going if you close this.</p>
        </>}
        {error === null && !starting && <>
          <p className="settings-note">{checked === null || checked.total === 0 ? 'Checking its chats for likely secrets…' : `Checking its chats for likely secrets: ${checked.done} of ${checked.total}`}</p>
          <ProgressBar fraction={checked === null || checked.total === 0 ? null : checked.done / checked.total} />
        </>}
        <div className="modal-actions"><button type="button" className="btn-secondary" onClick={onClose}>{error !== null || starting ? 'Close' : 'Cancel'}</button></div>
      </div>
    </div>
  )
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function progressLabel(p: EnableProgress | null): string {
  if (p === null) return 'Starting to sync…'
  if (p.phase === 'download') return 'Getting the latest from GitHub…'
  if (p.phase === 'pack') return `Packing chats: ${p.done} of ${p.total}`
  return `Uploading to GitHub: ${p.done}%`
}

/** A fraction from 0 to 1, or null when there's no way to tell how far along it is. */
function ProgressBar({ fraction }: { fraction: number | null }) {
  return (
    <div className={`sync-progress${fraction === null ? ' busy' : ''}`} role="progressbar"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
      <i style={fraction === null ? undefined : { width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
    </div>
  )
}

function ReviewDialog({ title, intro, findings, images, encrypted, actionLabel, onCancel, onDone }: {
  title: string
  intro: string
  findings: SecretFinding[]
  images: number
  encrypted: boolean
  actionLabel: string
  onCancel: () => void
  onDone: (decisions: FindingDecisions) => void
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>(() => Object.fromEntries(findings.map(f => [f.fingerprint, 'redact' as Choice])))
  const setAll = (c: Choice): void => setChoices(Object.fromEntries(findings.map(f => [f.fingerprint, c])))

  function finish(): void {
    const decisions: FindingDecisions = { redact: [], allow: [], excludeChats: [] }
    for (const f of findings) {
      const c = choices[f.fingerprint] ?? 'redact'
      if (c === 'allow') decisions.allow.push(f.fingerprint)
      else if (c === 'redact' || f.sessionIds.length === 0) decisions.redact.push(f.fingerprint)
      else decisions.excludeChats.push(...f.sessionIds)
    }
    decisions.excludeChats = [...new Set(decisions.excludeChats)]
    onDone(decisions)
  }

  return (
    <div className="modal-overlay" onClick={e => e.stopPropagation()}>
      <div className="modal sync-dialog sync-review">
        <h2 className="modal-title">{title}</h2>
        <p className="settings-note">{intro} {findings.length === 0 ? 'No likely secrets found.' : `Found ${findings.length} likely secret${findings.length === 1 ? '' : 's'}.`}</p>
        <p className="settings-note">This check can miss things, like a password that looks like an ordinary word{images > 0 ? `, or anything in the ${images} picture${images === 1 ? '' : 's'} in these chats` : ', or a key in a picture'}.{encrypted ? ' Everything is encrypted before upload either way.' : ' This repo isn’t encrypted, so GitHub can read what uploads.'}</p>
        {findings.length > 0 && (
          <>
            <div className="sync-actions">
              <button type="button" className="btn-secondary" onClick={() => setAll('redact')}>Redact all</button>
              <button type="button" className="btn-secondary" onClick={() => setAll('exclude')}>Leave out all</button>
              <button type="button" className="btn-secondary" onClick={() => setAll('allow')}>Sync all anyway</button>
            </div>
            <div className="sync-findings">
              {findings.map(f => (
                <div key={f.fingerprint} className="sync-finding">
                  <div className="sync-finding-head">
                    <strong>{f.rule}</strong> <code>{f.masked}</code>
                    <span className="settings-note"> {f.confidence === 'possible' ? 'possible · ' : ''}{f.count} time{f.count === 1 ? '' : 's'}, {f.sessionIds.length > 0 ? `${f.sessionIds.length} chat${f.sessionIds.length === 1 ? '' : 's'}` : f.files.join(', ')}</span>
                  </div>
                  <div className="sync-finding-context">{f.context}</div>
                  <select value={choices[f.fingerprint] ?? 'redact'} onChange={e => setChoices(c => ({ ...c, [f.fingerprint]: e.target.value as Choice }))}>
                    <option value="redact">Redact it in the synced copy</option>
                    {f.sessionIds.length > 0 && <option value="exclude">Leave those chats out</option>}
                    <option value="allow">Sync it anyway</option>
                  </select>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-primary" onClick={finish}>{actionLabel}</button>
        </div>
      </div>
    </div>
  )
}
