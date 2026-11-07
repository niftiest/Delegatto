import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { ago } from './SyncChat'
import type {
  FindingDecisions, ProjectScan, RemoteProject, RepoSearch, SecretFinding, SyncProjectRow, SyncStatus
} from '../../shared/sync-types'

const DEFAULT_REPO = 'delegatto-sync'

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
  const [linking, setLinking] = useState<RemoteProject | null>(null)
  const [turnedOff, setTurnedOff] = useState<SyncProjectRow[]>([])

  useEffect(() => {
    void api.syncStatus().then(setStatus)
    return api.onSyncChanged(setStatus)
  }, [])

  if (status === null) return <p className="settings-note">Loading…</p>

  if (recoveryKey !== null) return <RecoveryKeyPanel recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />
  if (status.github.state !== 'ready') return <GithubNeeded state={status.github.state} onRecheck={() => void api.syncStatus().then(setStatus)} />
  if (!status.configured) return <SetupPanel account={status.github.account} previousRepo={status.repo} discovered={status.discoveredRepos} onKey={setRecoveryKey} />

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
      <div className="sync-card">
        <div className="sync-card-title">{status.repo}{status.encrypted ? ' · encrypted' : ''}</div>
        <div className="settings-note">
          {status.busy ? `${status.activity ?? 'Working'}…` : status.lastSyncAt === null ? 'Not synced yet.' : `Last synced ${ago(status.lastSyncAt)}.`}
          {status.repoSizeBytes !== null && ` Repo is ${size(status.repoSizeBytes)} on GitHub.`}
        </div>
        {status.lastError !== null && <div className="modal-error">{status.lastError}</div>}
        {status.repoSizeBytes !== null && status.repoSizeBytes > 2 ** 30 && (
          <p className="settings-note">GitHub suggests keeping repos under 1 GB. “Start fresh” below removes old versions, and syncing fewer projects helps too.</p>
        )}
        <div className="sync-actions">
          <button type="button" className="btn-primary" disabled={status.busy} onClick={() => void api.syncNow().then(report)}>Sync now</button>
        </div>
      </div>

      {message !== null && <div className="modal-error">{message}</div>}

      <label className="settings-row">
        <div className="settings-row-label">This PC’s name<span className="settings-hint">Shown on other PCs, as in “Open on {status.deviceName}”.</span></div>
        <input type="text" defaultValue={status.deviceName} placeholder={status.hostname}
          onBlur={e => { void api.syncSetDeviceName(e.target.value) }} />
      </label>
      <label className="settings-row">
        <div className="settings-row-label">Sync automatically<span className="settings-hint">Checks GitHub every minute or two, and after each reply. Off: only when you press Sync now.</span></div>
        <input type="checkbox" checked={status.auto} onChange={e => { void api.syncSetAuto(e.target.checked) }} />
      </label>

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

      {status.remoteProjects.length > 0 && (
        <>
          <h3 className="settings-sub">On other PCs ({status.remoteProjects.length})</h3>
          <p className="settings-note">Choose where each goes on this PC. It clones the project’s repo there, if it has one, then brings its chats over.</p>
          {status.remoteProjects.map(r => (
            <div key={r.projectId} className="sync-row">
              <div>
                <strong>{r.name}</strong>
                <div className="settings-note">{r.chats} chat{r.chats === 1 ? '' : 's'} · last from {r.updatedBy} {ago(r.updatedAt)}{r.github !== null ? ` · ${r.github}` : ' · no GitHub repo'}</div>
              </div>
              <button type="button" className="btn-secondary" disabled={status.busy} onClick={() => setLinking(r)}>Set up here…</button>
            </div>
          ))}
        </>
      )}

      <h3 className="settings-sub">Syncing ({synced.length})</h3>
      {synced.length === 0 && justOff.length === 0 && <p className="settings-note">No projects yet. Turn sync on by right-clicking a project in the chat list, in a chat’s Project options, or when you create a new chat.</p>}
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
            <button type="button" className="btn-secondary" disabled={status.busy} onClick={() => void api.syncRemoveFromGithub(p.projectId!).then(report)}>Remove from GitHub</button>
            <label className="sync-toggle">
              <input type="checkbox" checked disabled={status.busy}
                onChange={() => { setTurnedOff(off => [...off.filter(o => o.workingDir !== p.workingDir), { ...p, projectId: null }]); void api.syncDisableProject(p.projectId!).then(report) }} />
              Sync
            </label>
          </div>
        </div>
      ))}
      {justOff.map(p => (
        <div key={p.workingDir} className="sync-row">
          <div>
            <strong>{p.name}</strong>
            <div className="settings-note">{p.workingDir}</div>
            <div className="settings-note">Not syncing. Its chats stay on this PC and on GitHub.</div>
          </div>
          <div className="sync-actions">
            <label className="sync-toggle">
              <input type="checkbox" checked={false} disabled={scanning !== null || status.busy} onChange={() => void optIn(p)} />
              {scanning === p.workingDir ? 'Checking…' : 'Sync'}
            </label>
          </div>
        </div>
      ))}

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

      <h3 className="settings-sub">Maintenance</h3>
      <DangerButton label="Start fresh" busy={status.busy} confirm="This rebuilds the repo's history so old versions no longer count towards its size. It's also how to clear a leaked secret after removing its chat. Current chats stay. GitHub may keep old data for a while, so change any leaked key regardless. Other PCs catch up by themselves."
        onConfirm={() => void api.syncStartFresh().then(report)} />
      <DangerButton label="Disconnect this PC" busy={status.busy} confirm="This PC stops syncing and forgets the key. Your chats here and the repo on GitHub stay as they are. You'd need the recovery key to link again."
        onConfirm={() => void api.syncDisconnect().then(report)} />

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
      {linking !== null && <LinkDialog project={linking} onClose={() => setLinking(null)} />}
    </>
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

