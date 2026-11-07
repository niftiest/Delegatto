import type { LiveEvent, PermissionRequest } from '../shared/engine-types'
import type { AppSettings } from '../shared/shell-types'

/** When Delegatto shows a desktop notification (electron-free, unit-tested).
 *  desktop.ts does the showing. */

export type NotifyKind = 'turnComplete' | 'inputNeeded' | 'permission' | 'error'

function minutes(hhmm: string | null): number | null {
  if (hhmm === null) return null
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm)
  if (m === null) return null
  const h = Number(m[1]); const min = Number(m[2])
  return h <= 23 && min <= 59 ? h * 60 + min : null
}

/** True inside [start, end). A window that crosses midnight (22:00-07:00) works;
 *  a missing or invalid time means no quiet hours. */
export function inQuietHours(start: string | null, end: string | null, now: Date): boolean {
  const s = minutes(start); const e = minutes(end)
  if (s === null || e === null || s === e) return false
  const t = now.getHours() * 60 + now.getMinutes()
  return s < e ? t >= s && t < e : t >= s || t < e
}

export function shouldNotify(kind: NotifyKind, s: AppSettings, now: Date): boolean {
  if (s.doNotDisturb || inQuietHours(s.quietHoursStart, s.quietHoursEnd, now)) return false
  switch (kind) {
    case 'turnComplete': return s.notifyTurnComplete
    case 'inputNeeded': return s.notifyInputNeeded
    case 'permission': return s.notifyPermission
    case 'error': return s.notifyError
  }
}

/** A finished turn, or a process that died without finishing one. */
export function classifyEvent(e: LiveEvent): NotifyKind | null {
  // Nobody needs telling about a turn they just stopped themselves.
  if (e.kind === 'result' && e.interrupted === true) return null
  if (e.kind === 'result') return e.isError ? 'error' : 'turnComplete'
  if (e.kind === 'exit' && e.code !== null && e.code !== 0) return 'error'
  return null
}

/** A plan to review or a question for the user is "input needed"; any other tool is a permission request. */
export function classifyPermission(req: PermissionRequest): NotifyKind {
  return req.tool === 'ExitPlanMode' || req.tool === 'AskUserQuestion' ? 'inputNeeded' : 'permission'
}

export function notificationBody(kind: NotifyKind, detail: { text?: string; tool?: string }): string {
  const clip = (t: string): string => {
    const one = t.replace(/\s+/g, ' ').trim()
    return one.length > 140 ? one.slice(0, 137) + '…' : one
  }
  switch (kind) {
    case 'turnComplete': return detail.text !== undefined && detail.text.trim() !== '' ? clip(detail.text) : 'Claude finished replying.'
    case 'error': return detail.text !== undefined && detail.text.trim() !== '' ? `Stopped with an error: ${clip(detail.text)}` : 'Claude stopped with an error.'
    case 'inputNeeded': return detail.tool === 'ExitPlanMode' ? 'Claude has a plan ready for you to review.' : 'Claude has a question for you.'
    case 'permission': return `Claude wants to use ${detail.tool ?? 'a tool'}. Allow or deny it in Delegatto.`
  }
}
