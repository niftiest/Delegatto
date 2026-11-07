import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { ChannelRow, SearchHit } from '../../shared/types'
import { groupSearchHits, parseSnippet, flattenSearchPositions, relativeTime, type SearchResultGroup } from '../lib'

/** Ctrl/Cmd+K full-text search across every indexed message. Uses the read
 *  path's FTS `search` (Plan 1). Snippets are rendered as React text nodes via
 *  parseSnippet — never as raw HTML — so untrusted message text can't inject
 *  markup. */
export function SearchOverlay({ channels, onClose, onOpen }: {
  channels: ChannelRow[]
  onClose: () => void
  onOpen: (sessionPk: number, projectDir: string) => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const reqId = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const channelsByDir = useMemo(() => {
    const m = new Map<string, { cwd: string | null; dirName: string; meta: ChannelRow['meta'] }>()
    for (const c of channels) m.set(c.dirName, { cwd: c.cwd, dirName: c.dirName, meta: c.meta })
    return m
  }, [channels])

  const groups = useMemo(() => groupSearchHits(hits, channelsByDir), [hits, channelsByDir])
  const positions = useMemo(() => flattenSearchPositions(groups), [groups])

  // Debounced query; drop stale responses so an older query can't overwrite a newer one's results.
  useEffect(() => {
    const q = query.trim()
    if (q === '') { setHits([]); setLoading(false); return }
    const id = ++reqId.current
    setLoading(true)
    const t = setTimeout(() => {
      void api.search(q).then(result => {
        if (id !== reqId.current) return // superseded
        setHits(result); setActive(0); setLoading(false)
      }).catch(() => { if (id === reqId.current) { setHits([]); setLoading(false) } })
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  function openActive() {
    const pos = positions[active]
    if (pos === undefined) return
    const g = groups[pos.group]
    if (g === undefined) return
    onOpen(g.sessionPk, g.projectDir)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, Math.max(0, positions.length - 1))); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return }
    if (e.key === 'Enter') { e.preventDefault(); openActive(); return }
  }

  return (
    <div className="modal-overlay search-overlay" onClick={onClose} onKeyDown={onKeyDown}>
      <div className="search-box" onClick={e => e.stopPropagation()}>
        <input ref={inputRef} className="search-input" value={query} placeholder="Search all your Claude Code history…"
          onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} aria-label="Search messages" />
        <div className="search-results">
          {query.trim() === '' && <div className="search-hint">Type to search every message across all your projects.</div>}
          {query.trim() !== '' && !loading && hits.length === 0 && <div className="search-hint">No matches.</div>}
          {hits.length > 0 && <div className="search-count">{hits.length} match{hits.length === 1 ? '' : 'es'}</div>}
          {groups.map((g, gi) => (
            <SearchGroup key={g.sessionPk} group={g} groupIndex={gi} activePos={positions[active]}
              onPick={() => onOpen(g.sessionPk, g.projectDir)} />
          ))}
        </div>
      </div>
    </div>
  )
}

function SearchGroup({ group, groupIndex, activePos, onPick }: {
  group: SearchResultGroup; groupIndex: number
  activePos: { group: number; hit: number } | undefined
  onPick: () => void
}) {
  return (
    <div className="search-group">
      <div className="search-group-head">{group.channelName}</div>
      {group.hits.map((h, hi) => {
        const isActive = activePos?.group === groupIndex && activePos.hit === hi
        return (
          // Not keyed by seq: a chat and its subagents each count their messages from 0.
          <div key={hi} className={isActive ? 'search-hit active' : 'search-hit'}
            role="option" aria-selected={isActive} onClick={onPick}>
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
