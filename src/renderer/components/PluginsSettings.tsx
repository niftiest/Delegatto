import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { InstalledPlugin, PluginsState } from '../../shared/command-panels-types'

type Tab = 'installed' | 'discover' | 'marketplaces'
type Scope = 'user' | 'project' | 'local'

const SCOPE_LABEL: Record<string, string> = { user: 'all projects', project: 'this project (shared)', local: 'this project (just you)', managed: 'managed' }

/** Settings → Plugins: what Claude Code's /plugin screen does, through `claude plugin`.
 *  Installed plugins can be turned off, on, updated or removed; Discover installs from
 *  your marketplaces; Marketplaces adds, updates and removes them. Running chats reload
 *  their plugins after each change, as /reload-plugins does. */
export function PluginsSettings({ projectCwd }: { projectCwd: string | null }) {
  const [state, setState] = useState<PluginsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('installed')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('user')
  const [source, setSource] = useState('')

  const load = useCallback(() => {
    setError(null)
    void api.pluginsList(projectCwd).then(r => { if (r.ok) setState(r.value); else setError(r.error) })
  }, [projectCwd])
  useEffect(load, [load])

  async function run(key: string, args: string[], done: string): Promise<void> {
    setBusy(key)
    setNote(null)
    const r = await api.pluginAction(projectCwd, args)
    setBusy(null)
    if (!r.ok) { setNote({ text: r.error, bad: true }); return }
    const reload = r.reloaded > 0 ? ` ${r.reloaded} running chat${r.reloaded === 1 ? '' : 's'} reloaded ${r.reloaded === 1 ? 'its' : 'their'} plugins.` : ''
    setNote({ text: `${done}.${reload}`, bad: false })
    load()
  }

  const installedIds = useMemo(() => new Set(state?.installed.map(p => p.id) ?? []), [state])
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (state?.available ?? []).filter(p => !installedIds.has(p.id))
    const hits = q === '' ? list : list.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.marketplace.toLowerCase().includes(q))
    return hits.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0)).slice(0, 60)
  }, [state, query, installedIds])

  if (error !== null) return <>
    <div className="cc-err">Couldn’t ask Claude Code about plugins: {error}</div>
    <button type="button" className="btn-secondary" onClick={load}>Try again</button>
  </>
  if (state === null) return <p className="settings-note">Asking Claude Code about your plugins…</p>

  const scopeArgs = (p: InstalledPlugin): string[] => p.scope === 'user' || p.scope === 'project' || p.scope === 'local' ? ['--scope', p.scope] : []
  const projectOnly = projectCwd === null

  return <>
    <div className="plugin-tabs" role="tablist">
      {(['installed', 'discover', 'marketplaces'] as const).map(t => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'plugin-tab active' : 'plugin-tab'} onClick={() => { setTab(t); setNote(null) }}>
          {t === 'installed' ? `Installed (${state.installed.length})` : t === 'discover' ? 'Discover' : `Marketplaces (${state.marketplaces.length})`}
        </button>
      ))}
      <button type="button" className="btn-secondary plugin-refresh" onClick={() => { setState(null); load() }}>Refresh</button>
    </div>
    {note !== null && <div className={note.bad ? 'cc-err' : 'settings-note plugin-note'} role="status">{note.text}</div>}

    {tab === 'installed' && <div className="ms-list">
      {state.installed.length === 0 && <p className="settings-note">No plugins installed. Find some under Discover.</p>}
      {state.installed.map(p => (
        <div key={`${p.id}:${p.scope}:${p.projectPath ?? ''}`} className="ms-item">
          <div className="ms-item-head">
            <span className="ms-name">{p.name}</span>
            <span className="ms-badge" title="Marketplace">{p.marketplace}</span>
            {p.version !== '' && <span className="ms-detail" style={{ margin: 0 }}>{p.version.length > 12 ? p.version.slice(0, 12) : p.version}</span>}
            <span className={`ms-scope ms-scope-${p.scope}`} title={p.projectPath ?? undefined}>{SCOPE_LABEL[p.scope] ?? p.scope}</span>
            <span className={p.enabled ? 'mcp-status mcp-status-connected' : 'mcp-status mcp-status-disabled'}>{p.enabled ? 'On' : 'Off'}</span>
            <span className="mcp-item-actions">
              <button type="button" className="btn-secondary" disabled={busy !== null}
                onClick={() => void run(p.id, [p.enabled ? 'disable' : 'enable', p.id, ...scopeArgs(p)], `${p.enabled ? 'Turned off' : 'Turned on'} ${p.name}`)}>
                {busy === p.id ? 'Working…' : p.enabled ? 'Turn off' : 'Turn on'}</button>
              <button type="button" className="btn-secondary" disabled={busy !== null}
                onClick={() => void run(`${p.id}:update`, ['update', p.id, ...scopeArgs(p)], `Updated ${p.name}`)}>
                {busy === `${p.id}:update` ? 'Updating…' : 'Update'}</button>
              <button type="button" className="btn-secondary" disabled={busy !== null}
                onClick={() => void run(`${p.id}:remove`, ['uninstall', p.id, ...scopeArgs(p)], `Removed ${p.name}`)}>
                {busy === `${p.id}:remove` ? 'Removing…' : 'Remove'}</button>
            </span>
          </div>
          {p.projectPath !== null && <div className="ms-detail">For {p.projectPath}</div>}
          {p.mcpServers.length > 0 && <div className="ms-detail">MCP servers: {p.mcpServers.join(', ')}</div>}
        </div>
      ))}
    </div>}

    {tab === 'discover' && <>
      <div className="cc-actions plugin-search">
        <input type="search" placeholder={`Search ${state.available.length} plugins`} aria-label="Search plugins" value={query} onChange={e => setQuery(e.target.value)} />
        <label className="plugin-scope">Install for
          <select value={scope} onChange={e => setScope(e.target.value as Scope)}>
            <option value="user">all projects</option>
            <option value="project" disabled={projectOnly}>this project (shared)</option>
            <option value="local" disabled={projectOnly}>this project (just you)</option>
          </select>
        </label>
      </div>
      <div className="ms-list">
        {found.length === 0 && <p className="settings-note">{query.trim() === '' ? 'Nothing new in your marketplaces. Add one under Marketplaces.' : 'No plugins match.'}</p>}
        {found.map(p => (
          <div key={p.id} className="ms-item">
            <div className="ms-item-head">
              <span className="ms-name">{p.name}</span>
              <span className="ms-badge">{p.marketplace}</span>
              {p.installs !== null && <span className="ms-detail" style={{ margin: 0 }}>{p.installs.toLocaleString()} installs</span>}
              <span className="mcp-item-actions">
                <button type="button" className="btn-secondary" disabled={busy !== null}
                  onClick={() => void run(p.id, ['install', p.id, '--scope', scope], `Installed ${p.name}`)}>
                  {busy === p.id ? 'Installing…' : 'Install'}</button>
              </span>
            </div>
            {p.description !== '' && <div className="ms-detail plugin-desc">{p.description}</div>}
          </div>
        ))}
      </div>
      <p className="settings-note">Plugins run code on your PC. Install only ones you trust.</p>
    </>}

    {tab === 'marketplaces' && <>
      <div className="ms-list">
        {state.marketplaces.map(m => (
          <div key={m.name} className="ms-item">
            <div className="ms-item-head">
              <span className="ms-name">{m.name}</span>
              <span className="ms-badge">{m.source}</span>
              <span className="mcp-item-actions">
                <button type="button" className="btn-secondary" disabled={busy !== null}
                  onClick={() => void run(`m:${m.name}:update`, ['marketplace', 'update', m.name], `Updated ${m.name}`)}>
                  {busy === `m:${m.name}:update` ? 'Updating…' : 'Update'}</button>
                <button type="button" className="btn-secondary" disabled={busy !== null}
                  onClick={() => void run(`m:${m.name}:remove`, ['marketplace', 'remove', m.name], `Removed ${m.name}`)}>
                  {busy === `m:${m.name}:remove` ? 'Removing…' : 'Remove'}</button>
              </span>
            </div>
            {m.where !== '' && <div className="ms-detail">{m.where}</div>}
          </div>
        ))}
      </div>
      <div className="cc-actions plugin-search">
        <input type="text" placeholder="owner/repo, a git URL, or a folder" aria-label="Marketplace to add" value={source} onChange={e => setSource(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && source.trim() !== '') { e.preventDefault(); void run('m:add', ['marketplace', 'add', source.trim()], `Added ${source.trim()}`).then(() => setSource('')) } }} />
        <button type="button" className="btn-secondary" disabled={busy !== null || source.trim() === ''}
          onClick={() => void run('m:add', ['marketplace', 'add', source.trim()], `Added ${source.trim()}`).then(() => setSource(''))}>
          {busy === 'm:add' ? 'Adding…' : 'Add marketplace'}</button>
      </div>
    </>}
  </>
}
