import { createContext, useEffect, useState } from 'react'
import { api } from '../api'
import { Transcript } from './Transcript'
import type { RenderItem, SessionSummary } from '../../shared/types'

/** Lets a tool card deep in a transcript open what a subagent did. */
export const OpenSubagentContext = createContext<((toolUseId: string) => void) | null>(null)

/** Tools that hand work to a subagent. */
export function isAgentTool(name: string): boolean {
  return name === 'Task' || name === 'Agent'
}

/** A subagent's own transcript, read-only, over the chat that ran it. */
export function SubagentViewer({ toolUseId, onClose }: { toolUseId: string; onClose: () => void }) {
  const [agent, setAgent] = useState<SessionSummary | null | 'loading'>('loading')
  const [items, setItems] = useState<RenderItem[]>([])
  const [oldestSeq, setOldestSeq] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      let found = (await api.listSubagents(toolUseId))[0] ?? null
      if (found === null) {
        await api.indexNow().catch(() => { /* the answer below still stands */ })
        found = (await api.listSubagents(toolUseId))[0] ?? null
      }
      if (!alive) return
      setAgent(found)
      if (found === null) return
      const page = await api.loadTranscript(found.id)
      if (!alive) return
      setItems(page.items); setOldestSeq(page.oldestSeq); setHasMore(page.hasMore)
    })()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { alive = false; window.removeEventListener('keydown', onKey) }
  }, [toolUseId, onClose])

  const loadOlder = (): void => {
    if (agent === null || agent === 'loading' || !hasMore || loadingOlder || oldestSeq === null) return
    setLoadingOlder(true)
    void api.loadTranscript(agent.id, { before: oldestSeq }).then(page => {
      setItems(prev => [...page.items, ...prev]); setOldestSeq(page.oldestSeq); setHasMore(page.hasMore)
    }).finally(() => setLoadingOlder(false))
  }

  return (
    <div className="subagent-view" role="dialog" aria-label="Subagent transcript">
      <div className="subagent-head">
        <strong>Subagent</strong>
        <span className="subagent-title">{agent !== null && agent !== 'loading' ? agent.title ?? '' : ''}</span>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      </div>
      {agent === null
        ? <div className="empty" style={{ flex: 1 }}>This subagent's transcript isn't available. It may not have been indexed yet.</div>
        : <Transcript items={items} hasMore={hasMore} loadingOlder={loadingOlder} loading={agent === 'loading'} onReachTop={loadOlder} />}
    </div>
  )
}
