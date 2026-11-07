import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ClaudeCommand } from '../../shared/claude-info-types'

/** Claude Code's commands for this folder, fetched the first time `active` is
 *  true (a process has to start to ask, so never just for opening a chat). */
export function useClaudeCommands(active: boolean, cwd: string | null): ClaudeCommand[] | 'loading' | 'failed' {
  const [commands, setCommands] = useState<ClaudeCommand[] | 'loading' | 'failed'>('loading')
  const asked = useRef(false)
  useEffect(() => {
    if (!active || asked.current) return
    asked.current = true
    void api.claudeInfo(cwd).then(r => setCommands(r.ok ? r.info.commands : 'failed')).catch(() => setCommands('failed'))
  }, [active, cwd])
  return commands
}

/** The project's paths, fetched the first time `active` is true. */
export function useProjectFiles(active: boolean, cwd: string | null): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null)
  const asked = useRef(false)
  useEffect(() => {
    if (!active || asked.current) return
    asked.current = true
    void api.listProjectFiles(cwd).then(setFiles).catch(() => setFiles([]))
  }, [active, cwd])
  return files
}

export type MenuItem = { key: string; primary: string; secondary: string; tag: string | null }

/** The list above the composer. Picks on mousedown so the textarea keeps focus. */
export function CompletionMenu({ label, items, selected, note, onPick, onHover }: {
  label: string
  items: MenuItem[]
  selected: number
  /** Shown in place of the list while there's nothing to pick yet. */
  note: string | null
  onPick: (index: number) => void
  onHover: (index: number) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div className="composer-menu" role="listbox" aria-label={label}>
      {note !== null
        ? <div className="composer-menu-note">{note}</div>
        : <ul ref={listRef}>
            {items.map((item, i) => (
              <li key={item.key} role="option" aria-selected={i === selected}
                className={`composer-menu-item${i === selected ? ' selected' : ''}`}
                onMouseEnter={() => onHover(i)}
                onMouseDown={e => { e.preventDefault(); onPick(i) }}>
                <span className="composer-menu-name">{item.primary}</span>
                {item.tag !== null && <span className="composer-menu-tag">{item.tag}</span>}
                <span className="composer-menu-desc">{item.secondary}</span>
              </li>
            ))}
          </ul>}
    </div>
  )
}
