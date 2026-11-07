import { useEffect, useRef, useState } from 'react'
import { ThemeColorEditor } from './ThemeColorEditor'
import { api } from '../api'
import type { AppSettings, AppTheme } from '../../shared/shell-types'
import { BUILT_IN_THEMES, MAX_THEME_NAME, activeCustomTheme, themeIsModified, type CustomTheme, type LocalTheme, type ThemeValues } from '../../shared/themes'

const CUSTOM = 'custom:'

/** The theme list, and saving, importing and exporting themes. Choosing a saved theme sets
 *  everything it holds. A built-in's font is the app's own, so leaving a saved theme for one
 *  goes back to that font. A built-in chosen from another built-in only changes the colors. */
export function ThemeControls({ settings, onChanged, patch }: {
  settings: AppSettings
  onChanged: (s: AppSettings) => void
  patch: (p: Partial<AppSettings>) => Promise<void>
}) {
  const [themes, setThemes] = useState<CustomTheme[]>([])
  const [local, setLocal] = useState<LocalTheme[]>([])
  // Open while naming a theme: `values` is what a file brought, null is the app's current look.
  const [naming, setNaming] = useState<{ name: string; values: ThemeValues | null; note: string | null } | null>(null)
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void api.listThemes().then(setThemes); void api.listLocalThemes().then(setLocal) }, [])
  useEffect(() => { if (naming !== null) { nameRef.current?.focus(); nameRef.current?.select() } }, [naming === null])

  const active = activeCustomTheme(settings, themes)
  const modified = active !== null && themeIsModified(settings, active)

  async function choose(value: string): Promise<void> {
    setMessage(null)
    if (value.startsWith(CUSTOM)) {
      const after = await api.applyTheme(value.slice(CUSTOM.length))
      if (after !== null) onChanged(after)
      return
    }
    // Your colours were made for the theme you're leaving.
    await patch({ theme: value as AppTheme, activeTheme: null, themeColors: {}, ...(active !== null ? { appFont: '' } : {}) })
  }

  async function save(): Promise<void> {
    if (naming === null) return
    const result = await api.saveTheme(naming.name, naming.values)
    if (!result.ok) {
      // Said no to overwriting: the name stays there to change.
      if (result.reason !== 'cancelled') setNaming({ ...naming, note: result.message ?? null })
      return
    }
    setThemes(result.themes)
    onChanged(result.settings)
    setNaming(null)
    setMessage({ text: naming.values === null ? `Saved ${result.name}.` : `Imported ${result.name}.`, bad: false })
  }

  async function importFile(): Promise<void> {
    setMessage(null)
    const file = await api.importTheme()
    if (file.status === 'cancelled') return
    if (file.status === 'invalid') { setMessage({ text: file.message, bad: true }); return }
    if (file.status === 'css') {
      setLocal(await api.listLocalThemes())
      await choose(file.id)
      setMessage({ text: `Imported ${file.name}. It’s in your themes folder, on this PC only.`, bad: false })
      return
    }
    if (file.conflict === 'none') {
      const result = await api.saveTheme(file.name, file.values)
      if (result.ok) {
        setThemes(result.themes)
        onChanged(result.settings)
        setMessage({ text: `Imported ${result.name}.`, bad: false })
      } else if (result.reason !== 'cancelled') setMessage({ text: result.message ?? 'Couldn’t import that theme.', bad: true })
      return
    }
    setNaming({
      name: file.name,
      values: file.values,
      note: file.conflict === 'builtin'
        ? `${file.name} is a built-in theme, which can't be overwritten. Choose another name.`
        : `You already have a theme called ${file.name}. Keep the name to overwrite it, or choose another.`
    })
  }

  async function exportFile(): Promise<void> {
    setMessage(null)
    const result = await api.exportTheme(active?.name ?? 'My theme')
    if (result.status === 'saved') setMessage({ text: `Exported to ${result.path}`, bad: false })
    else if (result.status === 'failed') setMessage({ text: `Couldn’t export: ${result.message}`, bad: true })
  }

  async function remove(): Promise<void> {
    if (active === null) return
    setMessage(null)
    const result = await api.deleteTheme(active.name)
    if (result === null) return
    setThemes(result.themes)
    onChanged(result.settings)
    setMessage({ text: `Deleted ${active.name}.`, bad: false })
  }

  return (
    <div className="theme-controls">
      <label className="settings-row">
        <div className="settings-row-label">Theme</div>
        <select value={active !== null ? `${CUSTOM}${active.name}` : settings.theme} onChange={e => void choose(e.target.value)}>
          {BUILT_IN_THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          {local.length > 0 && (
            <optgroup label="On this PC only">
              {local.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </optgroup>
          )}
          {themes.length > 0 && (
            <optgroup label="Your themes">
              {themes.map(t => <option key={t.name} value={`${CUSTOM}${t.name}`}>{t === active && modified ? `${t.name} (modified)` : t.name}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <ThemeColorEditor settings={settings} patch={patch} />
      <div className="settings-row theme-actions-row">
        <div className="settings-row-label">
          <span className="settings-hint">A saved theme holds the settings on this page, your colors included, except text sizes and prompt suggestions.</span>
        </div>
        <div className="theme-actions">
          <button type="button" className="btn-secondary" onClick={() => { setMessage(null); setNaming({ name: active?.name ?? '', values: null, note: null }) }}>Save as theme…</button>
          <button type="button" className="btn-secondary" onClick={() => void importFile()}>Import…</button>
          <button type="button" className="btn-secondary" onClick={() => void exportFile()}>Export…</button>
          {active !== null && <button type="button" className="btn-secondary" onClick={() => void remove()}>Delete</button>}
        </div>
      </div>
      <div className="settings-row theme-actions-row">
        <div className="settings-row-label">
          <span className="settings-hint">Themes on this PC only are .css files in your themes folder. They never leave this PC, and each file's name is the theme's name. Import… takes a .css file too, and copies it there.</span>
        </div>
        <div className="theme-actions">
          <button type="button" className="btn-secondary" onClick={() => void api.openLocalThemes()}>Open themes folder</button>
          <button type="button" className="btn-secondary" onClick={() => void api.listLocalThemes().then(setLocal)}>Refresh</button>
        </div>
      </div>
      {naming !== null && (
        <div className="settings-row theme-name-row">
          <div className="settings-row-label">
            {naming.values === null ? 'Theme name' : 'Name for the imported theme'}
            {naming.note !== null && <span className="settings-hint theme-name-note" role="alert">{naming.note}</span>}
          </div>
          <div className="theme-actions">
            <input ref={nameRef} type="text" aria-label="Theme name" value={naming.name} maxLength={MAX_THEME_NAME}
              onChange={e => setNaming({ ...naming, name: e.target.value, note: null })}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void save() }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(null) }
              }} />
            <button type="button" className="btn-primary" onClick={() => void save()}>Save</button>
            <button type="button" className="btn-secondary" onClick={() => setNaming(null)}>Cancel</button>
          </div>
        </div>
      )}
      {message !== null && <p className={message.bad ? 'settings-note theme-message bad' : 'settings-note theme-message'} role="status">{message.text}</p>}
    </div>
  )
}
