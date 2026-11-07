import { useEffect, useState } from 'react'
import type { ChannelIcon } from '../../shared/shell-types'
import { api } from '../api'
import { dataUrlSizeOk, MAX_ICON_IMAGE_BYTES, themeAvatarColors } from '../lib'
import { buildAvatarPrompt } from '../../shared/models'
import { ImageModelSelect } from './ImageModelSelect'

/** Center-crop + downscale a data URL to a `size`x`size` PNG data URL (DOM/
 *  canvas -- lives here, not in the pure lib). Keeps AI-generated 1024px images
 *  tiny enough to store as a channel icon. */
function downscaleSquare(dataUrl: string, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size; canvas.height = size
      const ctx = canvas.getContext('2d')
      if (ctx === null) { reject(new Error('no 2d context')); return }
      const s = Math.min(img.width, img.height)
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('could not load generated image'))
    img.src = dataUrl
  })
}

const PRESET_EMOJI = ['🚀', '💡', '🔥', '🎯', '🛠️', '📦', '🐛', '✨', '📚', '🎨', '⚙️', '🌱']

type Tab = 'initials' | 'emoji' | 'color' | 'image' | 'ai'

function tabOf(icon: ChannelIcon): Tab {
  return icon.kind
}

/** Reads a File as a data URL, or rejects with an Error -- wraps FileReader's
 *  callback API in a promise so callers can `await`/try-catch it. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/** Modal for choosing a channel's icon (Plan 3 Task 2): Initials (the
 *  deterministic default, no configuration), Emoji (a small preset grid plus
 *  a free-text single-emoji field), Color (swatches plus a native color
 *  input), or Image (file upload -> data URL, size-capped at
 *  MAX_ICON_IMAGE_BYTES via the pure `dataUrlSizeOk` -- an oversized image is
 *  rejected with an inline message rather than ever being staged for save,
 *  so a multi-MB blob can never reach `setChannelIcon`).
 *
 *  REQUIRES HUMAN VERIFICATION: the visual picker/tabs/upload flow is
 *  DOM/File-API and cannot be exercised by vitest -- the size-cap boundary
 *  itself is covered by dataUrlSizeOk's own unit tests. */
