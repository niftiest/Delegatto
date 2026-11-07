import { useEffect, useState } from 'react'
import { api } from '../api'
import { SAVED_EFFORTS } from '../../shared/models'
import { useClaudeModels } from './useClaudeModels'
import {
  PERMISSION_MODES, type ClaudeSettingKey, type ClaudeSettingsPatch, type ClaudeSettingsTarget,
  type ClaudeSettingsView, type SettingSource
} from '../../shared/claude-settings-types'

export type ProjectChoice = { dirName: string; cwd: string | null; name: string }

const SOURCE_LABEL: Record<SettingSource, string> = {
  managed: 'set by your organization',
  local: 'this project, this computer',
  project: 'this project, shared',
  user: 'all projects',
  default: 'Claude Code default'
}

const MODE_LABEL: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: 'Ask before risky actions',
  auto: 'Auto (Claude decides what needs asking)',
  acceptEdits: 'Accept file edits automatically',
  plan: 'Plan first (read-only until approved)',
  bypassPermissions: 'Never ask (bypass permissions)'
}

function show(v: unknown): string {
  if (v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'string') return v === '' ? '(empty)' : v
  return JSON.stringify(v)
}

/** Claude Code's own settings, for every project or one project (shared with
 *  the repo, or this computer only). They apply in Delegatto and in the
 *  terminal alike. */
