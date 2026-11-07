import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AppDialogRequest } from '../../shared/app-dialog'

const BUTTON_CLASS = { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger' } as const

/** Shows the questions main asks, over everything else, one at a time. */
export function AppDialogHost() {
  const [queue, setQueue] = useState<AppDialogRequest[]>([])
  const current = queue[0] ?? null
  const defaultButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => api.onAppDialog(request => {
    api.appDialogShown(request.id)
    setQueue(q => [...q, request])
  }), [])

  const answer = (index: number): void => {
    if (current === null) return
    api.appDialogAnswer(current.id, index)
    setQueue(q => q.slice(1))
  }

  useEffect(() => {
    if (current === null) return
    defaultButton.current?.focus()
    // Ahead of everything else: behind this dialog, Esc would stop a running turn.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      answer(current.cancelIndex)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  if (current === null) return null
  return (
    <div className="modal-overlay app-dialog-overlay" role="presentation">
      <div className="modal app-dialog" role="alertdialog" aria-modal="true" aria-label={current.title}>
        <h2 className="modal-title">{current.title}</h2>
        {current.items !== undefined && current.items.length > 0 && (
          <ul className="app-dialog-items">{current.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
        )}
        {current.detail.map((text, i) => <p key={i} className="app-dialog-detail">{text}</p>)}
        <div className="modal-actions">
          {current.buttons.map((button, i) => (
            <button key={i} type="button" className={BUTTON_CLASS[button.kind]} ref={i === current.defaultIndex ? defaultButton : undefined} onClick={() => answer(i)}>
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
