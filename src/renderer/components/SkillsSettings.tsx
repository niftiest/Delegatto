import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { SkillInfo } from '../../shared/ipc'
import type { ClaudeCommand, CommandSource } from '../../shared/claude-info-types'
import { filterCommands } from '../lib'

const GROUPS: Array<{ source: CommandSource; title: string }> = [
  { source: 'project', title: 'This project' },
  { source: 'user', title: 'Personal' },
  { source: 'plugin', title: 'From plugins' },
  { source: 'synced', title: 'Synced from claude.ai' },
  { source: 'builtin', title: 'Built into Claude Code' }
]

/** Settings → Skills & commands: everything Claude Code offers for this folder,
 *  as Claude itself reports it. Falls back to scanning the skills folders if
 *  Claude can't be asked (not installed, not logged in, still starting). */
export function SkillsSettings({ projectCwd }: { projectCwd: string | null }) {
  const [commands, setCommands] = useState<ClaudeCommand[] | null>(null)
  const [fallback, setFallback] = useState<{ error: string; skills: SkillInfo[] } | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    setCommands(null)
    setFallback(null)
    void api.claudeInfo(projectCwd).then(async r => {
      if (!alive) return
      if (r.ok) { setCommands(r.info.commands); return }
      const skills = await api.listSkills(projectCwd)
      if (alive) setFallback({ error: r.error, skills })
    })
    return () => { alive = false }
  }, [projectCwd])

  const shown = useMemo(() => commands === null ? [] : query.trim() === '' ? commands : filterCommands(commands, query.trim(), commands.length), [commands, query])

  if (fallback !== null) {
    return <>
      <div className="cc-warn">Couldn’t ask Claude Code for the full list ({fallback.error}). Showing skill folders only, without plugins or built-in commands.</div>
      <div className="ms-list">
        {fallback.skills.map(s => (
          <div key={`${s.scope}:${s.name}`} className="ms-item">
            <div className="ms-item-head">
              <span className="ms-name">{s.userInvocable ? `/${s.name}` : s.name}</span>
              <span className={`ms-scope ms-scope-${s.scope}`}>{s.scope}</span>
            </div>
            {s.description && <div className="ms-detail">{s.description}</div>}
          </div>
        ))}
      </div>
    </>
  }
  if (commands === null) return <p className="settings-note">Asking Claude Code…</p>

  return <>
    <p className="settings-note">{commands.length} available{projectCwd !== null ? ' in this project' : ''}. Type <code>/</code> in a chat to use one.</p>
    <input className="skills-filter" type="search" placeholder="Filter" aria-label="Filter skills and commands"
      value={query} onChange={e => setQuery(e.target.value)} />
    {GROUPS.map(({ source, title }) => {
      const group = shown.filter(c => c.source === source || (source === 'builtin' && c.source === 'mcp'))
      if (group.length === 0) return null
      return <div key={source}>
        <h3 className="settings-sub">{title} ({group.length})</h3>
        <div className="ms-list">
          {group.map(c => (
            <div key={c.name} className="ms-item">
              <div className="ms-item-head">
                <span className="ms-name">/{c.name}</span>
                {c.argumentHint !== '' && <span className="ms-badge">{c.argumentHint}</span>}
              </div>
              {c.description !== '' && <div className="ms-detail">{c.description}</div>}
            </div>
          ))}
        </div>
      </div>
    })}
    {shown.length === 0 && <p className="settings-note">Nothing matches.</p>}
  </>
}
