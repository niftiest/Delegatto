import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { ChannelRow, ChatTitleHit, SearchHit } from '../../shared/types'
import { groupSearchHits, parseSnippet, relativeTime, resolveChannelName, type SearchResultGroup } from '../lib'

const MAX_PROJECTS = 6
const MAX_CHATS = 8

/** Where a picked search result should land in its chat, if anywhere in particular. */
export type SearchJump = { uuid: string; seq: number }

/** Projects whose name holds the query, as the chat list names them. */
export function matchingProjects(channels: ChannelRow[], query: string, max = MAX_PROJECTS): ChannelRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  return channels.filter(c => resolveChannelName(c.meta, c.cwd, c.dirName).toLowerCase().includes(q)).slice(0, max)
}

/** One row the arrow keys can land on, in the order the window shows them. */
type Row =
  | { kind: 'project'; channel: ChannelRow }
  | { kind: 'chat'; chat: ChatTitleHit }
  | { kind: 'hit'; group: number; hit: number }

/** Ctrl/Cmd+K: search everything. "Projects / Chats" on top match by name and just open them;
 *  "Chat history" below matches what was said, and goes to that message in its chat. Snippets
 *  are rendered as React text nodes via parseSnippet, never as raw HTML, so untrusted message
 *  text can't inject markup. */
