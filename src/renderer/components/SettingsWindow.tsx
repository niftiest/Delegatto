import { FONT_SCALE_DEFAULT, FONT_SCALE_MAX, FONT_SCALE_MIN, stepFontScale } from '../../shared/font-settings'
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AppSettings } from '../../shared/shell-types'
import { McpSettings } from './McpSettings'
import { SkillsSettings } from './SkillsSettings'
import { PluginsSettings } from './PluginsSettings'
import { EFFORTS } from '../../shared/models'
import { modelOption, useClaudeModels } from './useClaudeModels'
import { IconPicker } from './IconPicker'
import { ClaudeAvatar } from './ClaudeAvatar'
import { UpdatesPanel } from './UpdatesPanel'
import { ClaudeCodeSettings, type ProjectChoice } from './ClaudeCodeSettings'
import { ChatHistorySettings } from './ChatHistorySettings'
import { SyncSettings } from './SyncSettings'
import { ThemeControls } from './ThemeControls'

export type SettingsSection = 'startup' | 'updates' | 'defaults' | 'notifications' | 'appearance' | 'claude' | 'history' | 'sync' | 'mcp' | 'skills' | 'plugins' | 'openrouter' | 'engine'
type Section = SettingsSection
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'startup', label: 'Startup & System' },
  { id: 'defaults', label: 'New chat defaults' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'history', label: 'Chat history' },
  { id: 'sync', label: 'Project sync' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'skills', label: 'Skills & commands' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'engine', label: 'Engine' },
  { id: 'updates', label: 'Updates' }
]

const PER_PROJECT_HINT = 'This is the default. Each project can change it in Project options, in the chat’s header.'

const IS_WINDOWS = navigator.userAgent.includes('Windows')

/** Sectioned settings, persisted via the settings store. Each control patches
 *  one field through `api.updateSettings`, which validates and returns the full
 *  new settings (so an invalid value is silently reverted to what stuck).
 *  The "MCP & Skills" section is read-only (lists configured servers/skills for
 *  the user + the open project). */
