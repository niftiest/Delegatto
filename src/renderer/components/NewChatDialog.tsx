import { useEffect, useState } from 'react'
import { api } from '../api'
import { checkoutRows, filterCheckoutRows, resolveNewProjectOptions, type CheckoutRow, type NewChatDefaults, type NewProjectOptions } from '../lib'
import { EFFORTS } from '../../shared/models'
import { modelOption, useClaudeModels } from './useClaudeModels'
import type { FolderTrust } from '../../shared/shell-run-types'
import type { GithubRepoOption, GithubStatus } from '../../shared/github-types'
import type { RemoteProject, SyncStatus } from '../../shared/sync-types'
import { ProgressBar, SyncKeyEntry, setupLabel } from './SyncSettings'
import type { EnableProgress } from '../../shared/sync-types'

/** Modal for starting a brand-new chat (Plan 2 Task 8): a working directory
 *  (typed, or via the native folder picker), whether to run with
 *  `--dangerously-skip-permissions`, model/effort selectors, and an optional
 *  session name -- exactly the fields the original ask called for, in that
 *  order (cwd first, skip-permissions and the rest underneath).
 *
 *  Validation/defaulting is delegated to the pure `resolveNewProjectOptions`
 *  (src/renderer/lib.ts, fully unit-tested) so this component only handles
 *  form state and wiring, not the merge/validation rules themselves.
 *
 *  REQUIRES HUMAN VERIFICATION: this component (the modal chrome, the
 *  native Browse dialog, and the end-to-end create-and-open flow) is
 *  visual/electron and cannot be exercised by vitest -- see the Task 8
 *  report for the manual check. */
const SEARCH_ABOVE = 10

