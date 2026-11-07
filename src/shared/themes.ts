import { APP_THEMES, type AppSettings, type AppTheme, type BuiltInTheme } from './shell-types'

/** What a saved theme holds: how the app looks. Text sizes stay out: they suit the person and
 *  their screen, whatever the theme. So do prompt suggestions, which spend tokens, so a theme,
 *  and above all someone else's theme file, can't turn them on. */
export const THEME_KEYS = [
  'theme', 'themeScope', 'themeColors', 'appFont', 'navDensity', 'density',
  'claudeIcon', 'toolDisplay', 'thinkingDisplay', 'showBlade', 'showContextRail', 'thinkingExpanded', 'toolCardsExpanded'
] as const satisfies ReadonlyArray<keyof AppSettings>

export type ThemeKey = typeof THEME_KEYS[number]
export type ThemeValues = Partial<Pick<AppSettings, ThemeKey>>
export type CustomTheme = { name: string; values: ThemeValues }

export const BUILT_IN_THEMES: ReadonlyArray<{ id: BuiltInTheme; label: string }> = [
  { id: 'paper', label: 'Paper (light, default)' },
  { id: 'slate', label: 'Slate & Teal' },
  { id: 'ember', label: 'Ember' },
  { id: 'plum', label: 'Plum & Rose' },
  { id: 'forest', label: 'Forest' },
  { id: 'terminal', label: 'Terminal (Claude Code)' }
]

/** A theme file from this PC's themes folder. Its id is `local:<name>`. */
export const LOCAL_THEME_PREFIX = 'local:'
export type LocalTheme = { id: AppTheme; name: string; css: string }

export function isLocalTheme(theme: string): boolean {
  return theme.startsWith(LOCAL_THEME_PREFIX)
}

/** A usable theme id: a built-in, or a theme file that's on this PC. Null otherwise,
 *  so settings fall back to the default. */
export function validThemeId(raw: string, hasLocal: (name: string) => boolean): AppTheme | null {
  if (APP_THEMES.includes(raw as BuiltInTheme)) return raw as BuiltInTheme
  if (isLocalTheme(raw) && hasLocal(raw.slice(LOCAL_THEME_PREFIX.length))) return raw as AppTheme
  return null
}

export const THEME_FILE_EXTENSION = 'delegatto-theme'
export const MAX_THEME_NAME = 60
/** A theme is settings and at most one small avatar. */
export const MAX_THEME_FILE_BYTES = 1024 * 1024

export type SaveThemeResult =
  | { ok: true; settings: AppSettings; themes: CustomTheme[]; name: string }
  | { ok: false; reason: 'name' | 'builtin' | 'cancelled'; message?: string }

export type ImportThemeResult =
  | { status: 'cancelled' }
  | { status: 'invalid'; message: string }
  | { status: 'ready'; name: string; values: ThemeValues; conflict: 'none' | 'custom' | 'builtin' }
  /** A .css file, now in this PC's themes folder. */
  | { status: 'css'; name: string; id: AppTheme }

export type ExportThemeResult =
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }
  | { status: 'saved'; path: string }

/** A usable name, tidied, or null. */
export function cleanThemeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return name.length === 0 || name.length > MAX_THEME_NAME ? null : name
}

export function sameThemeName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Both what a built-in is called in the list and its short name are taken. */
export function isBuiltInThemeName(name: string): boolean {
  return BUILT_IN_THEMES.some(t => sameThemeName(name, t.id) || sameThemeName(name, t.label))
}

export function themeValuesOf(settings: AppSettings): ThemeValues {
  const out: Record<string, unknown> = {}
  for (const key of THEME_KEYS) out[key] = settings[key]
  return out as ThemeValues
}

/** Whether the settings have moved away from the theme they came from. Only what the theme
 *  holds counts: an older file may not hold every setting. */
export function themeIsModified(settings: AppSettings, theme: CustomTheme): boolean {
  return THEME_KEYS.some(key => key in theme.values && JSON.stringify(theme.values[key]) !== JSON.stringify(settings[key]))
}

export function activeCustomTheme(settings: AppSettings, themes: CustomTheme[]): CustomTheme | null {
  const name = settings.activeTheme
  return name === null ? null : themes.find(t => sameThemeName(t.name, name)) ?? null
}

/** A theme's name as a file name Windows will take. */
export function themeFileName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'theme'
  return `${safe}.${THEME_FILE_EXTENSION}`
}

/** A theme's name from the file name the user picked. */
export function themeNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(new RegExp(`\\.(${THEME_FILE_EXTENSION}|json)$`, 'i'), '')
}
