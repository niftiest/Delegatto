import { clampFontScale, FONT_SCALE_DEFAULT, validFontName } from '../../shared/font-settings'
import type { Catalog } from './db'
import { validThemeId } from '../../shared/themes'
import { cleanThemeColors } from '../../shared/theme-colors'
import { SUGGESTIONS_SETTINGS, THINKING_DISPLAY_SETTINGS, TOOL_DISPLAY_SETTINGS, type SuggestionsSetting, type ThinkingDisplaySetting, type ToolDisplaySetting } from '../../shared/project-options'
import { APP_THEME_SCOPES, DEFAULT_THEME, CLOSE_ACTIONS, type AppSettings, type ChannelIcon, type CloseAction } from '../../shared/shell-types'

/** Validate an unknown value as a ChannelIcon (settings persist it as JSON).
 *  Returns undefined when invalid so coerce keeps the prior/default. */
function validateIcon(v: unknown): ChannelIcon | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  switch (o.kind) {
    case 'initials': return { kind: 'initials' }
    case 'emoji': return typeof o.emoji === 'string' ? { kind: 'emoji', emoji: o.emoji } : undefined
    case 'color': return typeof o.color === 'string' ? { kind: 'color', color: o.color } : undefined
    case 'image': return typeof o.dataUrl === 'string' ? { kind: 'image', dataUrl: o.dataUrl } : undefined
    default: return undefined
  }
}

/** The full default settings — a stored value in settings_kv overrides its
 *  default per-key. */
export const DEFAULT_SETTINGS: AppSettings = {
  startWithWindows: false, startMinimized: false, startWithAdmin: false,
  closeAction: 'ask', showTrayIcon: true,
  defaultCwd: null, defaultModel: null, defaultEffort: null,
  defaultSkipPermissions: true, defaultBudgetUsd: null,
  notifyTurnComplete: true, notifyInputNeeded: true, notifyPermission: true, notifyError: true,
  doNotDisturb: false, quietHoursStart: null, quietHoursEnd: null,
  theme: DEFAULT_THEME, themeScope: 'chat', activeTheme: null, themeColors: {}, autoCheckUpdates: true, autoInstallUpdates: true, chromeIntegration: 'auto', density: 'comfortable', navDensity: 'comfortable', chatFontScale: FONT_SCALE_DEFAULT, sidebarFontScale: FONT_SCALE_DEFAULT, appFont: '', thinkingExpanded: false, toolCardsExpanded: false,
  toolDisplay: 'grouped', thinkingDisplay: 'show', promptSuggestions: 'off', showBlade: true, showContextRail: true,
  openRouterKey: '', avatarModel: 'openai/gpt-image-1', claudeIcon: { kind: 'initials' },
  claudeBin: 'claude', idleReapMin: 10, extraFlags: [],
  confirmBeforeBypass: false,
  autoCleanDays: null, autoCleanProjects: {}, retentionNoticeDismissed: false,
  mcpWarnIgnore: [], trustedFolders: []
}

// Pre-theme builds stored 'dark' | 'light' | 'system' (never applied); those
// now fail validation and fall back to the default.
let localThemeExists: (name: string) => boolean = () => false
/** How settings learn which of this PC's own theme files are there (main sets it at startup). */
export function setLocalThemeCheck(check: (name: string) => boolean): void { localThemeExists = check }
const DENSITIES = new Set(['comfortable', 'compact'])
const THEME_SCOPES = new Set<string>(APP_THEME_SCOPES)

function validDays(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 36500
}

/** Coerce/validate one stored or patched field into its typed value; returns
 *  `undefined` when the value is invalid (caller keeps the default / prior). */