export function NewChatDialog({ defaults, onCancel, onCreate, onOpenProject, confirmBypass = false }: {
  defaults: NewChatDefaults
  /** Ask once more before creating a chat that skips permission prompts. */
  confirmBypass?: boolean
  onCancel: () => void
  /** Submits the resolved options to the engine. Resolves `{ok:true}` on
   *  success (the caller closes the dialog and opens the new chat) or
   *  `{ok:false, error}` (e.g. a cwd that doesn't exist on disk), which this
   *  component shows inline and leaves the dialog open so the user can
   *  correct it. */
  onCreate: (options: NewProjectOptions) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Opens a project that's just been brought over from another PC, and closes this dialog. */
  onOpenProject: (workingDir: string) => void
}) {
  const [cwd, setCwd] = useState(defaults.cwd ?? '')
  // Interactive permission approval is now wired end-to-end (Plan 3 Task 7):
  // the PermissionRelay spawns the CLI's permission MCP server via a per-session
  // pipe back to Delegatto's PermissionBridge + UI, verified against a live
  // `claude`. So this is a real toggle again, seeded from the persisted default.
  // OFF routes every gated tool use to a permission card; ON keeps
  // --dangerously-skip-permissions for users who want an unattended run.
  const [skipPermissions, setSkipPermissions] = useState(defaults.skipPermissions)
  const [model, setModel] = useState(defaults.model ?? '')
  const [effort, setEffort] = useState(defaults.effort ?? '')
  const [name, setName] = useState('')
  const models = useClaudeModels()
  const shownModel = model === '' ? '' : modelOption(models, model)
  const modelEfforts = models.find(m => m.value === shownModel)?.efforts ?? []
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // A folder with saved settings starts from those, since this chat will share them.
  const [fromProject, setFromProject] = useState(false)
  useEffect(() => {
    const folder = cwd.trim()
    setFromProject(false)
    if (folder.length === 0) return
    let alive = true
    const timer = setTimeout(() => {
      void api.folderSettings(folder).then(saved => {
        if (!alive || Object.keys(saved).length === 0) return
        if (saved.skipPermissions !== undefined) setSkipPermissions(saved.skipPermissions)
        if (saved.model !== undefined) setModel(saved.model)
        if (saved.effort !== undefined) setEffort(saved.effort)
        setFromProject(true)
      })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [cwd])
  // Set while asking about a folder Claude has never worked in.
  const [trustPrompt, setTrustPrompt] = useState<FolderTrust | null>(null)

  // GitHub: only when gh is installed and signed in. A repo picks the folder, and is cloned or
  // pulled on Create, before the trust check, so that check sees what actually arrived.
  const [github, setGithub] = useState<GithubStatus | null>(null)
  const [repos, setRepos] = useState<GithubRepoOption[] | null>(null)
  const [reposError, setReposError] = useState<string | null>(null)
  const [repo, setRepo] = useState('')
  const [picked, setPicked] = useState<CheckoutRow | null>(null)
  const [search, setSearch] = useState('')
  const [remote, setRemote] = useState<RemoteProject[]>([])
  const [syncRepos, setSyncRepos] = useState<string[]>([])
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  // A repo with synced chats that was just clicked: asks whether to bring them, and for the key first if needed.
  const [offer, setOffer] = useState<{ row: CheckoutRow; step: 'ask' | 'key' | 'loading' } | null>(null)
  const [offerError, setOfferError] = useState<string | null>(null)
  // A project brought over from another PC, with what to know before opening it.
  const [linked, setLinked] = useState<{ workingDir: string; warnings: string[] } | null>(null)
  const [preparing, setPreparing] = useState(false)
  // Setting up a synced project here: cloning it, then bringing in its chats.
  const [setup, setSetup] = useState<EnableProgress | null>(null)
  // The repo + folder already cloned or pulled, so a second Create (after a prompt) doesn't repeat it.
  const [prepared, setPrepared] = useState<string | null>(null)
  const [repoWarning, setRepoWarning] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.githubStatus().then(status => {
      if (!alive) return
      setGithub(status)
      if (status.state !== 'ready') return
      void api.githubRepos().then(list => {
        if (!alive) return
        if (list.ok) setRepos(list.repos)
        else setReposError(list.error)
      })
    })
    void api.syncStatus().then(status => { if (alive) applySyncStatus(status) })
      .catch(() => { /* the list just won't show what's synced */ })
    return () => { alive = false }
  }, [])

  function applySyncStatus(status: SyncStatus): void {
    setSyncStatus(status)
    setRemote(status.configured ? status.remoteProjects : [])
    setSyncRepos([...status.discoveredRepos, ...(status.repo === null ? [] : [status.repo])])
  }

  const syncedHere = (syncStatus?.projects ?? []).flatMap(p => p.projectId !== null && p.github !== null ? [p.github] : [])
  const withHistory = syncStatus?.syncedRepos ?? []
  const rows = repos === null && remote.length === 0 ? null : checkoutRows(repos ?? [], remote, syncRepos, syncedHere, withHistory)
  const shownRows = rows === null ? [] : filterCheckoutRows(rows, search)

  /** Clicking the picked row again goes back to using a folder. A repo with synced chats asks
   *  first whether to bring them. */
  function pickRow(row: CheckoutRow) {
    if (picked?.key !== row.key && row.hasHistory) { setOfferError(null); setOffer({ row, step: 'ask' }); return }
    applyPick(picked?.key === row.key ? null : row)
  }

  /** A clone already on this PC is used as it is: only a repo that isn't here yet gets fetched. */
  function applyPick(next: CheckoutRow | null) {
    setPicked(next)
    setRepo(next !== null && next.sync === null && !next.onThisPc ? next.repo ?? '' : '')
    setPrepared(null)
    setRepoWarning(null)
    setTrustPrompt(null)
    setLinked(null)
    setError(null)
    if (next !== null) setCwd(next.folder)
    else if (cwd === picked?.folder) setCwd(defaults.cwd ?? '')
  }

  /** Bring the synced chats too. Without the key yet, ask for it, then find the project once linked. */
  async function acceptOffer(row: CheckoutRow) {
    if (row.sync !== null) { setOffer(null); applyPick(row); return }
    if (syncStatus?.configured !== true) { setOffer({ row, step: 'key' }); return }
    await afterLinked(row)
  }

  async function afterLinked(row: CheckoutRow) {
    setOffer({ row, step: 'loading' })
    // The project list is read just after linking, so give it a moment to arrive.
    for (let i = 0; i < 20; i++) {
      const status = await api.syncStatus()
      applySyncStatus(status)
      const found = status.remoteProjects.find(p => p.github !== null && row.repo !== null && p.github.toLowerCase() === row.repo.toLowerCase())
      if (found !== undefined) {
        const next = checkoutRows(repos ?? [], status.remoteProjects, [], [], []).find(r => r.sync?.projectId === found.projectId)
        setOffer(null)
        if (next !== undefined) applyPick(next)
        return
      }
      await new Promise(res => setTimeout(res, 500))
    }
    setOffer({ row, step: 'ask' })
    setOfferError("Linked, but this project's synced chats didn't show up. Try again in a moment.")
  }

  function declineOffer(row: CheckoutRow) {
    setOffer(null)
    if (row.repo !== null) applyPick({ ...row, sync: null, hasHistory: false })
  }

  async function bringOver(projectId: string, folder: string) {
    setSetup(null)
    const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    const off = api.onSyncEnableProgress(p => { if (norm(p.workingDir) === norm(folder)) setSetup(p) })
    try { await bringOverNow(projectId, folder) } finally { off(); setSetup(null) }
  }

  async function bringOverNow(projectId: string, folder: string) {
    if (linked !== null) { onOpenProject(linked.workingDir); return }
    setError(null)
    setPreparing(true)
    const outcome = await api.syncLinkProject(projectId, folder).finally(() => setPreparing(false))
    if (!outcome.ok) { setError(outcome.error); return }
    if (outcome.warnings.length > 0) setLinked({ workingDir: outcome.workingDir, warnings: outcome.warnings })
    else onOpenProject(outcome.workingDir)
  }

  async function browse() {
    const picked = await api.pickDirectory()
    if (picked !== null) { setCwd(picked); setTrustPrompt(null) }
  }

  async function submit() {
    if (picked?.sync != null) { await bringOver(picked.sync.projectId, cwd.trim()); return }
    const resolved = resolveNewProjectOptions(
      {
        cwd,
        skipPermissions,
        model: model === '' ? undefined : model,
        effort: effort === '' ? undefined : effort,
        name: name === '' ? undefined : name
      },
      defaults
    )
    if (!resolved.ok) { setError(resolved.error); return }
    const repoKey = `${repo}|${resolved.options.cwd}`
    if (repo !== '' && prepared !== repoKey) {
      setError(null)
      setPreparing(true)
      const outcome = await api.githubPrepare({ repo, cwd: resolved.options.cwd }).finally(() => setPreparing(false))
      if (!outcome.ok) { setError(outcome.error); return }
      setPrepared(repoKey)
      if (outcome.warning !== undefined) { setRepoWarning(outcome.warning); return }
    }
    if (trustPrompt !== null) {
      await api.trustFolder(resolved.options.cwd)
      setTrustPrompt(null)
    } else {
      const trust = await api.folderTrust(resolved.options.cwd)
      if (!trust.trusted) { setError(null); setTrustPrompt(trust); return }
    }
    if (resolved.options.skipPermissions && confirmBypass && !confirming) { setConfirming(true); return }

    setCreating(true)
    setError(null)
    try {
      const result = await onCreate(resolved.options)
      if (!result.ok) setError(result.error)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New chat"
        onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">New chat</h2>

        {github?.state === 'ready' && (
          <div className="field">
            <span className="field-label">Your GitHub projects</span>
            {rows !== null && rows.length > SEARCH_ABOVE && (
              <input className="field-input checkout-search" type="text" value={search} placeholder={`Filter ${rows.length} projects`}
                aria-label="Filter projects" onChange={e => setSearch(e.target.value)} />
            )}
            {repos === null && reposError === null && <p className="field-note">Loading your repositories…</p>}
            {repos !== null && rows !== null && rows.length === 0 && <p className="field-note">No repositories on this account yet.</p>}
            {rows !== null && rows.length > 0 && (
              <div className="checkout-list" role="listbox" aria-label="Your GitHub projects">
                {shownRows.length === 0 && <p className="field-note checkout-none">No projects match that.</p>}
                {shownRows.map(r => (
                  <button key={r.key} type="button" className="checkout-row" role="option" aria-selected={picked?.key === r.key}
                    disabled={preparing} title={r.description ?? undefined} onClick={() => pickRow(r)}>
                    <span className="checkout-name">
                      {r.sync !== null && <span className="checkout-synced" title={`Syncing from ${r.sync.from}`} aria-label="Syncing from another PC">⟳</span>}
                      {r.sync === null && r.hasHistory && <span className="checkout-synced" title="Has synced chats" aria-label="Has synced chats">⟳</span>}
                      {r.syncedHere && <span className="checkout-synced" title="Syncing from this PC" aria-label="Syncing from this PC">⟳</span>}
                      {r.label}
                    </span>
                    <span className="checkout-meta">
                      {[
                        r.sync !== null && `Syncing from ${r.sync.from}, ${r.sync.chats} chat${r.sync.chats === 1 ? '' : 's'}`,
                        r.syncedHere && 'Syncing from this PC',
                        r.sync === null && r.hasHistory && 'Has synced chats',
                        r.onThisPc && 'On this PC',
                        r.isPrivate && 'Private',
                        r.isArchived && 'Archived'
                      ].filter(Boolean).join(' · ') || 'Public'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {reposError !== null && <p className="field-note">Couldn’t list your repositories: {reposError}</p>}
        {picked?.sync != null && <p className="field-note">Brings the project’s chats to the folder below{picked.repo !== null ? ', and clones its code there' : ''}, then opens it.</p>}
        {repo !== '' && <p className="field-note">Created in the folder below: cloned if it’s new there, or pulled if it’s already there.</p>}
        {github?.state === 'signed_out' && <p className="field-note">Run <code>gh auth login</code> to start a chat from one of your GitHub repositories.</p>}

        <label className="field">
          <span className="field-label">Working directory</span>
          <div className="field-row">
            <input className="field-input" type="text" value={cwd} placeholder="C:\path\to\project"
              onChange={e => { setCwd(e.target.value); setTrustPrompt(null); setRepoWarning(null) }} />
            <button type="button" className="btn-secondary" onClick={() => void browse()}>Browse…</button>
          </div>
        </label>

        {fromProject && <p className="field-note">Using this project’s saved settings. Changes here apply to all its chats.</p>}

        <label className="field field-checkbox">
          <input type="checkbox" checked={skipPermissions} onChange={e => { setSkipPermissions(e.target.checked); setConfirming(false) }} />
          <span>Run with --dangerously-skip-permissions</span>
        </label>
        <p className="field-note">
          {skipPermissions
            ? 'Every tool runs without asking — fastest for an unattended run, but Claude can edit files and run commands unprompted.'
            : 'You’ll be asked to Allow or Deny each tool use that needs permission.'}
        </p>

        <label className="field">
          <span className="field-label">Model</span>
          <select className="field-input" value={shownModel} onChange={e => setModel(e.target.value)}>
            <option value="">Default</option>
            {models.map(m => <option key={m.value} value={m.value} title={m.description}>{m.label}</option>)}
            {shownModel !== '' && !models.some(m => m.value === shownModel) && <option value={shownModel}>{shownModel}</option>}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Effort</span>
          <select className="field-input" value={effort} onChange={e => setEffort(e.target.value)}>
            <option value="">Default</option>
            {(modelEfforts.length > 0 ? modelEfforts : EFFORTS).map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Name (optional)</span>
          <input className="field-input" type="text" value={name} placeholder="Session name"
            onChange={e => setName(e.target.value)} />
        </label>

        {error !== null && <div className="modal-error">{error}</div>}
        {preparing && picked?.sync != null && (
          <div className="field" role="status">
            <p className="field-note">{setupLabel(setup, picked.repo)}</p>
            <ProgressBar fraction={setup !== null && setup.phase === 'pack' && setup.total > 0 ? setup.done / setup.total : null} />
          </div>
        )}
        {linked?.warnings.map(w => <div key={w} className="sync-warn-text" role="alert">{w}</div>)}
        {repoWarning !== null && <div className="modal-error" role="alert">{repoWarning} Press Create again to start the chat anyway.</div>}
        {trustPrompt !== null && <TrustPrompt trust={trustPrompt} skipPermissions={skipPermissions} />}
        {confirming && (
          <div className="modal-error" role="alert">
            This chat will run every tool without asking, including editing files and running commands. Create it anyway?
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={creating || preparing}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void submit()}
            disabled={cwd.trim().length === 0 || creating || preparing}>
            {picked?.sync != null ? (preparing ? 'Setting up…' : linked !== null ? 'Open project' : 'Set up on this PC') : preparing ? 'Getting the repository…' : creating ? 'Creating…' : trustPrompt !== null ? 'Trust folder and create' : confirming ? 'Yes, create it' : 'Create chat'}
          </button>
        </div>
      </div>
      {offer !== null && (
        <div className="modal-overlay" role="presentation" onClick={e => { e.stopPropagation(); if (offer.step !== 'loading') setOffer(null) }}>
          <div className="modal sync-dialog" role="dialog" aria-label={`Set up ${offer.row.label}`} onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">{offer.row.sync?.chats === 0 ? `${offer.row.label} is synced, with no chats yet` : `${offer.row.label} has synced chats`}</h2>
            {offer.step === 'ask' && <>
              <p className="settings-note">
                {offer.row.sync === null
                  ? 'Another of your PCs syncs this project. Bring its chats here and keep syncing it on this PC too?'
                  : offer.row.sync.chats === 0
                    ? `${offer.row.sync.from} syncs this project, but it has no chats to bring yet. Sync it here too, so chats from either PC show up on both?`
                    : `${offer.row.sync.chats} chat${offer.row.sync.chats === 1 ? '' : 's'}, last synced from ${offer.row.sync.from}. Bring them here and keep syncing it on this PC too?`}
              </p>
              {offerError !== null && <div className="modal-error">{offerError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setOffer(null)}>Cancel</button>
                {offer.row.repo !== null && <button type="button" className="btn-secondary" onClick={() => declineOffer(offer.row)}>Just clone</button>}
                <button type="button" className="btn-primary" onClick={() => void acceptOffer(offer.row)}>Clone and sync</button>
              </div>
            </>}
            {offer.step === 'key' && <>
              <SyncKeyEntry onLinked={() => void afterLinked(offer.row)} />
              <div className="modal-actions"><button type="button" className="btn-secondary" onClick={() => setOffer({ row: offer.row, step: 'ask' })}>Back</button></div>
            </>}
            {offer.step === 'loading' && <p className="settings-note">Getting its synced chats…</p>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Stands in for Claude Code's own trust prompt, which Delegatto's chats skip. The wording
 *  follows Claude Code's. Saying yes also tells Claude Code, so a terminal here won't ask again. */
function TrustPrompt({ trust, skipPermissions }: { trust: FolderTrust; skipPermissions: boolean }) {
  const { contents } = trust
  const found = [
    contents.hooks.length > 0 && `hooks that run commands (${contents.hooks.join(', ')})`,
    contents.mcpServers.length > 0 && `MCP servers it can start (${contents.mcpServers.join(', ')})`,
    contents.settings && 'its own Claude Code settings',
    contents.instructions && 'instructions for Claude (CLAUDE.md)',
    contents.extensions && 'its own skills, commands or agents'
  ].filter((x): x is string => x !== false)
  return (
    <div className="modal-error trust-prompt" role="alert">
      <strong>Quick safety check: is this a project you created or one you trust?</strong>
      <p>Like your own code, a well-known open source project, or work from your team. If not, take a moment to look through this folder first: its files can change what Claude does, and Claude will be able to read, edit and run files here.</p>
      {trust.repoRoot !== null && <p>This folder is part of the repository at <code>{trust.repoRoot}</code>. Trusting it trusts that whole repository, including when you run Claude Code there in a terminal.</p>}
      {trust.home && <p>This is your home folder, so trust lasts until Delegatto closes and isn’t saved.</p>}
      {found.length > 0 && <>
        <p>This folder includes:</p>
        <ul>{found.map(f => <li key={f}>{f}</li>)}</ul>
      </>}
      {skipPermissions && <p>This chat also skips permission prompts, so nothing will ask before Claude acts on those files.</p>}
    </div>
  )
}
