import { useEffect, useState } from 'react'
import { api } from '../api'
import { ImageModelSelect } from './ImageModelSelect'

/** "Create Image with AI" tool (from the context rail's Files header). Generate
 *  an image from a prompt, regenerate until you like it, then save it into the
 *  chat's working directory. Only reachable when an OpenRouter key is set. */
export function CreateImageDialog({ cwd, onClose, onSaved }: {
  cwd: string
  onClose: () => void
  onSaved: (path: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('') // '' = model default (no forced dimensions)
  const [model, setModel] = useState('') // per-generation model override, seeded from the default
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('ai-image.png')
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => { void api.getSettings().then(s => setModel(s.avatarModel)).catch(() => {}) }, [])

  async function generate() {
    const p = prompt.trim()
    if (p.length === 0 || busy) return
    setBusy(true); setError(null); setSavedPath(null)
    try {
      const res = await api.generateAvatar(p, size || undefined, model || undefined)
      if (res.ok) setDataUrl(res.dataUrl)
      else setError(res.error)
    } finally { setBusy(false) }
  }

  async function save() {
    if (dataUrl === null || saving) return
    const name = fileName.trim()
    if (name.length === 0) { setError('Enter a file name.'); return }
    setSaving(true); setError(null)
    try {
      const res = await api.saveImage(cwd, name, dataUrl)
      if (res.ok) { setSavedPath(res.path); onSaved(res.path) }
      else setError(res.error)
    } finally { setSaving(false) }
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Create image with AI"
        onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">Create image with AI</h2>
        <p className="field-note">Generates into <code>{cwd}</code>. Costs a fraction of a cent to a few cents per image.</p>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea className="field-input" rows={3} value={prompt}
            placeholder="a wide isometric illustration of a control room, muted palette"
            onChange={e => setPrompt(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Model</span>
          <ImageModelSelect value={model} onChange={m => { setModel(m); void api.updateSettings({ avatarModel: m }) }} />
        </label>
        <label className="field">
          <span className="field-label">Dimensions</span>
          <select className="field-input" value={size} onChange={e => setSize(e.target.value)}>
            <option value="">Model default</option>
            <option value="1024x1024">1024 × 1024 (square)</option>
            <option value="1024x1536">1024 × 1536 (portrait)</option>
            <option value="1536x1024">1536 × 1024 (landscape)</option>
          </select>
        </label>
        <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
          <button type="button" className="btn-secondary" disabled={busy || prompt.trim().length === 0}
            onClick={() => void generate()}>
            {busy ? 'Generating…' : dataUrl !== null ? 'Regenerate' : 'Generate'}
          </button>
        </div>

        {error !== null && <div className="modal-error">{error}</div>}

        {dataUrl !== null && (
          <>
            <div className="ci-preview"><img src={dataUrl} alt="generated preview" /></div>
            <label className="field">
              <span className="field-label">Save as (relative to the project)</span>
              <input className="field-input" type="text" value={fileName}
                onChange={e => setFileName(e.target.value)} placeholder="assets/hero.png" />
            </label>
            {savedPath !== null && <div className="field-note" style={{ color: 'var(--good)' }}>Saved to {savedPath}</div>}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn-primary" disabled={dataUrl === null || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save to project'}
          </button>
        </div>
      </div>
    </div>
  )
}
