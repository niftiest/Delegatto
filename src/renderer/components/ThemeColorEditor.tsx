import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../shared/shell-types'
import { THEME_COLOR_KEYS, THEME_COLOR_LABELS, parseColor, themeColorVars, toHex, type ThemeBase, type ThemeColorKey, type ThemeColors } from '../../shared/theme-colors'
import { applyThemeColors, themeBaseColors } from '../theme'

const SAVE_AFTER_MS = 400

/** The theme's four main colours, each a button that opens a colour picker. Changes show
 *  at once and are saved when you stop. The swatches and Reset keep fixed colours of their
 *  own, so they stay visible whatever the window turns into. */
export function ThemeColorEditor({ settings, patch }: {
  settings: AppSettings
  patch: (p: Partial<AppSettings>) => Promise<void>
}) {
  const [draft, setDraft] = useState<ThemeColors>(settings.themeColors)
  const [base, setBase] = useState<ThemeBase | null>(null)
  const saveTimer = useRef<number | null>(null)
  const pending = useRef<(() => void) | null>(null)
  const saved = JSON.stringify(settings.themeColors)

  useEffect(() => { setDraft(settings.themeColors) }, [saved])
  // After the window has taken the theme on: a child's effects run before App's.
  useEffect(() => {
    const id = window.setTimeout(() => setBase(themeBaseColors()), 50)
    return () => window.clearTimeout(id)
  }, [settings.theme])
  // Closing Settings mid-change still saves it.
  useEffect(() => () => { if (saveTimer.current !== null) window.clearTimeout(saveTimer.current); pending.current?.() }, [])

  function change(next: ThemeColors, now = false): void {
    setDraft(next)
    applyThemeColors(next)
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    const save = () => { saveTimer.current = null; pending.current = null; void patch({ themeColors: next }) }
    pending.current = save
    if (now) save()
    else saveTimer.current = window.setTimeout(save, SAVE_AFTER_MS)
  }

  const shown = (key: ThemeColorKey): string => {
    const c = parseColor(draft[key] ?? base?.[key] ?? '')
    return c === null ? '#808080' : toHex(c)
  }
  const changed = Object.keys(draft).length > 0
  const readable = base === null || themeColorVars(base, draft).readable

  return (
    <div className="settings-row theme-colors-row">
      <div className="settings-row-label">
        Colors
        <span className="settings-hint">Click a color to change it. Text switches between light and dark to stay readable.</span>
      </div>
      <div className="theme-colors">
        {THEME_COLOR_KEYS.map(key => (
          <label key={key} className="theme-color" title={`${THEME_COLOR_LABELS[key]}: ${shown(key)}`}>
            <span className="theme-color-chip" style={{ background: shown(key) }} />
            <span className="theme-color-name">{THEME_COLOR_LABELS[key]}</span>
            <input type="color" value={shown(key)} aria-label={`${THEME_COLOR_LABELS[key]} color`}
              onChange={e => change({ ...draft, [key]: e.target.value })} />
          </label>
        ))}
        <button type="button" className="theme-colors-reset" disabled={!changed}
          title="Go back to the theme's own colors" onClick={() => change({}, true)}>Reset</button>
      </div>
      {!readable && changed && (
        <p className="theme-colors-warn" role="alert">Some text may be hard to read with these colors. Reset goes back to the theme's own.</p>
      )}
    </div>
  )
}
