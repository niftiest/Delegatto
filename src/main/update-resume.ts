import { readFileSync, rmSync, writeFileSync } from 'node:fs'

/** What an update puts back: the window as it was and the chat that was open, so the
 *  restart feels like nothing happened. Written just before restarting and read once on
 *  the next launch. Electron-free, so it can be tested. */

export type Bounds = { x: number; y: number; width: number; height: number }
export type ResumeChat = { sessionPk: number; projectDir: string }
export type UpdateResume = {
  at: number
  bounds: Bounds
  maximized: boolean
  minimized: boolean
  /** In the tray, or otherwise out of sight. */
  hidden: boolean
  focused: boolean
  chat: ResumeChat | null
}

/** An old record isn't about this restart: an install that failed, say, then opened days later. */
const RESUME_MAX_AGE_MS = 10 * 60 * 1000
const MIN_WIDTH = 400
const MIN_HEIGHT = 300
/** How much of the window must land on a screen for the old position to be usable. */
const MIN_ON_SCREEN = 100

export function saveResume(file: string, resume: UpdateResume): void {
  writeFileSync(file, JSON.stringify(resume), 'utf8')
}

function isBounds(v: unknown): v is Bounds {
  const b = v as Partial<Bounds> | null
  return typeof b === 'object' && b !== null && [b.x, b.y, b.width, b.height].every(n => typeof n === 'number' && Number.isFinite(n))
}

function isChat(v: unknown): v is ResumeChat {
  const c = v as Partial<ResumeChat> | null
  return typeof c === 'object' && c !== null && typeof c.sessionPk === 'number' && typeof c.projectDir === 'string'
}

/** Reads the record and removes it, so it applies to one launch only. */
export function takeResume(file: string, now: number): UpdateResume | null {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return null }
  try { rmSync(file, { force: true }) } catch { /* it'll be too old next time */ }
  let raw: Partial<UpdateResume>
  try { raw = JSON.parse(text) as Partial<UpdateResume> } catch { return null }
  if (typeof raw.at !== 'number' || now - raw.at > RESUME_MAX_AGE_MS || now < raw.at || !isBounds(raw.bounds)) return null
  return {
    at: raw.at,
    bounds: raw.bounds,
    maximized: raw.maximized === true,
    minimized: raw.minimized === true,
    hidden: raw.hidden === true,
    focused: raw.focused !== false,
    chat: isChat(raw.chat) ? raw.chat : null
  }
}

/** Where to put the window, or null if the screen it was on has gone (a monitor unplugged
 *  during the update) and it would open out of reach. Never bigger than the screen it's on. */
export function usableBounds(bounds: Bounds, workAreas: Bounds[]): Bounds | null {
  const width = Math.max(bounds.width, MIN_WIDTH)
  const height = Math.max(bounds.height, MIN_HEIGHT)
  // The screen holding most of the window, which is the one its size has to fit.
  let onScreen: Bounds | null = null
  let most = 0
  for (const a of workAreas) {
    const across = Math.min(bounds.x + width, a.x + a.width) - Math.max(bounds.x, a.x)
    const down = Math.min(bounds.y + height, a.y + a.height) - Math.max(bounds.y, a.y)
    if (across >= MIN_ON_SCREEN && down >= MIN_ON_SCREEN && across * down > most) {
      onScreen = a
      most = across * down
    }
  }
  if (onScreen === null) return null
  return { x: bounds.x, y: bounds.y, width: Math.min(width, onScreen.width), height: Math.min(height, onScreen.height) }
}
