import { useEffect, useState } from 'react'
import { api } from '../api'
import type { RetentionStatus } from '../../shared/claude-settings-types'

/** Below this, Claude Code's own cleanup is worth a heads-up. */
export const LOW_RETENTION_DAYS = 365

/** Why Claude Code may delete chats sooner than the user expects, or null. */
export function retentionWarning(s: RetentionStatus): string | null {
  const lower = s.overrides.filter(o => o.days < s.claudeDays)
  // A period the user set themselves is their choice, however short: only the
  // default they may not know about gets a heads-up.
  if (!s.claudeDaysSet && s.claudeDays < LOW_RETENTION_DAYS) {
    return `Claude Code deletes chats older than ${s.claudeDays} days unless you change it.`
  }
  if (lower.length > 0) {
    const min = Math.min(...lower.map(o => o.days))
    return `${lower.length === 1 ? 'A project sets' : `${lower.length} projects set`} Claude Code to delete chats after ${min} days, which can clean up other projects too.`
  }
  return null
}

/** Slim bar across the chat pane when Claude Code is set to delete old chats
 *  soon. "Keep chats longer" opens Settings → Chat history. */
export function RetentionNotice({ settingsOpen, onOpenSettings, onDismiss }: { settingsOpen: boolean; onOpenSettings: () => void; onDismiss: () => void }) {
  const [status, setStatus] = useState<RetentionStatus | null>(null)
  // Re-read when Settings closes, so fixing the period there clears the bar.
  useEffect(() => {
    if (!settingsOpen) void api.retentionStatus().then(setStatus).catch(() => setStatus(null))
  }, [settingsOpen])
  if (status === null) return null
  const warning = retentionWarning(status)
  if (warning === null) return null
  return (
    <div className="update-bar retention-bar" role="status">
      <span>{warning}</span>
      <button type="button" className="update-bar-btn" onClick={onOpenSettings}>Keep chats longer</button>
      <button type="button" className="update-bar-x" aria-label="Dismiss" title="Don't show again" onClick={onDismiss}>✕</button>
    </div>
  )
}
