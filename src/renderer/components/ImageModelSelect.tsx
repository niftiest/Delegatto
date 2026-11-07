import { useEffect, useState } from 'react'
import { api } from '../api'
import { IMAGE_MODELS, formatImagePrice } from '../../shared/models'
import type { ImageModelInfo } from '../../shared/ipc'

/** A model picker for image generation, usable at generation time (avatar
 *  picker + Files Create-Image) so the user can A/B models without visiting
 *  Settings. Options are the curated IMAGE_MODELS; each label carries the live
 *  per-image/token price once OpenRouter's model list loads. */
export function ImageModelSelect({ value, onChange, className }: {
  value: string
  onChange: (model: string) => void
  className?: string
}) {
  const [info, setInfo] = useState<ImageModelInfo[] | null>(null)
  useEffect(() => { void api.listImageModels().then(setInfo).catch(() => setInfo([])) }, [])

  return (
    <select className={className ?? 'field-input'} value={value} onChange={e => onChange(e.target.value)}>
      {IMAGE_MODELS.map(m => {
        const price = info === null ? '' : ` — ${formatImagePrice(info.find(i => i.id === m.value) ?? null)}`
        return <option key={m.value} value={m.value}>{m.label}{price}</option>
      })}
    </select>
  )
}
