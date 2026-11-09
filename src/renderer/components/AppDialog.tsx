import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { choiceReady, toggleChoice, type AppDialogChoice, type AppDialogRequest } from '../../shared/app-dialog'

const BUTTON_CLASS = { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger' } as const

/** The button pressed, and the options picked when the question had some. */
export type ChoiceAnswer = { button: number; picked: number[] }

// Questions this window asks itself. They share the host and its look with main's, and are
// answered here rather than sent back to main. Their ids are negative so they can't collide.
type LocalAsk = { request: AppDialogRequest; resolve: (answer: ChoiceAnswer) => void }
const localHosts = new Set<(ask: LocalAsk) => void>()
let nextLocalId = -1

/** Asks a question in this window's in-app dialog and resolves to the button pressed and the
 *  options picked. With no host mounted, it resolves to `cancelIndex` and no picks. */
export function askChoiceInApp(request: Omit<AppDialogRequest, 'id'>): Promise<ChoiceAnswer> {
  return new Promise(resolve => {
    const host = [...localHosts][0]
    if (host === undefined) { resolve({ button: request.cancelIndex, picked: [] }); return }
    host({ request: { ...request, id: nextLocalId-- }, resolve })
  })
}

/** Asks a question in this window's in-app dialog and resolves to the button pressed. With
 *  no host mounted, it resolves to `cancelIndex`. */
export function askInApp(request: Omit<AppDialogRequest, 'id'>): Promise<number> {
  return askChoiceInApp(request).then(a => a.button)
}

/** Shows the questions main asks, and those this window asks itself, over everything else,
 *  one at a time. */
export function AppDialogHost() {
  const [queue, setQueue] = useState<AppDialogRequest[]>([])
  const current = queue[0] ?? null
  const defaultButton = useRef<HTMLButtonElement | null>(null)
  const localAnswers = useRef(new Map<number, (answer: ChoiceAnswer) => void>())
  // The picks for the question showing; a new question starts from its own `selected`.
  const [picks, setPicks] = useState<{ id: number; picked: number[] } | null>(null)
  const choice = current?.choice
  const picked = current !== null && picks?.id === current.id ? picks.picked : choice?.selected ?? []
  const ready = choice === undefined || choiceReady(choice, picked)

  useEffect(() => api.onAppDialog(request => {
    api.appDialogShown(request.id)
    setQueue(q => [...q, request])
  }), [])
  useEffect(() => {
    const host = ({ request, resolve }: LocalAsk): void => {
      localAnswers.current.set(request.id, resolve)
      setQueue(q => [...q, request])
    }
    localHosts.add(host)
    return () => { localHosts.delete(host) }
  }, [])

  const answer = (index: number): void => {
    if (current === null) return
    if (index !== current.cancelIndex && !ready) return
    const local = localAnswers.current.get(current.id)
    if (local !== undefined) { localAnswers.current.delete(current.id); local({ button: index, picked: index === current.cancelIndex ? [] : picked }) }
    else api.appDialogAnswer(current.id, index)
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
  const pick = (index: number): void => {
    if (choice === undefined) return
    setPicks({ id: current.id, picked: toggleChoice(picked, index, choice.count) })
  }
  return (
    <div className="modal-overlay app-dialog-overlay" role="presentation">
      <div className="modal app-dialog" role="alertdialog" aria-modal="true" aria-label={current.title}>
        <h2 className="modal-title">{current.title}</h2>
        {current.items !== undefined && current.items.length > 0 && (
          <ul className="app-dialog-items">{current.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
        )}
        {current.detail.map((text, i) => <p key={i} className="app-dialog-detail">{text}</p>)}
        {choice !== undefined && <ChoiceField choice={choice} picked={picked} onPick={pick} />}
        <div className="modal-actions">
          {current.buttons.map((button, i) => (
            <button key={i} type="button" className={BUTTON_CLASS[button.kind]} ref={i === current.defaultIndex ? defaultButton : undefined}
              disabled={i !== current.cancelIndex && !ready} onClick={() => answer(i)}>
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The options of a question: a dropdown when one is picked, otherwise a checkbox list. */
function ChoiceField({ choice, picked, onPick }: { choice: AppDialogChoice; picked: number[]; onPick: (index: number) => void }) {
  if (choice.count === 1) {
    return (
      <label className="field">
        <span className="field-label">{choice.label}</span>
        <select className="field-input" value={String(picked[0] ?? '')} onChange={e => onPick(Number(e.target.value))}>
          {picked.length === 0 && <option value="" disabled>Choose one</option>}
          {choice.options.map((option, i) => <option key={i} value={String(i)}>{option}</option>)}
        </select>
      </label>
    )
  }
  return (
    <fieldset className="field app-dialog-choices">
      <legend className="field-label">{choice.label}</legend>
      <div className="app-dialog-checklist">
        {choice.options.map((option, i) => (
          <label key={i} className="field-checkbox">
            <input type="checkbox" checked={picked.includes(i)} onChange={() => onPick(i)} />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
