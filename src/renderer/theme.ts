import { DEFAULT_THEME, type AppTheme, type AppThemeScope } from '../shared/shell-types'
import { validThemeId, isLocalTheme, type LocalTheme } from '../shared/themes'
import { THEME_COLOR_VARS, parseColor, themeColorVars, toHex, type SurfaceSelectors, type ThemeBase, type ThemeColors } from '../shared/theme-colors'

// The persisted source of truth is the `theme` / `themeScope` settings
// (settings_kv). This localStorage copy only exists so the theme can be applied
// synchronously before React's first paint, while the settings IPC is in flight.
const CACHE_KEY = 'delegatto.theme'
const SCOPE_KEY = 'delegatto.themeScope'
// A local theme's text, so its first paint doesn't wait for the themes folder.
const CSS_KEY = 'delegatto.themeCss'
const STYLE_ID = 'local-theme'
// The variables your own colours set, for the first paint.
const VARS_KEY = 'delegatto.themeVars'
const COLORS_CSS_KEY = 'delegatto.themeColorsCss'
const COLORS_STYLE_ID = 'theme-colors'

export type ThemeChoice = { theme: AppTheme; scope: AppThemeScope }

/** Only Terminal can be limited to the chat: every other theme colours the whole window. */
function isWholeWindow(theme: AppTheme): boolean {
  return theme !== 'terminal'
}

/** The theme attribute for the page root. With Terminal in 'chat' scope the rest of
 *  the window keeps the default theme and the chat pane carries the attribute itself
 *  (see chatPaneTheme). */
export function rootTheme(c: ThemeChoice): AppTheme {
  return c.scope === 'app' || isWholeWindow(c.theme) ? c.theme : DEFAULT_THEME
}

/** The `data-theme` for the chat pane (`<main>`) -- styles.css scopes the
 *  terminal skin to any ancestor with `[data-theme="terminal"]`, so putting it
 *  on <main> restyles just the header, transcript and composer. */
export function chatPaneTheme(c: ThemeChoice): AppTheme | undefined {
  return isWholeWindow(c.theme) ? undefined : c.theme
}

/** A local theme's text, nested in its own selector so it can only style its own theme. */
export function localThemeStyle(theme: LocalTheme): string {
  return `[data-theme="${theme.id}"] {\n${theme.css}\n}`
}

function setLocalStyle(text: string | null): void {
  let el = document.getElementById(STYLE_ID)
  if (text === null) { el?.remove(); return }
  if (el === null) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== text) el.textContent = text
}

/** Apply to `<html data-theme>` and remember for the next launch's first paint.
 *  `local` is this PC's theme files: the chosen one's styles are put in the page. */
export function applyTheme(c: ThemeChoice, local: LocalTheme[] = []): void {
  document.documentElement.dataset.theme = rootTheme(c)
  const file = isLocalTheme(c.theme) ? local.find(t => t.id === c.theme) ?? null : null
  // Until the folder has been read, keep what the first paint put there.
  if (!isLocalTheme(c.theme) || file !== null) setLocalStyle(file === null ? null : localThemeStyle(file))
  try {
    localStorage.setItem(CACHE_KEY, c.theme)
    localStorage.setItem(SCOPE_KEY, c.scope)
    if (file !== null) localStorage.setItem(CSS_KEY, localThemeStyle(file))
    else if (!isLocalTheme(c.theme)) localStorage.removeItem(CSS_KEY)
  } catch { /* storage unavailable: first paint just uses the default */ }
}

/** The last-used choice (defaults when nothing is cached). */
export function cachedTheme(): ThemeChoice {
  let theme: string | null = null
  let scope: string | null = null
  try {
    theme = localStorage.getItem(CACHE_KEY)
    scope = localStorage.getItem(SCOPE_KEY)
  } catch { /* ignore */ }
  // A local theme stays until settings say whether its file is still there.
  const id = theme === null ? null : validThemeId(theme, () => true)
  return { theme: id ?? DEFAULT_THEME, scope: scope === 'app' ? 'app' : 'chat' }
}

/** Apply the last-used theme before render (called once from main.tsx). */
export function applyCachedTheme(): void {
  const c = cachedTheme()
  document.documentElement.dataset.theme = rootTheme(c)
  if (isLocalTheme(c.theme)) {
    try { setLocalStyle(localStorage.getItem(CSS_KEY)) } catch { /* ignore */ }
  }
  try {
    const vars = JSON.parse(localStorage.getItem(VARS_KEY) ?? '{}') as Record<string, string>
    for (const [k, v] of Object.entries(vars)) if (THEME_COLOR_VARS.includes(k)) document.documentElement.style.setProperty(k, v)
    setColorsStyle(localStorage.getItem(COLORS_CSS_KEY) ?? '')
  } catch { /* ignore */ }
}

/** The current theme's own colours, without yours on top, as #rrggbb where they can be read. */
export function themeBaseColors(): ThemeBase {
  const root = document.documentElement
  const saved = THEME_COLOR_VARS.map(v => [v, root.style.getPropertyValue(v)] as const)
  for (const v of THEME_COLOR_VARS) root.style.removeProperty(v)
  const cs = getComputedStyle(root)
  const read = (name: string) => { const raw = cs.getPropertyValue(`--${name}`).trim(); const c = parseColor(raw); return c === null ? raw : toHex(c) }
  const base: ThemeBase = { rail: read('rail'), s1: read('s1'), bg: read('bg'), accent: read('accent'), tx: read('tx'), txt: read('txt'), mu: read('mu'), dim: read('dim') }
  for (const [v, value] of saved) if (value !== '') root.style.setProperty(v, value)
  return base
}

function setColorsStyle(text: string): void {
  let el = document.getElementById(COLORS_STYLE_ID)
  if (text === '') { el?.remove(); return }
  if (el === null) {
    el = document.createElement('style')
    el.id = COLORS_STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== text) el.textContent = text
}

let surfaceCache: SurfaceSelectors | null = null
/** Every rule in the app's stylesheet drawn on the icon strip or sidebar colour. The
 *  sunk shade is made from the sidebar colour, so it counts as the sidebar. */
export function surfaceSelectors(): SurfaceSelectors {
  if (surfaceCache !== null) return surfaceCache
  const found: Record<'rail' | 's1', string[]> = { rail: [], s1: [] }
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode instanceof Element && (sheet.ownerNode.id === COLORS_STYLE_ID || sheet.ownerNode.id === STYLE_ID)) continue
    let rules: CSSRuleList
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText.includes('data-theme')) continue
      const m = /background(?:-color)?:\s*var\(--(rail|s1|sunk)\)/.exec(rule.style.cssText)
      if (m !== null) found[m[1] === 'rail' ? 'rail' : 's1'].push(rule.selectorText)
    }
  }
  surfaceCache = { rail: found.rail.join(', '), s1: found.s1.join(', ') }
  return surfaceCache
}

/** Puts your colours on top of the theme, live. False when text may be hard to read. */
export function applyThemeColors(colors: ThemeColors): boolean {
  const root = document.documentElement
  setColorsStyle('')
  const { vars, css, readable } = themeColorVars(themeBaseColors(), colors, surfaceSelectors())
  for (const v of THEME_COLOR_VARS) root.style.removeProperty(v)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  setColorsStyle(css)
  try {
    if (Object.keys(vars).length === 0) { localStorage.removeItem(VARS_KEY); localStorage.removeItem(COLORS_CSS_KEY) }
    else { localStorage.setItem(VARS_KEY, JSON.stringify(vars)); localStorage.setItem(COLORS_CSS_KEY, css) }
  } catch { /* ignore */ }
  return readable
}
