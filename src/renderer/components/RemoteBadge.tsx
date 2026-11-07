/** Small corner badge marking a chat (or a project holding one) that a live
 *  Claude Code process has under Remote Control (`/rc`): it can be driven from
 *  claude.ai or the Claude app. Positioned by the parent's CSS. */
export function RemoteBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`rc-badge ${className}`} role="img"
      aria-label="Remote Control on" title="Remote Control on — this chat can be driven from claude.ai or the Claude app">
      <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
        <circle cx="8" cy="11" r="1.6" fill="currentColor" />
        <path d="M5.2 8.4a4 4 0 0 1 5.6 0" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
        <path d="M2.9 6.1a7.2 7.2 0 0 1 10.2 0" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  )
}
