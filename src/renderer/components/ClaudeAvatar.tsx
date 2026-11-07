import type { CSSProperties } from 'react'
import type { ChannelIcon } from '../../shared/shell-types'

/** Claude's avatar in the transcript (and its settings preview). The default
 *  `initials` keeps the classic ✳-on-accent circle; emoji / color / image
 *  override it. App-wide, configured in Settings → Appearance. */
export function ClaudeAvatar({ icon, size = 28 }: { icon: ChannelIcon; size?: number }) {
  const base: CSSProperties = { width: size, height: size }
  if (icon.kind === 'emoji') {
    return <span className="claude-avatar" style={{ ...base, background: 'var(--s3)', fontSize: Math.round(size * 0.6) }} aria-hidden="true">{icon.emoji}</span>
  }
  if (icon.kind === 'color') {
    return <span className="claude-avatar" style={{ ...base, background: icon.color }} aria-hidden="true" />
  }
  if (icon.kind === 'image') {
    return <span className="claude-avatar" style={base} aria-hidden="true"><img src={icon.dataUrl} alt="" /></span>
  }
  return <span className="claude-avatar" style={{ ...base, background: 'var(--accent)' }} aria-hidden="true">✳</span>
}
