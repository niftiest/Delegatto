import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { McpServerStatus } from '../../shared/claude-info-types'
import { mcpProblems, mcpStatusLabel } from '../lib'

/** Header warning for MCP servers this chat couldn't use. Without it, the only
 *  sign is that a tool you expected isn't there. */
export function McpChip({ sessionPk, cwd, servers, ignored, onServers, onIgnore, onOpenSettings }: {
  sessionPk: number
  cwd: string | null
  servers: McpServerStatus[]
  ignored: string[]
  onServers: (servers: McpServerStatus[]) => void
  onIgnore: (name: string) => void
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const problems = mcpProblems(servers, ignored)

  // The turn's own report has no error text: fetch the details when opened.
  useEffect(() => {
    if (!open) return
    void api.mcpStatus(sessionPk).then(r => { if (r !== null) onServers(r) })
    const onDown = (e: MouseEvent): void => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionPk])

  useEffect(() => { if (problems.length === 0) setOpen(false) }, [problems.length])

  if (problems.length === 0) return null

  async function reconnect(name: string) {
    setBusy(name)
    setError(null)
    const r = await api.mcpReconnect(sessionPk, name)
    setBusy(null)
    if (r.ok) onServers(r.servers)
    else setError(`${name}: ${r.error}`)
  }
  async function signIn(name: string) {
    setError(null)
    const r = await api.mcpLogin(cwd, name)
    if (!r.ok) setError(`${name}: ${r.error}`)
  }

  return (
    <div className="mcp-chip-wrap" ref={rootRef}>
      <button type="button" className="mcp-chip" aria-expanded={open} onClick={() => setOpen(o => !o)}
        title="Some of this chat's tools aren't available">
        ⚠ {problems.length} MCP {problems.length === 1 ? 'server' : 'servers'} down
      </button>
      {open && (
        <div className="mcp-pop" role="dialog" aria-label="MCP server problems">
          {problems.map(s => (
            <div key={s.name} className="mcp-pop-row">
              <div className="mcp-pop-head">
                <span className="ms-name">{s.name}</span>
                <span className={`mcp-status mcp-status-${s.status}`}>{mcpStatusLabel(s.status)}</span>
              </div>
              {s.error !== null && <div className="mcp-pop-error">{s.error}</div>}
              <div className="mcp-pop-actions">
                {s.status === 'needs-auth'
                  ? <button type="button" className="btn-secondary" onClick={() => void signIn(s.name)}>Sign in…</button>
                  : <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void reconnect(s.name)}>
                      {busy === s.name ? 'Reconnecting…' : 'Reconnect'}</button>}
                <button type="button" className="btn-secondary" onClick={() => onIgnore(s.name)}>Don’t warn me</button>
              </div>
            </div>
          ))}
          {error !== null && <div className="cc-err">{error}</div>}
          <button type="button" className="mcp-pop-all" onClick={() => { setOpen(false); onOpenSettings() }}>All MCP servers</button>
        </div>
      )}
    </div>
  )
}