export function SettingsWindow({ onClose, onSettingsChanged, projectCwd = null, sessionPk = null, initialSection, projects = [] }: {
  onClose: () => void
  /** The open chat, so MCP servers can show what it sees and act on them. */
  sessionPk?: number | null
  onSettingsChanged?: (s: AppSettings) => void
  projectCwd?: string | null
  initialSection?: SettingsSection
  /** Projects for the Claude Code / Chat history per-project choices. */
  projects?: ProjectChoice[]
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const models = useClaudeModels()
  const [section, setSection] = useState<Section>(initialSection ?? 'startup')
  // Claude Code's own model/effort, shown as what "(default)" means.
  const [claudeDefaults, setClaudeDefaults] = useState<{ model: string | null; effort: string | null }>({ model: null, effort: null })
  useEffect(() => {
    void api.claudeSettingsGet({ scope: 'user' }).then(v => {
      const m = v.effective.model?.value; const e = v.effective.effortLevel?.value
      setClaudeDefaults({ model: typeof m === 'string' ? m : null, effort: typeof e === 'string' ? e : null })
    }).catch(() => {})
  }, [section])
  const [usage, setUsage] = useState<import('../../shared/ipc').OpenRouterUsage | null | 'loading'>('loading')
  const [claudeIconEdit, setClaudeIconEdit] = useState(false)

  useEffect(() => { void api.getSettings().then(setSettings) }, [])
  useEffect(() => { void api.openRouterUsage().then(setUsage).catch(() => setUsage(null)) }, [])

  async function patch(p: Partial<AppSettings>) {
    const next = await api.updateSettings(p)
    setSettings(next)
    onSettingsChanged?.(next)
  }

  if (settings === null) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-window" onClick={e => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.map(s => (
            <button key={s.id} type="button"
              className={s.id === section ? 'settings-nav-item active' : 'settings-nav-item'}
              onClick={() => setSection(s.id)}>{s.label}</button>
          ))}
          <button type="button" className="settings-close" onClick={onClose}>Done</button>
        </nav>
        <div className="settings-body">
          {section === 'startup' && (
            <Group title="Startup & System">
              {!IS_WINDOWS && <p className="settings-note">Startup and admin options are Windows-only.</p>}
              {IS_WINDOWS && <>
                <Toggle label="Start with Windows" value={settings.startWithWindows} on={v => patch({ startWithWindows: v })} />
                <Toggle label="Start minimized to tray" hint="When Delegatto starts with Windows." value={settings.startMinimized} on={v => patch({ startMinimized: v })} />
                <Toggle label="Start with Admin Rights" hint="Relaunches elevated (UAC prompt). With ‘Start with Windows’, uses a scheduled task."
                  value={settings.startWithAdmin} on={v => patch({ startWithAdmin: v })} />
                <Select label="When I close the window" hint="The tray keeps Delegatto running and notifying you. Quit from the tray icon."
                  value={settings.closeAction}
                  options={[{ value: 'ask', label: 'Ask me' }, { value: 'exit', label: 'Exit' }, { value: 'tray', label: 'Minimize to tray' }]}
                  on={v => patch({ closeAction: v as AppSettings['closeAction'] })} />
                <Toggle label="Show tray icon" hint="Always shown while “minimize to tray” is on." value={settings.showTrayIcon} on={v => patch({ showTrayIcon: v })} />
              </>}
            </Group>
          )}
          {section === 'defaults' && (
            <Group title="New chat defaults">
              <TextField label="Default working directory" hint="Used when no project is open." value={settings.defaultCwd ?? ''} placeholder="(none)" on={v => patch({ defaultCwd: v.trim() === '' ? null : v })} />
              <Select label="Model" value={settings.defaultModel === null ? '' : modelOption(models, settings.defaultModel)}
                options={[
                  { value: '', label: `(Claude Code’s: ${claudeDefaults.model ?? 'default'})` },
                  ...models.map(m => ({ value: m.value, label: m.label })),
                  // What's saved stays visible even when Claude no longer lists it.
                  ...(settings.defaultModel !== null && !models.some(m => m.value === modelOption(models, settings.defaultModel!)) ? [{ value: settings.defaultModel, label: settings.defaultModel }] : [])
                ]}
                on={v => patch({ defaultModel: v === '' ? null : v })} />
              <Select label="Effort" value={settings.defaultEffort ?? ''}
                options={[{ value: '', label: `(Claude Code’s: ${claudeDefaults.effort ?? 'default'})` }, ...EFFORTS.map(e => ({ value: e, label: e }))]}
                on={v => patch({ defaultEffort: v === '' ? null : v })} />
              <p className="settings-note">To change Claude Code’s own defaults (for the terminal too), use Settings → Claude Code.</p>
              <Toggle label="Skip permissions by default" hint="Runs new chats with --dangerously-skip-permissions." value={settings.defaultSkipPermissions} on={v => patch({ defaultSkipPermissions: v })} />
              <Toggle label="Confirm before creating a chat that skips permissions" value={settings.confirmBeforeBypass} on={v => patch({ confirmBeforeBypass: v })} />
              <NumberField label="Spending cap per chat (USD)" hint="Claude stops once a chat has spent this much since Delegatto last started it. Empty = no cap."
                value={settings.defaultBudgetUsd} on={v => patch({ defaultBudgetUsd: v })} />
            </Group>
          )}
          {section === 'notifications' && (
            <Group title="Notifications">
              <p className="settings-note">Desktop notifications for chats that need you while Delegatto isn’t the window in front. Click one to open the chat.</p>
              <Toggle label="Turn complete" value={settings.notifyTurnComplete} on={v => patch({ notifyTurnComplete: v })} />
              <Toggle label="Input needed" value={settings.notifyInputNeeded} on={v => patch({ notifyInputNeeded: v })} />
              <Toggle label="Permission requested" value={settings.notifyPermission} on={v => patch({ notifyPermission: v })} />
              <Toggle label="Error" value={settings.notifyError} on={v => patch({ notifyError: v })} />
              <Toggle label="Do not disturb" value={settings.doNotDisturb} on={v => patch({ doNotDisturb: v })} />
              <TextField label="Quiet hours start (HH:MM)" value={settings.quietHoursStart ?? ''} on={v => patch({ quietHoursStart: v.trim() === '' ? null : v })} />
              <TextField label="Quiet hours end (HH:MM)" value={settings.quietHoursEnd ?? ''} on={v => patch({ quietHoursEnd: v.trim() === '' ? null : v })} />
            </Group>
          )}
          {section === 'appearance' && (
            <Group title="Appearance">
              <ThemeControls settings={settings} patch={patch} onChanged={s => { setSettings(s); onSettingsChanged?.(s) }} />
              {settings.theme === 'terminal' && (
                <Select label="Apply theme to" value={settings.themeScope}
                  options={[{ value: 'chat', label: 'Chat window only' }, { value: 'app', label: 'Sidebar + chat (whole app)' }]}
                  on={v => patch({ themeScope: v as AppSettings['themeScope'] })} />
              )}
              <FontSelect value={settings.appFont} on={v => patch({ appFont: v })} />
              <ScaleField label="Chat text size" hint="The conversation only, in every chat. Ctrl + mouse wheel over the chat changes this too."
                value={settings.chatFontScale} on={v => patch({ chatFontScale: v })} />
              <ScaleField label="Sidebar text size" hint="The chat list and the Files panel." value={settings.sidebarFontScale} on={v => patch({ sidebarFontScale: v })} />
              <Select label="Chat list" value={settings.navDensity}
                options={[{ value: 'comfortable', label: 'Comfortable: icon, name and preview' }, { value: 'compact', label: 'Compact: small icon and name, one line' }]}
                on={v => patch({ navDensity: v as AppSettings['navDensity'] })} />
              <Select label="Messages" value={settings.density} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} on={v => patch({ density: v as AppSettings['density'] })} />
              <div className="settings-row">
                <div className="settings-row-label">Claude avatar
                  <span className="settings-hint">The avatar shown on Claude’s messages (emoji / color / image / AI).</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <ClaudeAvatar icon={settings.claudeIcon} size={28} />
                  <button type="button" className="btn-secondary" onClick={() => setClaudeIconEdit(true)}>Change…</button>
                </div>
              </div>
              <Select label="Tool calls" hint={PER_PROJECT_HINT} value={settings.toolDisplay}
                options={[{ value: 'grouped', label: 'Grouped into one line' }, { value: 'all', label: 'Show all' }, { value: 'hidden', label: 'Hide' }]}
                on={v => patch({ toolDisplay: v as AppSettings['toolDisplay'] })} />
              <Select label="Claude's thoughts" hint={`Hiding them doesn't change what Claude does or what it costs. ${PER_PROJECT_HINT}`} value={settings.thinkingDisplay}
                options={[{ value: 'show', label: 'Show' }, { value: 'hidden', label: 'Hide' }]}
                on={v => patch({ thinkingDisplay: v as AppSettings['thinkingDisplay'] })} />
              <Select label="Prompt suggestions" hint={`Claude predicts your next message as a chip above the box. Each one uses a small amount of your plan or API budget. ${PER_PROJECT_HINT}`} value={settings.promptSuggestions}
                options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
                on={v => patch({ promptSuggestions: v as AppSettings['promptSuggestions'] })} />
              <Toggle label="Show session blade" hint="A column listing a project's sessions, for projects with more than one." value={settings.showBlade} on={v => patch({ showBlade: v })} />
              <Toggle label="Show context rail" hint="The right-hand Files / Context / Usage panel." value={settings.showContextRail} on={v => patch({ showContextRail: v })} />
              <Toggle label="Expand thinking by default" value={settings.thinkingExpanded} on={v => patch({ thinkingExpanded: v })} />
              <Toggle label="Expand tool cards by default" value={settings.toolCardsExpanded} on={v => patch({ toolCardsExpanded: v })} />
            </Group>
          )}
          {section === 'mcp' && (
            <Group title="MCP servers">
              <McpSettings projectCwd={projectCwd} sessionPk={sessionPk} ignored={settings.mcpWarnIgnore} onIgnoredChange={next => void patch({ mcpWarnIgnore: next })} />
            </Group>
          )}
          {section === 'skills' && (
            <Group title="Skills & commands">
              <SkillsSettings projectCwd={projectCwd} />
            </Group>
          )}
          {section === 'plugins' && (
            <Group title="Plugins">
              <PluginsSettings projectCwd={projectCwd} />
            </Group>
          )}
          {section === 'openrouter' && (
            <Group title="OpenRouter">
              <p className="settings-note">Powers AI avatars and the Files “Create Image” tool. Get a key at <code>openrouter.ai/keys</code>. You pick the image model at generation time.</p>
              <TextField label="API key" value={settings.openRouterKey} placeholder="sk-or-v1-…" password
                on={v => patch({ openRouterKey: v.trim() })} />
              <div className="or-usage">
                <div className="or-usage-title">Account</div>
                {usage === 'loading' ? <p className="settings-note">Loading…</p>
                  : usage === null ? <p className="settings-note">{settings.openRouterKey.trim().length === 0 ? 'Add a key to see your spend and balance.' : 'Couldn’t read usage — check the key.'}</p>
                  : <div className="or-usage-tiles">
                      <div className="crail-tile"><div className="crail-tile-k">spent</div><div className="crail-tile-v">${usage.usage.toFixed(2)}</div></div>
                      <div className="crail-tile"><div className="crail-tile-k">balance</div><div className="crail-tile-v">{usage.remaining === null ? '—' : `$${usage.remaining.toFixed(2)}`}</div></div>
                    </div>}
              </div>
            </Group>
          )}
          {section === 'engine' && (
            <Group title="Engine">
              <TextField label="Path to the claude binary" value={settings.claudeBin} on={v => patch({ claudeBin: v })} />
              <NumberField label="Close idle chats after (minutes)" hint="Closes a chat's Claude process once nothing has been running in it for this long. The chat picks up where it was on your next message."
                value={settings.idleReapMin} on={v => patch({ idleReapMin: v ?? 10 })} />
              <Select label="Claude in Chrome" value={settings.chromeIntegration}
                options={[{ value: 'auto', label: 'Automatic (follow Claude Code)' }, { value: 'on', label: 'Always on' }, { value: 'off', label: 'Off' }]}
                on={v => patch({ chromeIntegration: v as AppSettings['chromeIntegration'] })} />
              <TextField label="Extra CLI flags (space-separated)" hint="Added to every Claude process Delegatto starts, e.g. --add-dir D:\shared. Flags Delegatto manages itself are ignored."
                value={settings.extraFlags.join(' ')} on={v => patch({ extraFlags: v.split(/\s+/).filter(Boolean) })} />
            </Group>
          )}
          {section === 'updates' && (
            <Group title="Updates">
              <UpdatesPanel autoInstall={settings.autoInstallUpdates} />
              <Toggle label="Check for updates automatically" hint="On launch and every hour. A new version shows up here and in the corner, and nothing downloads until you click Download. Off: only when you click Check for updates."
                value={settings.autoCheckUpdates} on={v => patch({ autoCheckUpdates: v })} />
              <Toggle label="Install updates automatically" hint="Once you've downloaded an update, restarts into it when nothing is running, no message is unsent, and you've been away for a few minutes. Off: it waits for you to click Restart to update."
                value={settings.autoInstallUpdates} on={v => patch({ autoInstallUpdates: v })} />
            </Group>
          )}
          {section === 'claude' && (
            <Group title="Claude Code">
              <ClaudeCodeSettings projects={projects} initialCwd={projectCwd} />
            </Group>
          )}
          {section === 'sync' && (
            <Group title="Project sync">
              <SyncSettings />
            </Group>
          )}
          {section === 'history' && (
            <Group title="Chat history">
              <ChatHistorySettings settings={settings} patch={patch} projects={projects} />
            </Group>
          )}
        </div>
      </div>
      {claudeIconEdit && (
        <IconPicker
          current={settings.claudeIcon}
          onApply={icon => { void patch({ claudeIcon: icon }); setClaudeIconEdit(false) }}
          onCancel={() => setClaudeIconEdit(false)}
        />
      )}
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-group"><h2>{title}</h2>{children}</section>
}

