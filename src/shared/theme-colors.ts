/** Your own colours on top of a theme: the four main ones. Everything else that
 *  depends on them (hover shades, borders, text) is worked out here so whatever is
 *  chosen, the text stays readable. Pure, so the renderer and tests share it. */

export const THEME_COLOR_KEYS = ['rail', 's1', 'bg', 'accent'] as const
export type ThemeColorKey = typeof THEME_COLOR_KEYS[number]
export type ThemeColors = Partial<Record<ThemeColorKey, string>>

export const THEME_COLOR_LABELS: Record<ThemeColorKey, string> = {
  rail: 'Icon strip', s1: 'Sidebars', bg: 'Chat', accent: 'Accent'
}

const HEX = /^#[0-9a-f]{6}$/i

/** Only known keys with #rrggbb values, in a fixed order. Null when it isn't a colour list at all. */
export function cleanThemeColors(raw: unknown): ThemeColors | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: ThemeColors = {}
  for (const key of THEME_COLOR_KEYS) {
    const v = (raw as Record<string, unknown>)[key]
    if (typeof v === 'string' && HEX.test(v)) out[key] = v.toLowerCase()
  }
  return out
}

type Rgb = [number, number, number]

/** #rgb, #rrggbb, rgb() or rgba(), as a CSS variable may be written. Null otherwise. */
export function parseColor(text: string): Rgb | null {
  const t = text.trim().toLowerCase()
  let m = /^#([0-9a-f]{3})$/.exec(t)
  if (m !== null) return [...m[1]!].map(c => parseInt(c + c, 16)) as Rgb
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t)
  if (m !== null) return [0, 2, 4].map(i => parseInt(m![1]!.slice(i, i + 2), 16)) as Rgb
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(t)
  if (m !== null) return [Number(m[1]), Number(m[2]), Number(m[3])].map(n => Math.min(255, n)) as Rgb
  return null
}

export function toHex(c: Rgb): string {
  return '#' + c.map(n => n.toString(16).padStart(2, '0')).join('')
}

function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

type TextSet = { tx: string; txt: string; mu: string; dim: string }
const LIGHT_TEXT: TextSet = { tx: '#f4f4f5', txt: '#dedee2', mu: '#a3a3ab', dim: '#7c7c85' }
const DARK_TEXT: TextSet = { tx: '#18181a', txt: '#2c2c30', mu: '#5f5f67', dim: '#86868e' }

/** The theme's own values for what these colours change. */
export type ThemeBase = { rail: string; s1: string; bg: string; accent: string } & TextSet

/** Below this, text is still readable but no longer comfortable, so it gets a warning. */
export const READABLE = 4.5

/** What sits on each colour other than the chat's, as selector lists, so its text can
 *  follow that colour alone. Anything not listed sits on the chat colour and takes the
 *  page's text. The renderer reads these from the stylesheet (surfaceSelectors in theme.ts). */
export type SurfaceSelectors = Record<'rail' | 's1', string>

export type ThemeColorResult = {
  /** CSS variables to set on the page root, by name with the leading `--`. */
  vars: Record<string, string>
  /** Rules giving the icon strip and sidebars text of their own. Empty when not needed. */
  css: string
  /** False when some colour has no text that reads well on it. */
  readable: boolean
}

function textVars(t: TextSet): string {
  return Object.entries(t).map(([k, v]) => `--${k}:${v};`).join(' ')
}

// Shades the theme draws from its own surfaces, worked out where they're used so
// they mix with that surface's text.
const SHADES = '--s2:color-mix(in srgb, var(--s1), var(--tx) 7%); --s3:color-mix(in srgb, var(--s1), var(--tx) 13%);'

export function themeColorVars(base: ThemeBase, colors: ThemeColors, selectors: SurfaceSelectors = { rail: '', s1: '' }): ThemeColorResult {
  const vars: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) if (colors[key] !== undefined) vars[`--${key}`] = colors[key]!
  if (Object.keys(vars).length === 0) return { vars, css: '', readable: true }

  // Each colour's own text: the theme's if it reads well there, or whichever of light and dark reads best.
  const ownTx = parseColor(base.tx)
  const textFor = (surface: Rgb): { text: TextSet | null; score: number } => {
    const own = ownTx === null ? 0 : contrast(ownTx, surface)
    if (own >= READABLE) return { text: null, score: own }
    const light = contrast(parseColor(LIGHT_TEXT.tx)!, surface), dark = contrast(parseColor(DARK_TEXT.tx)!, surface)
    return light >= dark ? { text: LIGHT_TEXT, score: light } : { text: DARK_TEXT, score: dark }
  }

  let readable = true
  let css = ''
  const surfaceChanged = colors.rail !== undefined || colors.s1 !== undefined || colors.bg !== undefined
  if (surfaceChanged) {
    const rules: string[] = []
    for (const key of ['bg', 'rail', 's1'] as const) {
      const surface = parseColor(colors[key] ?? base[key])
      if (surface === null) continue
      const { text, score } = textFor(surface)
      if (score < READABLE) readable = false
      if (key === 'bg') { if (text !== null) for (const [k, v] of Object.entries(text)) vars[`--${k}`] = v }
      else if (selectors[key] !== '') rules.push(`:is(${selectors[key]}) { ${text === null ? textVars(base) : textVars(text)} ${SHADES} }`)
    }
    css = rules.join('\n')
    // On the chat, buttons and fields shade from the chat colour; on the sidebars, from theirs.
    vars['--s2'] = 'color-mix(in srgb, var(--bg), var(--tx) 9%)'
    vars['--s3'] = 'color-mix(in srgb, var(--bg), var(--tx) 16%)'
    vars['--sunk'] = 'color-mix(in srgb, var(--s1), #000 12%)'
    vars['--line'] = 'color-mix(in srgb, var(--bg), var(--tx) 14%)'
  }
  if (colors.accent !== undefined || surfaceChanged) vars['--bubble-me'] = 'color-mix(in srgb, var(--accent) 24%, var(--bg))'
  if (colors.accent !== undefined) {
    const accent = parseColor(colors.accent)!
    const white: Rgb = [255, 255, 255], black: Rgb = [17, 17, 17]
    const onWhite = contrast(white, accent) >= contrast(black, accent)
    vars['--on-accent'] = onWhite ? '#fff' : '#111'
    vars['--accent-hover'] = `color-mix(in srgb, var(--accent), ${onWhite ? '#000' : '#fff'} 16%)`
    if (Math.max(contrast(white, accent), contrast(black, accent)) < READABLE) readable = false
  }
  return { vars, css, readable }
}

/** Every variable themeColorVars may set, so they can all be cleared. */
export const THEME_COLOR_VARS = ['--rail', '--s1', '--bg', '--accent', '--tx', '--txt', '--mu', '--dim', '--s2', '--s3', '--sunk', '--line', '--bubble-me', '--on-accent', '--accent-hover']
