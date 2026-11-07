import type { Catalog } from './db'
import { coerce, getSettings, updateSettings } from './settings'
import type { AppSettings, ChannelIcon } from '../../shared/shell-types'
import {
  THEME_KEYS, cleanThemeName, isBuiltInThemeName, sameThemeName, themeValuesOf,
  type CustomTheme, type ThemeValues
} from '../../shared/themes'

const STORE_KEY = 'customThemes'
/** About 256 KB of picture, the most the avatar picker allows, once it's base64. */
const MAX_ICON_DATA_URL = 360 * 1024

/** A theme file can come from anyone. An avatar has to be a picture held in the file, and a
 *  color a plain color: either could otherwise make the app fetch something from the internet. */
function safeIcon(icon: ChannelIcon): boolean {
  switch (icon.kind) {
    case 'initials': return true
    case 'emoji': return icon.emoji.length <= 32
    case 'color': return /^#[0-9a-fA-F]{3,8}$/.test(icon.color)
    case 'image': return icon.dataUrl.length <= MAX_ICON_DATA_URL && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(icon.dataUrl)
  }
}

/** Only what a theme may hold, with each value checked the way a setting is. */
export function cleanThemeValues(raw: unknown): ThemeValues {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const key of THEME_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const value = coerce(key, (raw as Record<string, unknown>)[key])
    if (value === undefined) continue
    if (key === 'claudeIcon' && !safeIcon(value as ChannelIcon)) continue
    out[key] = value
  }
  return out as ThemeValues
}

export function listThemes(db: Catalog): CustomTheme[] {
  const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(STORE_KEY) as { value: string } | undefined
  if (row === undefined) return []
  let parsed: unknown
  try { parsed = JSON.parse(row.value) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((t): CustomTheme[] => {
    const name = cleanThemeName((t as { name?: unknown } | null)?.name)
    return name === null ? [] : [{ name, values: cleanThemeValues((t as { values?: unknown }).values) }]
  })
}

function writeThemes(db: Catalog, themes: CustomTheme[]): void {
  const sorted = [...themes].sort((a, b) => a.name.localeCompare(b.name))
  db.prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(STORE_KEY, JSON.stringify(sorted))
}

export function hasTheme(db: Catalog, name: string): boolean {
  return listThemes(db).some(t => sameThemeName(t.name, name))
}

/** Saves a theme and makes it the one in use. Replaces one of the same name, so the caller
 *  asks first. A built-in can never be replaced: it throws rather than relying on that. */
export function saveTheme(db: Catalog, name: string, values: ThemeValues | null): { settings: AppSettings; themes: CustomTheme[]; name: string } {
  const clean = cleanThemeName(name)
  if (clean === null) throw new Error('That is not a usable theme name.')
  if (isBuiltInThemeName(clean)) throw new Error(`${clean} is a built-in theme.`)
  const theme: CustomTheme = { name: clean, values: values === null ? cleanThemeValues(themeValuesOf(getSettings(db))) : cleanThemeValues(values) }
  const themes = [...listThemes(db).filter(t => !sameThemeName(t.name, clean)), theme]
  writeThemes(db, themes)
  const settings = updateSettings(db, { ...theme.values, activeTheme: clean })
  return { settings, themes: listThemes(db), name: clean }
}

/** Makes a saved theme the one in use. Null if it's no longer there. */
export function applyTheme(db: Catalog, name: string): AppSettings | null {
  const theme = listThemes(db).find(t => sameThemeName(t.name, name))
  if (theme === undefined) return null
  return updateSettings(db, { themeColors: {}, ...theme.values, activeTheme: theme.name })
}

/** Removes a saved theme. How the app looks now stays as it is. */
export function deleteTheme(db: Catalog, name: string): { settings: AppSettings; themes: CustomTheme[] } {
  writeThemes(db, listThemes(db).filter(t => !sameThemeName(t.name, name)))
  const current = getSettings(db).activeTheme
  const settings = current !== null && sameThemeName(current, name) ? updateSettings(db, { activeTheme: null }) : getSettings(db)
  return { settings, themes: listThemes(db) }
}

/** What goes in a theme file. */
export function themeFileText(name: string, values: ThemeValues): string {
  return JSON.stringify({ delegattoTheme: 1, name, values }, null, 2)
}

/** Reads a theme file. Null when it isn't one, or when nothing in it is usable. */
export function parseThemeFile(text: string): { name: string | null; values: ThemeValues } | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const file = parsed as { delegattoTheme?: unknown; name?: unknown; values?: unknown }
  if (typeof file.delegattoTheme !== 'number') return null
  const values = cleanThemeValues(file.values)
  if (Object.keys(values).length === 0) return null
  return { name: cleanThemeName(file.name), values }
}
