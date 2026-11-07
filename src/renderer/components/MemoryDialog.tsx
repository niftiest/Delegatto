import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { MemoryFile, MemoryFileContent } from '../../shared/project-memory-types'

function savedNote(restarted: number, afterTurn: number, inTerminal: number): string {
  const parts = ['Saved.']
  if (restarted > 0) parts.push(`${restarted} idle ${restarted === 1 ? 'chat' : 'chats'} will pick it up on the next message.`)
  if (afterTurn > 0) parts.push(`${afterTurn} ${afterTurn === 1 ? 'chat that’s' : 'chats that are'} replying will pick it up on the message after this reply.`)
  if (inTerminal > 0) parts.push(`${inTerminal} open in a terminal ${inTerminal === 1 ? 'needs' : 'need'} restarting there to pick it up.`)
  return parts.join(' ')
}

/** View and edit the files that shape what Claude remembers for a project. */
export function MemoryDialog({ projectId, title, onClose }: { projectId: number; title: string; onClose: () => void }) {
  const [files, setFiles] = useState<MemoryFile[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<MemoryFileContent | null>(null)
  const [text, setText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<string | 'close' | null>(null)

  const dirty = loaded !== null && text !== loaded.text
  const current = files?.find(f => f.id === selected) ?? null

  const open = useCallback(async (id: string) => {
    setSelected(id)
    setLoaded(null)
    setMessage(null)
    setError(null)
    setPendingSwitch(null)
    try {
      const content = await api.memoryRead(projectId, id)
      setLoaded(content)
      setText(content.text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [projectId])

  const refresh = useCallback(async (): Promise<MemoryFile[]> => {
    const list = await api.memoryList(projectId)
    setFiles(list)
    return list
  }, [projectId])

  useEffect(() => {
    void refresh().then(list => {
      const first = list.find(f => f.exists) ?? list[0]
      if (first !== undefined) void open(first.id)
    })
  }, [refresh, open])

  function request(target: string | 'close') {
    if (dirty) { setPendingSwitch(target); return }
    if (target === 'close') onClose(); else void open(target)
  }

  async function save() {
    if (selected === null || loaded === null) return
    setSaving(true)
    setError(null)
    setMessage(null)
    const r = await api.memorySave(projectId, selected, text, loaded.mtimeMs)
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    setLoaded(r.content)
    setMessage(savedNote(r.restarted, r.afterTurn, r.inTerminal))
    void refresh()
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={() => request('close')}>
      <div className="modal memory-dialog" role="dialog" aria-modal="true" aria-label={`Memory for ${title}`} onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">Memory for {title}</h2>
        <div className="memory-body">
          <ul className="memory-files">
            {files === null && <li className="settings-note">Loading…</li>}
            {files?.map(f => (
              <li key={f.id}>
                <button type="button" className={`memory-file${f.id === selected ? ' active' : ''}`} onClick={() => request(f.id)}>
                  {f.label}{!f.exists && <span className="memory-new"> (new)</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="memory-editor">
            {current !== null && <p className="settings-note memory-note">{current.note}{!current.exists && ' It doesn’t exist yet: saving creates it.'}</p>}
            <textarea className="field-input memory-text" spellCheck={false} value={text} disabled={loaded === null}
              aria-label={current?.label ?? 'File contents'} onChange={e => { setText(e.target.value); setMessage(null) }} />
          </div>
        </div>
        {error !== null && <div className="modal-error" role="alert">{error}</div>}
        {message !== null && <div className="memory-saved" role="status">{message}</div>}
        {pendingSwitch !== null && <div className="modal-error" role="alert">You have unsaved changes. Discard them?</div>}
        <div className="modal-actions">
          {pendingSwitch !== null
            ? <>
                <button type="button" className="btn-secondary" onClick={() => setPendingSwitch(null)}>Keep editing</button>
                <button type="button" className="btn-primary" onClick={() => { if (pendingSwitch === 'close') onClose(); else void open(pendingSwitch) }}>Discard</button>
              </>
            : <>
                <button type="button" className="btn-secondary" onClick={() => request('close')}>Close</button>
                <button type="button" className="btn-primary" disabled={!dirty && current?.exists !== false || loaded === null || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
              </>}
        </div>
      </div>
    </div>
  )
}
