import { useEffect, useState } from 'react'
import type { EngineSnapshot } from '../../shared/engine-ipc-contract'

/** Best-effort live state from recency (the pool doesn't track "streaming" vs
 *  "idle" explicitly). No pid yet = spawning; recent activity = streaming;
 *  otherwise idle. 'blocked' would need permission state and isn't derived here. */
function engineState(e: EngineSnapshot, now: number): 'spawning' | 'streaming' | 'idle' {
  if (e.pid === null) return 'spawning'
  return now - e.lastActivity < 4000 ? 'streaming' : 'idle'
}

function uptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Engine pool HUD (command-deck §4): one row per live `claude` process, with
 *  its chat, model/effort, pid, uptime, a state pill, and a kill button. Polls
 *  engine:list while open. */
export function EnginePool({ channelNameFor, onClose }: {
  channelNameFor: (sessionKey: string) => string
  onClose: () => void
}) {
  const [engines, setEngines] = useState<EngineSnapshot[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.delegatto.listEngines().then(e => { if (alive) setEngines(e) }).catch(() => {}) }
    refresh()
    const id = setInterval(() => { setNow(Date.now()); refresh() }, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function kill(pid: number): Promise<void> {
    await window.delegatto.killEngine(pid)
    const next = await window.delegatto.listEngines()
    setEngines(next)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="pool" onClick={e => e.stopPropagation()}>
        <div className="pool-head">
          <span className="pool-title">Engine pool</span>
          <span className="pool-sub">{engines.length} live</span>
          <button type="button" className="settings-close" onClick={onClose}>Done</button>
        </div>
        <div className="pool-body">
          {engines.length === 0
            ? <p className="settings-note" style={{ padding: '14px 16px' }}>No engines running. A chat spawns one on its first message; idle ones are reaped.</p>
            : engines.map(e => {
                const state = engineState(e, now)
                return (
                  <div key={e.sessionKey} className="pool-row">
                    <div className="pool-row-main">
                      <div className="pool-row-title">{channelNameFor(e.sessionKey)}</div>
                      <div className="pool-row-sub">{[e.model ?? 'default', e.effort].filter(Boolean).join(' · ')}</div>
                    </div>
                    <span className="pool-pid">{e.pid === null ? '—' : `pid ${e.pid}`}</span>
                    <span className="pool-uptime">{uptime(now - e.startedAt)}</span>
                    <span className={`pool-pill pool-pill-${state}`}>{state}</span>
                    <button type="button" className="pool-kill" title="Stop this engine" aria-label="Stop engine"
                      disabled={e.pid === null} onClick={() => e.pid !== null && void kill(e.pid)}>✕</button>
                  </div>
                )
              })}
        </div>
      </div>
    </div>
  )
}