function SetupPanel({ account, previousRepo, discovered, onKey }: { account: string | null; previousRepo: string | null; discovered: string[]; onKey: (key: string) => void }) {
  const [name, setName] = useState(previousRepo ?? DEFAULT_REPO)
  const [encrypted, setEncrypted] = useState(true)
  const [found, setFound] = useState<RepoSearch | null>(null)
  const [recovery, setRecovery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    setFound(null)
    if (name.trim().length === 0) return
    const timer = setTimeout(() => { void api.syncFindRepo(name).then(setFound) }, 400)
    return () => clearTimeout(timer)
  }, [name])

  // A repo found on the account takes over from the suggested name, unless the user typed one.
  const onlyFound = discovered.length === 1 ? discovered[0]! : null
  useEffect(() => {
    if (onlyFound !== null) setName(current => current === DEFAULT_REPO ? onlyFound : current)
  }, [onlyFound])

  async function create(): Promise<void> {
    setWorking(true); setError(null)
    const r = await api.syncSetupNew({ name, encrypted })
    setWorking(false)
    if (!r.ok) setError(r.error)
    else if (r.recoveryKey !== null) onKey(r.recoveryKey)
  }
  async function link(): Promise<void> {
    setWorking(true); setError(null)
    const r = await api.syncSetupExisting({ name, recoveryKey: recovery })
    setWorking(false)
    if (!r.ok) setError(r.error)
  }

  const canLink = found?.exists === true && found.isSyncRepo
  const blocked = found?.exists === true && !found.isSyncRepo
  return (
    <>
      <p className="settings-note">Keeps chosen projects’ chats the same on your PCs, through a private GitHub repo you own{account !== null ? ` (signed in as ${account})` : ''}. Only the chats sync, not your code. A project’s own repo gets cloned where you choose.</p>
      <label className="settings-row">
        <div className="settings-row-label">Sync repository<span className="settings-hint">A private repo for Delegatto’s use. It’s made for you if it doesn’t exist.</span></div>
        <input type="text" value={name} onChange={e => setName(e.target.value)} />
      </label>
      {discovered.length > 1 && (
        <div className="sync-found">
          <span className="settings-note">Sync repos on your account:</span>
          {discovered.map(r => <button key={r} type="button" className="btn-secondary" onClick={() => setName(r)}>{r}</button>)}
        </div>
      )}
      {found?.error !== null && found?.error !== undefined && <div className="modal-error">{found.error}</div>}
      {blocked && <div className="modal-error">{found.repo} already exists and isn’t a sync repo. Choose another name.</div>}
      {canLink ? (
        <>
          <p className="settings-note">{found.repo} is already a sync repo, set up from another PC.{found.isPrivate !== true ? ' It isn’t private, so it can’t be used.' : ''}</p>
          {found.encrypted === true && (
            <label className="settings-row">
              <div className="settings-row-label">Recovery key<span className="settings-hint">The key shown when the repo was set up.</span></div>
              <input type="password" value={recovery} onChange={e => setRecovery(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" />
            </label>
          )}
          {error !== null && <div className="modal-error">{error}</div>}
          <div className="sync-actions"><button type="button" className="btn-primary" disabled={working || found.isPrivate !== true} onClick={() => void link()}>{working ? 'Linking…' : 'Link this PC'}</button></div>
        </>
      ) : (
        <>
          <label className="settings-row">
            <div className="settings-row-label">Encrypt before uploading<span className="settings-hint">Recommended. If your GitHub login leaked, or the repo was made public by accident, your chats would still be unreadable. A new PC needs the recovery key, and losing it means losing the synced copy.</span></div>
            <input type="checkbox" checked={encrypted} onChange={e => setEncrypted(e.target.checked)} />
          </label>
          {error !== null && <div className="modal-error">{error}</div>}
          <div className="sync-actions"><button type="button" className="btn-primary" disabled={working || blocked || name.trim().length === 0} onClick={() => void create()}>{working ? 'Setting up…' : 'Create private repo'}</button></div>
        </>
      )}
    </>
  )
}

function RecoveryKeyPanel({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  return (
    <div className="sync-card">
      <div className="sync-card-title">Save your recovery key</div>
      <p className="settings-note">You need it to link another PC. It isn’t stored anywhere you can get it back from, and without it the synced copy can’t be read. Your chats on this PC aren’t affected.</p>
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
        {error === null && <p className="settings-note">{starting ? 'Starting to sync. This keeps going if you close this.' : 'Checking its chats for likely secrets…'}</p>}
        <div className="modal-actions"><button type="button" className="btn-secondary" onClick={onClose}>{error !== null || starting ? 'Close' : 'Cancel'}</button></div>
      </div>
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

function LinkDialog({ project, onClose }: { project: RemoteProject; onClose: () => void }) {
  const [folder, setFolder] = useState(project.suggestedFolder)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ workingDir: string; chats: number; warnings: string[] } | null>(null)

  async function browse(): Promise<void> {
    const picked = await api.pickDirectory()
    if (picked !== null) setFolder(picked)
  }
  async function link(): Promise<void> {
    setWorking(true); setError(null)
    const r = await api.syncLinkProject(project.projectId, folder)
    setWorking(false)
    if (r.ok) setDone(r)
    else setError(r.error)
  }

  return (
    <div className="modal-overlay" onClick={e => e.stopPropagation()}>
      <div className="modal sync-dialog">
        <h2 className="modal-title">Set up {project.name} on this PC</h2>
        {done !== null ? (
          <>
            <p className="settings-note">{done.chats} chat{done.chats === 1 ? '' : 's'} brought over to {done.workingDir}.</p>
            {done.warnings.map(w => <div key={w} className="sync-warn-text">{w}</div>)}
            <div className="modal-actions"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <p className="settings-note">{project.github !== null ? `This clones ${project.github}${project.branch !== null ? ` (${project.branch})` : ''} into the folder, then brings over the ${project.chats} chat${project.chats === 1 ? '' : 's'}, pointed at it.` : `This project has no GitHub repo, so only its ${project.chats} chat${project.chats === 1 ? '' : 's'} come over.`}</p>
            {project.unpushed > 0 && <div className="sync-warn-text">{project.updatedBy} has {project.unpushed} commit{project.unpushed === 1 ? '' : 's'} not pushed, so this copy won’t have them.</div>}
            {project.uncommitted > 0 && <div className="sync-warn-text">{project.updatedBy} has {project.uncommitted} changed file{project.uncommitted === 1 ? '' : 's'} not committed, so this copy won’t have them.</div>}
            <label className="field">
              <span className="field-label">Folder on this PC</span>
              <div className="field-row">
                <input className="field-input" value={folder} onChange={e => setFolder(e.target.value)} />
                <button type="button" className="btn-secondary" onClick={() => void browse()}>Browse…</button>
              </div>
            </label>
            {error !== null && <div className="modal-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary" disabled={working} onClick={onClose}>Cancel</button>
              <button type="button" className="btn-primary" disabled={working || folder.trim().length === 0} onClick={() => void link()}>{working ? 'Setting up…' : 'Set up here'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