export function SearchOverlay({ channels, onClose, onOpen, onOpenProject }: {
  channels: ChannelRow[]
  onClose: () => void
  /** Opens a chat; with `jump`, at that message. */
  onOpen: (sessionPk: number, projectDir: string, jump: SearchJump | null) => void
  onOpenProject: (channel: ChannelRow) => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [chats, setChats] = useState<ChatTitleHit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const reqId = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const channelsByDir = useMemo(() => {
    const m = new Map<string, ChannelRow>()
    for (const c of channels) m.set(c.dirName, c)
    return m
  }, [channels])

  const projects = useMemo(() => matchingProjects(channels, query), [channels, query])
  const groups = useMemo(() => groupSearchHits(hits, channelsByDir), [hits, channelsByDir])
  const rows = useMemo((): Row[] => [
    ...projects.map(channel => ({ kind: 'project' as const, channel })),
    ...chats.map(chat => ({ kind: 'chat' as const, chat })),
    ...groups.flatMap((g, gi) => g.hits.map((_, hi) => ({ kind: 'hit' as const, group: gi, hit: hi })))
  ], [projects, chats, groups])

  // Debounced query; drop stale responses so an older query can't overwrite a newer one's results.
  useEffect(() => {
    const q = query.trim()
    if (q === '') { setHits([]); setChats([]); setLoading(false); return }
    const id = ++reqId.current
    setLoading(true)
    const t = setTimeout(() => {
      void Promise.all([api.search(q), api.searchChats(q).catch(() => [])]).then(([found, titled]) => {
        if (id !== reqId.current) return // superseded
        setHits(found); setChats(titled.slice(0, MAX_CHATS)); setActive(0); setLoading(false)
      }).catch(() => { if (id === reqId.current) { setHits([]); setChats([]); setLoading(false) } })
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  function openRow(row: Row | undefined) {
    if (row === undefined) return
    if (row.kind === 'project') { onOpenProject(row.channel); return }
    if (row.kind === 'chat') { onOpen(row.chat.sessionPk, row.chat.projectDir, null); return }
    const g = groups[row.group]
    const h = g?.hits[row.hit]
    if (g === undefined || h === undefined) return
    onOpen(g.sessionPk, g.projectDir, h.uuid === null ? null : { uuid: h.uuid, seq: h.seq })
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, Math.max(0, rows.length - 1))); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return }
    if (e.key === 'Enter') { e.preventDefault(); openRow(rows[active]); return }
  }

  // Keep the row the arrow keys are on in view.
  useEffect(() => {
    document.querySelector('.search-results [aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const isActive = (i: number): boolean => i === active
  const named = projects.length + chats.length
  const nothing = query.trim() !== '' && !loading && rows.length === 0

  // Keys are handled once, on the window: the box and the list both sit inside it.
  return (
    <div className="modal-overlay search-overlay" onClick={onClose} onKeyDown={onKeyDown}>
      <div className="search-box" onClick={e => e.stopPropagation()}>
        <input ref={inputRef} className="search-input" value={query} placeholder="Search projects, chats and everything said in them…"
          onChange={e => setQuery(e.target.value)} aria-label="Search projects, chats and messages" />
        <div className="search-results" role="listbox" aria-label="Search results">
          {query.trim() === '' && <div className="search-hint">Type to search project and chat names, and every message across all your projects.</div>}
          {nothing && <div className="search-hint">No matches.</div>}
          {named > 0 && (
            <div className="search-section">
              <div className="search-section-head">Projects / Chats</div>
              {projects.map((c, i) => (
                <div key={`p${c.id}`} className={isActive(i) ? 'search-hit search-name active' : 'search-hit search-name'}
                  role="option" aria-selected={isActive(i)} onClick={() => onOpenProject(c)} onMouseEnter={() => setActive(i)}>
                  <span className="search-name-kind">Project</span>
                  <span className="search-snippet">{resolveChannelName(c.meta, c.cwd, c.dirName)}</span>
                  {c.archived === true && <span className="search-name-note">archived</span>}
                </div>
              ))}
              {chats.map((chat, k) => {
                const i = projects.length + k
                const project = channelsByDir.get(chat.projectDir)
                return (
                  <div key={`c${chat.sessionPk}`} className={isActive(i) ? 'search-hit search-name active' : 'search-hit search-name'}
                    role="option" aria-selected={isActive(i)} onClick={() => onOpen(chat.sessionPk, chat.projectDir, null)} onMouseEnter={() => setActive(i)}>
                    <span className="search-name-kind">Chat</span>
                    <span className="search-snippet">{chat.title ?? 'Untitled chat'}</span>
                    <span className="search-name-note">{project === undefined ? chat.projectDir : resolveChannelName(project.meta, project.cwd, project.dirName)}</span>
                    <time className="search-hit-time">{relativeTime(chat.lastTs)}</time>
                  </div>
                )
              })}
            </div>
          )}
          {hits.length > 0 && (
            <div className="search-section">
              <div className="search-section-head">Chat history <span className="search-count">{hits.length} match{hits.length === 1 ? '' : 'es'}</span></div>
              {groups.map((g, gi) => (
                <SearchGroup key={g.sessionPk} group={g} first={named + groups.slice(0, gi).reduce((n, x) => n + x.hits.length, 0)}
                  active={active} onHover={setActive}
                  onPick={h => onOpen(g.sessionPk, g.projectDir, h.uuid === null ? null : { uuid: h.uuid, seq: h.seq })} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SearchGroup({ group, first, active, onHover, onPick }: {
  group: SearchResultGroup
  /** The row number of this group's first hit, counting every row above it. */
  first: number
  active: number
  onHover: (row: number) => void
  onPick: (hit: SearchHit) => void
}) {
  return (
    <div className="search-group">
      <div className="search-group-head">{group.channelName}</div>
      {group.hits.map((h, hi) => {
        const row = first + hi
        const isActive = row === active
        return (
          // Not keyed by seq: a chat and its subagents each count their messages from 0.
          <div key={hi} className={isActive ? 'search-hit active' : 'search-hit'} role="option" aria-selected={isActive}
            title={h.uuid === null ? 'From a subagent: opens the chat' : 'Go to this message'}
            onClick={() => onPick(h)} onMouseEnter={() => onHover(row)}>
            <span className="search-snippet">
              {parseSnippet(h.snippet).map((seg, i) =>
                seg.marked ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>)}
            </span>
            <time className="search-hit-time">{relativeTime(h.ts)}</time>
          </div>
        )
      })}
    </div>
  )
}