function Toggle({ label, hint, value, on }: { label: string; hint?: string; value: boolean; on: (v: boolean) => void }) {
  return (
    <label className="settings-row">
      <div className="settings-row-label">{label}{hint && <span className="settings-hint">{hint}</span>}</div>
      <input type="checkbox" checked={value} onChange={e => on(e.target.checked)} />
    </label>
  )
}
function TextField({ label, hint, value, placeholder, on, password }: { label: string; hint?: string; value: string; placeholder?: string; on: (v: string) => void; password?: boolean }) {
  return (
    <label className="settings-row">
      <div className="settings-row-label">{label}{hint && <span className="settings-hint">{hint}</span>}</div>
      <input type={password ? 'password' : 'text'} value={value} placeholder={placeholder} onChange={e => on(e.target.value)} />
    </label>
  )
}
function NumberField({ label, hint, value, on }: { label: string; hint?: string; value: number | null; on: (v: number | null) => void }) {
  return (
    <label className="settings-row">
      <div className="settings-row-label">{label}{hint && <span className="settings-hint">{hint}</span>}</div>
      <input type="number" value={value ?? ''} placeholder="(none)"
        onChange={e => on(e.target.value === '' ? null : Number(e.target.value))} />
    </label>
  )
}
/** A text size: smaller, bigger, and back to how the app comes. */
function ScaleField({ label, hint, value, on }: { label: string; hint?: string; value: number; on: (v: number) => void }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">{label}{hint !== undefined && <span className="settings-hint">{hint}</span>}</div>
      <div className="font-scale">
        {value !== FONT_SCALE_DEFAULT && <button type="button" className="font-scale-reset" onClick={() => on(FONT_SCALE_DEFAULT)}>Reset</button>}
        <button type="button" className="btn-secondary" aria-label={`${label}: smaller`} disabled={value <= FONT_SCALE_MIN} onClick={() => on(stepFontScale(value, 'down'))}>−</button>
        <span className="font-scale-value">{value}%</span>
        <button type="button" className="btn-secondary" aria-label={`${label}: bigger`} disabled={value >= FONT_SCALE_MAX} onClick={() => on(stepFontScale(value, 'up'))}>+</button>
      </div>
    </div>
  )
}