export function ClaudeCodeSettings({ projects, initialCwd }: { projects: ProjectChoice[]; initialCwd: string | null }) {
  const withCwd = projects.filter((p): p is ProjectChoice & { cwd: string } => p.cwd !== null && p.cwd.length > 0)
  const [cwd, setCwd] = useState<string | null>(null)
  const [projectFile, setProjectFile] = useState<'local' | 'project'>('local')
  const [view, setView] = useState<ClaudeSettingsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const models = useClaudeModels()

  const target: ClaudeSettingsTarget = cwd === null ? { scope: 'user' } : { scope: projectFile, cwd }

  useEffect(() => {
    if (initialCwd !== null && withCwd.some(p => p.cwd === initialCwd)) setCwd(initialCwd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    let alive = true
    setView(null); setError(null)
    void api.claudeSettingsGet(target).then(v => { if (alive) setView(v) }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, projectFile])

  async function save(patch: ClaudeSettingsPatch) {
    setSaving(true)
    try {
      const r = await api.claudeSettingsUpdate(target, patch)
      if (r.ok) { setView(r.view); setError(null) } else setError(r.error)
    } finally { setSaving(false) }
  }

  const scopeName = cwd === null ? 'all projects' : projectFile === 'local' ? 'this project on this computer' : 'this project (shared)'
  const readOnly = view === null || view.error !== null || saving

  /** "Inherit" row for a single-valued key: the select's '' option clears the
   *  key from this file; the hint says what applies instead. */
  function inheritHint(key: ClaudeSettingKey): string {
    if (view === null) return ''
    const eff = view.effective[key]
    if (view.own[key] !== undefined) return eff !== undefined && eff.source !== view.target.scope ? `Overridden: ${show(eff.value)} (${SOURCE_LABEL[eff.source]})` : ''
    if (eff === undefined || eff.source === 'default') return 'Claude Code default'
    return `Currently ${show(eff.value)} (${SOURCE_LABEL[eff.source]})`
  }

  function ChoiceRow({ k, label, options, hint }: {
    k: ClaudeSettingKey; label: string; options: Array<{ value: string; label: string }>; hint?: string
  }) {
    const own = view?.own[k]
    const cur = own === undefined ? '' : typeof own === 'boolean' ? (own ? 'true' : 'false') : String(own)
    const known = options.some(o => o.value === cur)
    return (
      <label className="settings-row">
        <div className="settings-row-label">{label}
          <span className="settings-hint">{[hint, inheritHint(k)].filter(Boolean).join(' · ')}</span>
        </div>
        <select value={cur} disabled={readOnly} onChange={e => {
          const v = e.target.value
          const opt = options.find(o => o.value === v)
          void save({ [k]: v === '' ? null : v === 'true' ? true : v === 'false' ? false : opt?.value ?? v })
        }}>
          <option value="">{cwd === null ? '(not set)' : '(inherit)'}</option>
          {!known && cur !== '' && <option value={cur}>{cur}</option>}
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    )
  }
  const onOff = [{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]

  const rowProps = { view: view!, readOnly, save }

  const attributionOff = view !== null &&
    (view.effective['attribution.commit']?.value === '' && view.effective['attribution.pr']?.value === '' ||
      view.effective['includeCoAuthoredBy']?.value === false && view.effective['attribution.commit']?.value === undefined)
  const ownAttributionOff = view?.own['attribution.commit'] === '' && view?.own['attribution.pr'] === ''

  const mcpOwnOn = Array.isArray(view?.own.enabledMcpjsonServers) ? view!.own.enabledMcpjsonServers as string[] : []
  const mcpOwnOff = Array.isArray(view?.own.disabledMcpjsonServers) ? view!.own.disabledMcpjsonServers as string[] : []
  const mcpEffOn = new Set((view?.lists.enabledMcpjsonServers ?? []).map(e => e.value))
  const mcpEffOff = new Set((view?.lists.disabledMcpjsonServers ?? []).map(e => e.value))
  function setMcp(name: string, state: '' | 'on' | 'off') {
    const on = mcpOwnOn.filter(n => n !== name)
    const off = mcpOwnOff.filter(n => n !== name)
    if (state === 'on') on.push(name)
    if (state === 'off') off.push(name)
    void save({ enabledMcpjsonServers: on.length > 0 ? on : null, disabledMcpjsonServers: off.length > 0 ? off : null })
  }

  return (
    <>
      <p className="settings-note">
        These are Claude Code’s own settings, so they apply here and in the terminal. Changes take effect for chats
        started (or reopened) after you change them.
      </p>
      <div className="cc-scope">
        <select value={cwd ?? ''} onChange={e => setCwd(e.target.value === '' ? null : e.target.value)}>
          <option value="">All projects</option>
          {withCwd.map(p => <option key={p.dirName} value={p.cwd}>{withCwd.filter(q => q.name === p.name).length > 1 ? `${p.name} — ${p.cwd}` : p.name}</option>)}
        </select>
        {cwd !== null && (
          <select value={projectFile} onChange={e => setProjectFile(e.target.value as 'local' | 'project')}>
            <option value="local">Just this computer</option>
            <option value="project">Shared with the repo</option>
          </select>
        )}
      </div>
      {view !== null && <p className="cc-path" title="The file these settings are saved in">{view.path}{view.exists ? '' : ' (created when you change something)'}</p>}
      {error !== null && <div className="cc-err">{error}</div>}
      {view?.error && <div className="cc-err">This file can’t be read, so Delegatto won’t change it: {view.error}</div>}
      {view === null && error === null && <p className="settings-note">Loading…</p>}
      {view !== null && <>
        <h3 className="settings-sub">Model and thinking — {scopeName}</h3>
        <ChoiceRow k="model" label="Model" options={models.map(m => ({ value: m.value, label: m.label }))} />
        <ChoiceRow k="effortLevel" label="Effort" options={SAVED_EFFORTS.map(v => ({ value: v, label: v }))} />
        <ChoiceRow k="alwaysThinkingEnabled" label="Always think before answering" options={onOff} />
        <TextRow {...rowProps} hint={inheritHint('outputStyle')} k="outputStyle" label="Response style" placeholder="e.g. Explanatory" />
        <TextRow {...rowProps} hint={inheritHint('language')} k="language" label="Reply language" placeholder="e.g. English" />

        <h3 className="settings-sub">Permissions</h3>
        <ChoiceRow k="permissions.defaultMode" label="When Claude wants to act"
          hint="Only for chats that don’t skip permissions"
          options={PERMISSION_MODES.map(m => ({ value: m, label: MODE_LABEL[m] }))} />
        <RuleList {...rowProps} k="permissions.allow" title="Always allow" hint="Tools and commands Claude may use without asking. “Allow always” in a chat adds to this project’s list." />
        <RuleList {...rowProps} k="permissions.ask" title="Always ask" hint="Ask every time, even when another rule would allow it." />
        <RuleList {...rowProps} k="permissions.deny" title="Never allow" hint="Blocked, whatever else is set." />

        <h3 className="settings-sub">Commits and memory</h3>
        <label className="settings-row">
          <div className="settings-row-label">Credit Claude in commits and pull requests
            <span className="settings-hint">Currently: {attributionOff ? 'not added' : 'added (Claude Code default)'}{!ownAttributionOff && attributionOff ? ' · set elsewhere' : ''}</span>
          </div>
          <select value={ownAttributionOff ? 'off' : ''} disabled={readOnly}
            onChange={e => void save(e.target.value === 'off'
              ? { 'attribution.commit': '', 'attribution.pr': '' }
              : { 'attribution.commit': null, 'attribution.pr': null })}>
            <option value="">{cwd === null ? '(Claude Code default)' : '(inherit)'}</option>
            <option value="off">Don’t add Claude credits</option>
          </select>
        </label>
        <ChoiceRow k="autoMemoryEnabled" label="Auto memory" hint="Claude saves notes about your project as it works" options={onOff} />
        <ChoiceRow k="autoCompactEnabled" label="Auto compact" hint="Summarize long chats automatically when they fill up" options={onOff} />
        {cwd === null && <ChoiceRow k="remoteControlAtStartup" label="Remote Control for every session" hint="Lets you continue chats from claude.ai or the Claude app" options={onOff} />}

        {cwd !== null && <>
          <h3 className="settings-sub">MCP servers in this project (.mcp.json)</h3>
          {view.projectMcpServers.length === 0
            ? <p className="settings-note">This project has no .mcp.json servers. Your own servers are listed under Settings → MCP servers.</p>
            : <>
                <ChoiceRow k="enableAllProjectMcpServers" label="Turn on every server in .mcp.json" options={onOff} />
                <table className="cc-table"><tbody>
                  {view.projectMcpServers.map(name => {
                    const own = mcpOwnOn.includes(name) ? 'on' : mcpOwnOff.includes(name) ? 'off' : ''
                    const eff = mcpEffOff.has(name) ? 'off' : mcpEffOn.has(name) || view.effective.enableAllProjectMcpServers?.value === true ? 'on' : 'asks first'
                    return (
                      <tr key={name}>
                        <td><code>{name}</code> <span className="cc-src">{eff}</span></td>
                        <td>
                          <select value={own} disabled={readOnly} onChange={e => setMcp(name, e.target.value as '' | 'on' | 'off')}>
                            <option value="">(inherit)</option>
                            <option value="on">On</option>
                            <option value="off">Off</option>
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody></table>
              </>}
        </>}
      </>}
      <RawSettings target={target} onSaved={setView} />
    </>
  )
}

type RowProps = { view: ClaudeSettingsView; readOnly: boolean; save: (p: ClaudeSettingsPatch) => Promise<void> }

function TextRow({ view, readOnly, save, k, label, placeholder, hint }: RowProps & {
  k: ClaudeSettingKey; label: string; placeholder?: string; hint: string
}) {
  const own = view.own[k]
  const saved = typeof own === 'string' ? own : ''
  const [text, setText] = useState(saved)
  useEffect(() => { setText(saved) }, [saved])
  return (
    <label className="settings-row">
      <div className="settings-row-label">{label}<span className="settings-hint">{hint}</span></div>
      <input type="text" value={text} placeholder={placeholder} disabled={readOnly}
        onChange={e => setText(e.target.value)}
        onBlur={() => { if (text.trim() !== saved) void save({ [k]: text.trim() === '' ? null : text.trim() }) }} />
    </label>
  )
}

function RuleList({ view, readOnly, save, k, title, hint }: RowProps & {
  k: 'permissions.allow' | 'permissions.ask' | 'permissions.deny'; title: string; hint: string
}) {
  const [draft, setDraft] = useState('')
  const own = Array.isArray(view.own[k]) ? (view.own[k] as string[]) : []
  const inherited = (view.lists[k] ?? []).filter(e => !own.includes(e.value))
  const add = (): void => {
    const v = draft.trim()
    if (v === '' || own.includes(v)) return
    setDraft('')
    void save({ [k]: [...own, v] })
  }
  return (
    <div className="cc-rules">
      <h3>{title}</h3>
      <p className="settings-note">{hint}</p>
      {own.map(r => (
        <div key={`own:${r}`} className="cc-rule">
          <span className="v">{r}</span>
          <button type="button" title="Remove" disabled={readOnly} onClick={() => void save({ [k]: own.filter(x => x !== r) })}>✕</button>
        </div>
      ))}
      {inherited.map(r => (
        <div key={`inh:${r.source}:${r.value}`} className="cc-rule" title="Set in another settings file">
          <span className="v">{r.value}</span><span className="cc-src">{SOURCE_LABEL[r.source]}</span>
        </div>
      ))}
      {own.length === 0 && inherited.length === 0 && <p className="settings-note">None.</p>}
      <div className="cc-add">
        <input type="text" value={draft} placeholder="e.g. Bash(npm run test:*) or WebFetch(domain:github.com)" disabled={readOnly}
          onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
        <button type="button" className="btn-secondary" disabled={readOnly || draft.trim() === ''} onClick={add}>Add</button>
      </div>
    </div>
  )
}

/** The file itself: Claude Code has far more settings than there are controls for here, and
 *  every one it reads can be set this way. */
function RawSettings({ target, onSaved }: { target: ClaudeSettingsTarget; onSaved: (view: ClaudeSettingsView) => void }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const key = JSON.stringify(target)
  useEffect(() => {
    if (!open) return
    let alive = true
    setNote(null)
    void api.claudeSettingsText(target).then(r => { if (alive) { setPath(r.path); setText(r.text) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])
  async function save() {
    const r = await api.claudeSettingsSaveText(target, text)
    if (r.ok) { onSaved(r.view); setNote({ ok: true, text: 'Saved.' }) }
    else setNote({ ok: false, text: r.error })
  }
  return (
    <details className="cc-raw" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>Edit this settings file directly</summary>
      <p className="settings-note"><code>{path}</code></p>
      <textarea className="cc-raw-text" spellCheck={false} rows={14} value={text} aria-label="Settings file" onChange={e => { setText(e.target.value); setNote(null) }} />
      <div className="cc-raw-actions">
        <button type="button" className="btn-secondary" onClick={() => void save()}>Save</button>
        {note !== null && <span className={note.ok ? 'settings-note' : 'perm-edit-error'}>{note.text}</span>}
      </div>
    </details>
  )
}
