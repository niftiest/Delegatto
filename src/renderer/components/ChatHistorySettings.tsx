import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings } from '../../shared/shell-types'
import type { AutoCleanPreview, AutoCleanResult, RetentionStatus } from '../../shared/claude-settings-types'
import type { ProjectChoice } from './ClaudeCodeSettings'
import { LOW_RETENTION_DAYS } from './RetentionNotice'

const CLAUDE_PRESETS = [30, 90, 180, 365, 3650]
const CLEAN_PRESETS = [30, 60, 90, 180, 365]

function days(n: number): string {
  if (n >= 3650 && n % 365 === 0) return `${n / 365} years`
  if (n === 365) return '1 year'
  return `${n} days`
}

function size(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`
  return `${bytes} B`
}

function describeRun(r: AutoCleanResult): string {
  const when = new Date(r.at).toLocaleString()
  const what = r.removed === 0 ? 'nothing needed cleaning' : `${r.removed} chat${r.removed === 1 ? '' : 's'} (${size(r.sizeBytes)}) sent to the Recycle Bin`
  const skipped = r.skipped > 0 ? `, ${r.skipped} in use or on a drive without a Recycle Bin left alone` : ''
  return `${when}: ${what}${skipped}.`
}

/** A days picker: presets, a custom number, and optionally "never" / "inherit". */
function DaysSelect({ value, presets, onChange, never, inherit, disabled }: {
  value: number | null | 'inherit'; presets: number[]; onChange: (v: number | null | 'inherit') => void
  never?: string; inherit?: string; disabled?: boolean
}) {
  const [custom, setCustom] = useState(false)
  const cur = value === 'inherit' ? 'inherit' : value === null ? 'never' : presets.includes(value) && !custom ? String(value) : 'custom'
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', maxWidth: '100%' }}>
      <select value={cur} disabled={disabled} onChange={e => {
        const v = e.target.value
        if (v === 'custom') { setCustom(true); return }
        setCustom(false)
        onChange(v === 'inherit' ? 'inherit' : v === 'never' ? null : Number(v))
      }}>
        {inherit !== undefined && <option value="inherit">{inherit}</option>}
        {never !== undefined && <option value="never">{never}</option>}
        {presets.map(p => <option key={p} value={String(p)}>{days(p)}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {cur === 'custom' && (
        <input type="number" min={1} max={36500} style={{ width: 80, minWidth: 0 }} disabled={disabled}
          defaultValue={typeof value === 'number' ? value : 30}
          onBlur={e => { const n = Math.floor(Number(e.target.value)); if (n >= 1 && n <= 36500) onChange(n) }} />
      )}
    </span>
  )
}

/** Settings → Chat history: Claude Code's own cleanup (cleanupPeriodDays, all
 *  projects) and Delegatto's per-project auto-clean. */
export function ChatHistorySettings({ settings, patch, projects }: {
  settings: AppSettings
  patch: (p: Partial<AppSettings>) => Promise<void>
  projects: ProjectChoice[]
}) {
  const [status, setStatus] = useState<RetentionStatus | null>(null)
  const [preview, setPreview] = useState<AutoCleanPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmClean, setConfirmClean] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [addProject, setAddProject] = useState('')

  const reload = (): void => {
    void api.retentionStatus().then(setStatus).catch(e => setError(String(e)))
    void api.retentionPreview().then(setPreview).catch(() => setPreview(null))
  }
  useEffect(reload, [settings.autoCleanDays, settings.autoCleanProjects])

  async function setClaudeDays(n: number) {
    const r = await api.claudeSettingsUpdate({ scope: 'user' }, { cleanupPeriodDays: n })
    if (!r.ok) setError(r.error); else { setError(null); reload() }
  }
  async function clearOverride(cwd: string, file: string) {
    const scope = /settings\.local\.json$/i.test(file) ? 'local' : 'project'
    const r = await api.claudeSettingsUpdate({ scope, cwd }, { cleanupPeriodDays: null })
    if (!r.ok) setError(r.error); else { setError(null); reload() }
  }
  async function setProjectRule(dirName: string, v: number | null | 'inherit') {
    const next = { ...settings.autoCleanProjects }
    if (v === 'inherit') delete next[dirName]
    else next[dirName] = v
    await patch({ autoCleanProjects: next })
  }
  async function cleanNow() {
    setCleaning(true)
    try {
      await api.retentionRunNow()
      setConfirmClean(false)
      reload()
    } catch (e) { setError(String(e)) } finally { setCleaning(false) }
  }

  const nameOf = (dirName: string): string => projects.find(p => p.dirName === dirName)?.name ?? dirName
  const ruled = Object.keys(settings.autoCleanProjects)
  const unruled = projects.filter(p => !ruled.includes(p.dirName))
  const lower = status?.overrides.filter(o => o.days < status.claudeDays) ?? []

  return (
    <>
      {error !== null && <div className="cc-err">{error}</div>}

      <h3 className="settings-sub">Claude Code’s own cleanup</h3>
      <p className="settings-note">
        Claude Code deletes chats (and their file-edit history and pasted images) that haven’t been used for this long,
        across every project, each time a session starts. This is the setting that removed your old chats.
      </p>
      {status === null ? <p className="settings-note">Loading…</p> : <>
        <label className="settings-row">
          <div className="settings-row-label">Delete chats older than
            <span className="settings-hint">{status.claudeDaysSet ? 'Saved in ~/.claude/settings.json' : 'Not set: Claude Code’s 30-day default applies'}</span>
          </div>
          <DaysSelect value={status.claudeDays} presets={CLAUDE_PRESETS} onChange={v => { if (typeof v === 'number') void setClaudeDays(v) }} />
        </label>
        {status.claudeDays < LOW_RETENTION_DAYS && (
          <div className="cc-warn">Chats you haven’t opened for {days(status.claudeDays)} will be deleted. Choose 10 years to keep
            everything (Claude Code has no “never” option).</div>
        )}
        {status.overrides.length > 0 && (
          <div className={lower.length > 0 ? 'cc-warn' : 'settings-note'}>
            {lower.length > 0
              ? 'These project settings files set a shorter period. Starting a chat in one of them can delete old chats in every project:'
              : 'These project settings files set their own period:'}
            <table className="cc-table"><tbody>
              {status.overrides.map(o => (
                <tr key={o.file}>
                  <td><span className="cc-path">{o.file}</span></td>
                  <td>{days(o.days)}</td>
                  <td><button type="button" className="btn-secondary" onClick={() => void clearOverride(o.cwd, o.file)}>Remove</button></td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
      </>}

      <h3 className="settings-sub">Delegatto auto-clean</h3>
      <p className="settings-note">
        Your own per-project rule: chats untouched for this long go to the Recycle Bin, so you can still get them back.
        Runs a few minutes after Delegatto starts and every 6 hours. Chats open anywhere are left alone, and
        nothing is ever deleted permanently.
      </p>
      <label className="settings-row">
        <div className="settings-row-label">For every project</div>
        <DaysSelect value={settings.autoCleanDays} presets={CLEAN_PRESETS} never="Never (default)"
          onChange={v => void patch({ autoCleanDays: v === 'inherit' ? null : v })} />
      </label>
      {ruled.length > 0 && (
        <table className="cc-table"><tbody>
          {ruled.map(dir => (
            <tr key={dir}>
              <td>{nameOf(dir)}</td>
              <td>
                <DaysSelect value={settings.autoCleanProjects[dir] ?? null} presets={CLEAN_PRESETS} never="Never"
                  inherit="Same as every project" onChange={v => void setProjectRule(dir, v)} />
              </td>
            </tr>
          ))}
        </tbody></table>
      )}
      {unruled.length > 0 && (
        <div className="cc-actions">
          <select value={addProject} onChange={e => setAddProject(e.target.value)}>
            <option value="">Add a rule for a project…</option>
            {unruled.map(p => <option key={p.dirName} value={p.dirName}>{projects.filter(q => q.name === p.name).length > 1 && p.cwd !== null ? `${p.name} — ${p.cwd}` : p.name}</option>)}
          </select>
          <button type="button" className="btn-secondary" disabled={addProject === ''}
            onClick={() => { void setProjectRule(addProject, null); setAddProject('') }}>Add</button>
        </div>
      )}
      {preview !== null && (
        <div className="cc-actions">
          <span className="settings-note" style={{ margin: 0 }}>
            {preview.count === 0
              ? 'Right now nothing is old enough to clean.'
              : `Right now this would send ${preview.count} chat${preview.count === 1 ? '' : 's'} (${size(preview.sizeBytes)}) to the Recycle Bin` +
                (preview.byProject.length > 0 ? `, mostly from ${nameOf(preview.byProject[0]!.dirName)}.` : '.')}
          </span>
          {preview.count > 0 && !confirmClean && <button type="button" className="btn-secondary" onClick={() => setConfirmClean(true)}>Clean up now…</button>}
          {confirmClean && <>
            <button type="button" className="btn-primary" disabled={cleaning} onClick={() => void cleanNow()}>
              {cleaning ? 'Cleaning…' : `Send ${preview.count} to the Recycle Bin`}</button>
            <button type="button" className="btn-secondary" disabled={cleaning} onClick={() => setConfirmClean(false)}>Cancel</button>
          </>}
        </div>
      )}
      {status?.lastRun && <p className="settings-note">Last clean: {describeRun(status.lastRun)}</p>}
    </>
  )
}
