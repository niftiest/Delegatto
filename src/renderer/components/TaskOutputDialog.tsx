import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { plainTerminalText } from '../lib'

const POLL_MS = 2000

/** What a background command has printed so far: the last 8 KB, as the terminal's /tasks
 *  shows it. Keeps asking while it's open, and keeps the last answer once the task is gone. */
export function TaskOutputDialog({ sessionPk, taskId, title, onClose }: { sessionPk: number; taskId: string; title: string; onClose: () => void }) {
  const [output, setOutput] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [failed, setFailed] = useState(false)
  const box = useRef<HTMLPreElement>(null)
  const following = useRef(true)

  useEffect(() => {
    let alive = true
    const read = (): void => {
      void api.taskOutput(sessionPk, taskId).then(r => {
        if (!alive) return
        if (r === null) { setFailed(true); return }
        setFailed(false)
        setOutput(r.output)
        setTruncated(r.truncated)
      }).catch(() => { if (alive) setFailed(true) })
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [sessionPk, taskId])

  useEffect(() => {
    const el = box.current
    if (el !== null && following.current) el.scrollTop = el.scrollHeight
  }, [output])

  useEffect(() => {
    // Ahead of everything else: behind this dialog, Esc would act on the message box.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="modal-overlay app-dialog-overlay" role="presentation">
      <div className="modal task-output-dialog" role="dialog" aria-modal="true" aria-label="Task output">
        <h2 className="modal-title" title={title}>{title}</h2>
        {truncated && <p className="app-dialog-detail">Showing the most recent output only.</p>}
        <pre ref={box} className="task-output" onScroll={e => { const el = e.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
          {output === null ? (failed ? "This task's output isn't available." : 'Loading…') : output.length === 0 ? 'Nothing printed yet.' : plainTerminalText(output)}
        </pre>
        <div className="modal-actions">
          <button type="button" className="btn-primary" autoFocus onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