export function IconPicker({ current, onApply, onCancel }: {
  current: ChannelIcon
  onApply: (icon: ChannelIcon) => void
  onCancel: () => void
}) {
  const [tab, setTab] = useState<Tab>(tabOf(current))
  const [emoji, setEmoji] = useState(current.kind === 'emoji' ? current.emoji : '🚀')
  const [color, setColor] = useState(current.kind === 'color' ? current.color : themeAvatarColors()[0]!)
  const [imageDataUrl, setImageDataUrl] = useState(current.kind === 'image' ? current.dataUrl : null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageFileName, setImageFileName] = useState<string | null>(null)
  // "Image by AI" tab state.
  const [hasKey, setHasKey] = useState<boolean | null>(null) // null = still checking settings
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiModel, setAiModel] = useState('') // per-generation model override, seeded from the default
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiDataUrl, setAiDataUrl] = useState<string | null>(null)

  useEffect(() => {
    void api.getSettings().then(s => { setHasKey(s.openRouterKey.trim().length > 0); setAiModel(s.avatarModel) })
  }, [])

  async function generate() {
    const prompt = aiPrompt.trim()
    if (prompt.length === 0 || aiBusy) return
    setAiBusy(true); setAiError(null)
    try {
      // The user only describes the subject; buildAvatarPrompt bakes in the
      // full-bleed / centered / no-border styling an avatar needs.
      const res = await api.generateAvatar(buildAvatarPrompt(prompt), undefined, aiModel || undefined)
      if (!res.ok) { setAiError(res.error); return }
      const small = await downscaleSquare(res.dataUrl, 128)
      if (!dataUrlSizeOk(small, MAX_ICON_IMAGE_BYTES)) { setAiError('Generated image was too large to store.'); return }
      setAiDataUrl(small)
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Generation failed.')
    } finally {
      setAiBusy(false)
    }
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file === undefined) return
    setImageError(null)
    setImageFileName(file.name)
    try {
      const dataUrl = await readAsDataUrl(file)
      if (!dataUrlSizeOk(dataUrl, MAX_ICON_IMAGE_BYTES)) {
        setImageError(`Image is too large -- pick one under ${Math.round(MAX_ICON_IMAGE_BYTES / 1024)} KB.`)
        return
      }
      setImageDataUrl(dataUrl)
    } catch {
      setImageError('Could not read that file.')
    }
  }

  function apply() {
    if (tab === 'initials') return onApply({ kind: 'initials' })
    if (tab === 'emoji') {
      const trimmed = emoji.trim()
      return onApply({ kind: 'emoji', emoji: trimmed.length > 0 ? trimmed : '🚀' })
    }
    if (tab === 'color') return onApply({ kind: 'color', color })
    if (tab === 'ai') { if (aiDataUrl !== null) onApply({ kind: 'image', dataUrl: aiDataUrl }); return }
    if (imageDataUrl !== null) onApply({ kind: 'image', dataUrl: imageDataUrl })
  }

  const applyDisabled = (tab === 'image' && imageDataUrl === null) || (tab === 'ai' && aiDataUrl === null)

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Change icon"
        onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">Change icon</h2>

        <div className="icon-picker-tabs">
          {(['initials', 'emoji', 'color', 'image', 'ai'] as const).map(t => (
            <button key={t} type="button" className={`icon-picker-tab${tab === t ? ' active' : ''}`}
              onClick={() => setTab(t)}>
              {t === 'initials' ? 'Initials' : t === 'emoji' ? 'Emoji' : t === 'color' ? 'Color' : t === 'image' ? 'Image' : 'Image by AI'}
            </button>
          ))}
        </div>

        <div className="icon-picker-body">
          {tab === 'initials' && (
            <p className="field-note">Uses the default initials avatar, colored deterministically by name.</p>
          )}

          {tab === 'emoji' && (
            <>
              <div className="icon-picker-emoji-grid">
                {PRESET_EMOJI.map(em => (
                  <button key={em} type="button" className={`icon-picker-emoji-btn${emoji === em ? ' active' : ''}`}
                    onClick={() => setEmoji(em)} aria-label={`Use ${em}`}>{em}</button>
                ))}
              </div>
              <label className="field">
                <span className="field-label">Or type your own</span>
                <input className="field-input" type="text" value={emoji}
                  onChange={e => setEmoji(e.target.value)} maxLength={8} />
              </label>
            </>
          )}

          {tab === 'color' && (
            <>
              <div className="icon-picker-swatches">
                {themeAvatarColors().map(c => (
                  <button key={c} type="button" className={`icon-picker-swatch${color === c ? ' active' : ''}`}
                    style={{ background: c }} onClick={() => setColor(c)} aria-label={`Use ${c}`} />
                ))}
              </div>
              <label className="field">
                <span className="field-label">Custom color</span>
                <input type="color" value={color} onChange={e => setColor(e.target.value)} />
              </label>
            </>
          )}

          {tab === 'image' && (
            <>
              <label className="file-field">
                <span className="file-field-btn">Choose image…</span>
                <span className="file-field-name">{imageFileName ?? (imageDataUrl !== null ? 'Current image' : 'No file chosen')}</span>
                <input type="file" accept="image/*" onChange={e => void onPickFile(e)} />
              </label>
              {imageError !== null && <div className="modal-error">{imageError}</div>}
              {imageDataUrl !== null && (
                <div className="icon-picker-preview">
                  <span className="ch-avatar" style={{ width: 56, height: 56 }}>
                    <img src={imageDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </span>
                </div>
              )}
            </>
          )}

          {tab === 'ai' && (
            hasKey === false
              ? <p className="field-note">Add an OpenRouter API key and pick an image model in <b>Settings → OpenRouter</b> to generate avatars from a description.</p>
              : <>
                  <label className="field">
                    <span className="field-label">Describe the avatar</span>
                    <textarea className="field-input" rows={3} value={aiPrompt}
                      placeholder="Just describe the subject — e.g. cute elk standing near a tree"
                      onChange={e => setAiPrompt(e.target.value)} />
                  </label>
                  <label className="field">
                    <span className="field-label">Model</span>
                    <ImageModelSelect value={aiModel} onChange={m => { setAiModel(m); void api.updateSettings({ avatarModel: m }) }} />
                  </label>
                  <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
                    <button type="button" className="btn-secondary" disabled={aiBusy || aiPrompt.trim().length === 0 || hasKey === null}
                      onClick={() => void generate()}>
                      {aiBusy ? 'Generating…' : aiDataUrl !== null ? 'Regenerate' : 'Generate'}
                    </button>
                  </div>
                  {aiError !== null && <div className="modal-error">{aiError}</div>}
                  {aiDataUrl !== null && (
                    <div className="icon-picker-preview">
                      <span className="ch-avatar" style={{ width: 56, height: 56 }}>
                        <img src={aiDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      </span>
                    </div>
                  )}
                </>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-primary" disabled={applyDisabled} onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  )
}
