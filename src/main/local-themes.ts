import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_THEME_PREFIX, type LocalTheme } from '../shared/themes'

/** Themes kept on this PC only: a folder of .css files under the app's data folder,
 *  never part of the app itself. Each file's name is the theme's name. Its text is
 *  nested inside the theme's own selector, so it can set the colour variables and
 *  style any part of the window. */
export const LOCAL_THEMES_FOLDER = 'themes'
export const MAX_LOCAL_THEME_BYTES = 256 * 1024

export function localThemesDir(userData: string): string {
  return join(userData, LOCAL_THEMES_FOLDER)
}

/** A usable theme name from a file name, or null. */
export function localThemeName(file: string): string | null {
  const m = /^(.+)\.css$/i.exec(file)
  if (m === null) return null
  const name = m[1]!.trim()
  return name.length === 0 || name.length > 60 || /["\\]/.test(name) ? null : name
}

export function listLocalThemes(dir: string): LocalTheme[] {
  let files: string[]
  try { files = readdirSync(dir) } catch { return [] }
  const out: LocalTheme[] = []
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const name = localThemeName(file)
    if (name === null) continue
    const path = join(dir, file)
    try {
      if (!statSync(path).isFile() || statSync(path).size > MAX_LOCAL_THEME_BYTES) continue
      out.push({ id: `${LOCAL_THEME_PREFIX}${name}`, name, css: readFileSync(path, 'utf8') })
    } catch { /* unreadable: left out */ }
  }
  return out
}

export function hasLocalTheme(dir: string, name: string): boolean {
  return listLocalThemes(dir).some(t => t.name.toLowerCase() === name.toLowerCase())
}

/** The folder, made if it isn't there yet. */
export function ensureLocalThemesDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
