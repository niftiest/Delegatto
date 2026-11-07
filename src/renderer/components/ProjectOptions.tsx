import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings } from '../../shared/shell-types'
import { effectiveThinkingDisplay, effectiveToolDisplay, shownToolDisplay, type ProjectSettings } from '../../shared/project-options'
import type { SessionSummary } from '../../shared/types'
import type { ProjectSyncState } from '../../shared/sync-types'

/** A left/right switch for one of this project's own choices. */
function Switch({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="project-option">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}>
        <span className="switch-knob" />
      </button>
    </div>
  )
}

/** Everything about the open chat and its project that doesn't need to sit in the header:
 *  mode, model, effort and cost, and the choices Settings leaves to
 *  "Choose per project". */
export function ProjectOptions({ settings, chat, onChange, onOpenSettings, session, sessions, onOpenChat, onFork, summary, sync, onSync, children }: {
  /** Sync's state for this project; no value leaves the option out. */
  sync: ProjectSyncState | null
  onSync: (state: ProjectSyncState) => void
  settings: AppSettings
  chat: ProjectSettings
  onChange: (patch: Partial<ProjectSettings>) => void
  onOpenSettings: () => void
  session: SessionSummary
  /** Every chat in this project, to go between them. */
  sessions: SessionSummary[]
  onOpenChat: (chat: SessionSummary) => void
  onFork: () => void
  /** Mode and model, on hover, since they're out of sight until this opens. */
  summary: string
  /** Mode, model, effort and cost. */
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Claude Code's own setting can turn suggestions off; that's checked where they're asked for.
  const tools = effectiveToolDisplay(settings.toolDisplay, chat)
  const thoughts = effectiveThinkingDisplay(settings.thinkingDisplay, chat)
  const suggestions = chat.promptSuggestions ?? settings.promptSuggestions === 'on'

  return (
    <div className="project-options" ref={rootRef}>
      <button type="button" className="chead-term" aria-expanded={open} title={summary} onClick={() => setOpen(o => !o)}>Project options</button>
      {/* Stays mounted while closed: mode and model follow the running chat from in here. */}
      <div className="mcp-pop project-options-pop" role="dialog" aria-label="Project options" hidden={!open}>
          {children}
          <button type="button" className="project-options-link" onClick={() => { setOpen(false); onFork() }}>Fork this chat, to try something else from here</button>
          {sessions.length > 1 && (
            <div className="project-chats">
              <div className="project-option"><span>Chats here</span></div>
              {sessions.slice(0, 30).map(s => (
                <button type="button" key={s.id} className={`project-chat${s.id === session.id ? ' current' : ''}`} title={s.title ?? ''}
                  onClick={() => { setOpen(false); onOpenChat(s) }}>{s.title ?? 'Untitled chat'}</button>
              ))}
            </div>
          )}
          {sync !== null && (
            <Switch label="Sync across your PCs" on={sync.kind === 'on'} onChange={() => { setOpen(false); onSync(sync) }} />
          )}
          <Switch label="Tool calls" on={tools !== 'hidden'}
            onChange={on => onChange({ toolDisplay: on ? shownToolDisplay(settings.toolDisplay) : 'hidden' })} />
          <Switch label="Claude's thoughts" on={thoughts === 'show'}
            onChange={on => onChange({ thinkingDisplay: on ? 'show' : 'hidden' })} />
          <Switch label="Prompt suggestions" on={suggestions}
            onChange={on => onChange({ promptSuggestions: on })} />
          {/* Added with /add-dir. The way back out is here, so one is never stuck on. */}
          {(chat.extraDirs ?? []).length > 0 && <div className="project-dirs">
            <div className="project-option"><span>Other folders Claude can use</span></div>
            {(chat.extraDirs ?? []).map(dir => (
              <div className="project-dir" key={dir}>
                <span title={dir}>{dir}</span>
                <button type="button" className="term-prompt-x" aria-label={`Remove ${dir}`}
                  onClick={() => onChange({ extraDirs: (chat.extraDirs ?? []).filter(d => d !== dir) })}>✕</button>
              </div>
            ))}
          </div>}
          <button type="button" className="project-options-link" onClick={() => { setOpen(false); onOpenSettings() }}>
            Set the default for every project in Settings
          </button>
      </div>
    </div>
  )
}
