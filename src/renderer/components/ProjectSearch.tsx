import { forwardRef, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { findTermRanges, searchTerms, type ProjectSearchHit, type ProjectSearchResult } from '../../shared/project-search'
import type { ChannelIcon } from '../../shared/shell-types'
import { formatClock, dayDividerLabel } from '../lib'
import { ClaudeAvatar } from './ClaudeAvatar'
import { Markdown } from './Markdown'

/** The box in the chat header. Ctrl+F focuses it. */
export const ProjectSearchBox = forwardRef<HTMLInputElement, { value: string; onChange: (value: string) => void }>(
  function ProjectSearchBox({ value, onChange }, ref) {
    const clear = (): void => onChange('')
    function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (value.length > 0) clear()
      else e.currentTarget.blur()
    }
    return (
      <div className="project-search">
        <span className="project-search-icon" aria-hidden="true">⌕</span>
        <input ref={ref} type="text" value={value} placeholder="Search this project" aria-label="Search this project's chats"
          title="Show only messages containing these words (Ctrl+F)" spellCheck={false}
          onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} />
        {value.length > 0 && (
          <button type="button" className="project-search-x" aria-label="Clear search" title="Clear"
            onMouseDown={e => e.preventDefault()} onClick={clear}>✕</button>
        )}
      </div>
    )
  }
)

const HIGHLIGHT = 'project-search-hit'

/** Marks the matches without touching the DOM the messages rendered into, so a match
 *  inside bold text or a code block looks the same as any other. */
function highlightTerms(root: HTMLElement, terms: string[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const ranges: Range[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    for (const { start, end } of findTermRanges(node.nodeValue ?? '', terms)) {
      const range = new Range()
      range.setStart(node, start)
      range.setEnd(node, end)
      ranges.push(range)
    }
  }
  CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges))
}

/** The matching messages, in place of the chat, while there's something in the box. */
export function ProjectSearchResults({ query, result, loading, currentSessionPk, claudeIcon, onJump }: {
  query: string
  /** Null until the first answer for this search arrives. */
  result: ProjectSearchResult | null
  loading: boolean
  currentSessionPk: number
  claudeIcon: ChannelIcon
  /** Go to this message in its chat. */
  onJump: (hit: ProjectSearchHit) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  // Newest at the bottom, like the chat.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    root.scrollTop = root.scrollHeight
    if (result !== null) highlightTerms(root, searchTerms(query))
    return () => { CSS.highlights.delete(HIGHLIGHT) }
  }, [result, query])

  const count = result === null ? null
    : result.total === 1 ? '1 message'
    : result.total > result.hits.length ? `Newest ${result.hits.length} of ${result.total.toLocaleString()} messages`
    : `${result.total.toLocaleString()} messages`

  return (
    <div className="stream project-search-results" ref={rootRef} data-loading={loading || undefined}>
      {result === null && <div className="empty">Searching…</div>}
      {result !== null && result.total === 0 && <div className="empty">No messages in this project contain “{query.trim()}”.</div>}
      {result !== null && result.total > 0 && <div className="project-search-count">{count} in this project</div>}
      {result?.hits.map(hit => {
        const time = formatClock(hit.ts)
        const stamp = <time className="turn-time">{dayDividerLabel(hit.ts)}{time ? ` ${time}` : ''}</time>
        const elsewhere = hit.sessionPk !== currentSessionPk
        const chat = (
          <span className="project-search-chat">{elsewhere ? `in ${hit.title ?? 'another chat'}` : 'this chat'}</span>
        )
        // Anywhere on a result goes to it, except links and while selecting text to copy.
        const go = (e: MouseEvent): void => {
          if ((e.target as Element).closest('a, button, summary') !== null) return
          if ((window.getSelection()?.toString() ?? '').length > 0) return
          onJump(hit)
        }
        return hit.role === 'user' ? (
          <div className="turn-user project-search-hit" key={hit.id} title="Go to this message" onClick={go}>
            <div className="turn-user-col">
              <div className="turn-meta">{chat}{stamp}<span className="turn-author">You</span></div>
              <div className="bubble-me txt">{hit.text}</div>
            </div>
          </div>
        ) : (
          <div className="turn project-search-hit" key={hit.id} title="Go to this message" onClick={go}>
            <ClaudeAvatar icon={claudeIcon} size={28} />
            <div className="turn-body">
              <div className="turn-meta"><span className="turn-author claude">Claude</span>{stamp}{chat}</div>
              <Markdown text={hit.text} className="bubble-claude" />
            </div>
          </div>
        )
      })}
    </div>
  )
}