/** The fonts on this PC, as Windows lists them. A saved font stays on the list even if it
 *  has been uninstalled, so the setting doesn't change by itself. */
function FontSelect({ value, on }: { value: string; on: (v: string) => void }) {
  const [fonts, setFonts] = useState<string[] | null>(null)
  useEffect(() => {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts
    if (query === undefined) { setFonts([]); return }
    let alive = true
    void query.call(window).then(list => {
      if (alive) setFonts([...new Set(list.map(f => f.family))].sort((a, b) => a.localeCompare(b)))
    }).catch(() => { if (alive) setFonts([]) })
    return () => { alive = false }
  }, [])
  const names = fonts ?? []
  // Only when the list could be read: a theme's font that isn't here shows the default instead.
  const missing = names.length > 0 ? ' (not on this PC, using the default)' : ''
  return (
    <Select label="Font" hint="Used everywhere except code, which stays monospaced so it lines up." value={value}
      options={[{ value: '', label: 'Default' }, ...(value !== '' && !names.includes(value) ? [{ value, label: `${value}${missing}` }] : []), ...names.map(n => ({ value: n, label: n }))]}
      on={on} />
  )
}

function Select({ label, hint, value, options, on }: {
  label: string; hint?: string; value: string; options: (string | { value: string; label: string })[]; on: (v: string) => void
}) {
  const norm = options.map(o => (typeof o === 'string' ? { value: o, label: o === '' ? '(default)' : o } : o))
  return (
    <label className="settings-row">
      <div className="settings-row-label">{label}{hint !== undefined && <span className="settings-hint">{hint}</span>}</div>
      <select value={value} onChange={e => on(e.target.value)}>
        {norm.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}