export function coerce<K extends keyof AppSettings>(key: K, value: unknown): AppSettings[K] | undefined {
  const def = DEFAULT_SETTINGS[key]
  // Enums
  if (key === 'closeAction') return (CLOSE_ACTIONS.includes(value as CloseAction) ? value : undefined) as AppSettings[K] | undefined
  if (key === 'toolDisplay') return (TOOL_DISPLAY_SETTINGS.includes(value as ToolDisplaySetting) ? value : undefined) as AppSettings[K] | undefined
  if (key === 'thinkingDisplay') return (THINKING_DISPLAY_SETTINGS.includes(value as ThinkingDisplaySetting) ? value : undefined) as AppSettings[K] | undefined
  if (key === 'promptSuggestions') return (SUGGESTIONS_SETTINGS.includes(value as SuggestionsSetting) ? value : undefined) as AppSettings[K] | undefined
  if (key === 'theme') return (typeof value === 'string' ? validThemeId(value, localThemeExists) ?? undefined : undefined) as AppSettings[K] | undefined
  if (key === 'themeColors') return (cleanThemeColors(value) ?? undefined) as AppSettings[K] | undefined
  if (key === 'chromeIntegration') return (value === 'auto' || value === 'on' || value === 'off' ? value : undefined) as AppSettings[K] | undefined
  if (key === 'themeScope') return (typeof value === 'string' && THEME_SCOPES.has(value) ? value : undefined) as AppSettings[K] | undefined
  if (key === 'density' || key === 'navDensity') return (typeof value === 'string' && DENSITIES.has(value) ? value : undefined) as AppSettings[K] | undefined
  if (key === 'chatFontScale' || key === 'sidebarFontScale') return (typeof value === 'number' && Number.isFinite(value) ? clampFontScale(value) : undefined) as AppSettings[K] | undefined
  if (key === 'appFont') return (validFontName(value) ?? undefined) as AppSettings[K] | undefined
  // Bounded numbers
  if (key === 'idleReapMin') return (typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined) as AppSettings[K] | undefined
  // Nullable non-negative money
  if (key === 'defaultBudgetUsd') {
    if (value === null) return null as AppSettings[K]
    return (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined) as AppSettings[K] | undefined
  }
  // Retention: whole days >= 1, or null = never
  if (key === 'autoCleanDays') return (value === null || validDays(value) ? value : undefined) as AppSettings[K] | undefined
  if (key === 'autoCleanProjects') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const out: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.length === 0 || /[\\/:]/.test(k)) return undefined
      if (v !== null && !validDays(v)) return undefined
      out[k] = v as number | null
    }
    return out as AppSettings[K]
  }
  if (key === 'mcpWarnIgnore' || key === 'trustedFolders') return (Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined) as AppSettings[K] | undefined
  // extraFlags: array of strings
  if (key === 'extraFlags') return (Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined) as AppSettings[K] | undefined
  // claudeIcon: a ChannelIcon object
  if (key === 'claudeIcon') return validateIcon(value) as AppSettings[K] | undefined
  // Nullable strings
  if (typeof def === 'string' || def === null) {
    if (value === null) return null as AppSettings[K]
    return (typeof value === 'string' ? value : undefined) as AppSettings[K] | undefined
  }
  // Booleans (every remaining field)
  if (typeof def === 'boolean') return (typeof value === 'boolean' ? value : undefined) as AppSettings[K] | undefined
  return undefined
}

/** Read the full settings object: defaults with any stored kv values validated
 *  over the top. A malformed stored value falls back to the default. */
export function getSettings(db: Catalog): AppSettings {
  const rows = db.prepare('SELECT key, value FROM settings_kv').all() as { key: string; value: string }[]
  const result: AppSettings = { ...DEFAULT_SETTINGS }
  // Replaced by toolDisplay: someone who had turned tool calls off keeps them off.
  if (rows.some(r => r.key === 'showToolCalls' && r.value === 'false')) result.toolDisplay = 'hidden'
  // Replaced by closeAction: someone who had turned this on has already chosen.
  if (rows.some(r => r.key === 'closeToTray' && r.value === 'true')) result.closeAction = 'tray'
  for (const { key, value } of rows) {
    if (!(key in DEFAULT_SETTINGS)) continue
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { continue }
    const coerced = coerce(key as keyof AppSettings, parsed)
    if (coerced !== undefined) (result as Record<string, unknown>)[key] = coerced
  }
  return result
}

/** Apply a partial patch: each valid field is validated and persisted; invalid
 *  values are ignored (the prior/default is kept). Returns the full new settings. */
export function updateSettings(db: Catalog, patch: Partial<AppSettings>): AppSettings {
  const upsert = db.prepare(
    'INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  const write = db.transaction((entries: [string, unknown][]) => {
    for (const [key, raw] of entries) {
      if (!(key in DEFAULT_SETTINGS)) continue
      const coerced = coerce(key as keyof AppSettings, raw)
      if (coerced === undefined) continue
      upsert.run(key, JSON.stringify(coerced))
    }
  })
  write(Object.entries(patch))
  return getSettings(db)
}
