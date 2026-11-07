import { useMemo, useState } from 'react'
import type { Elicitation, PermissionRequest } from '../../shared/engine-types'
import {
  answerText, formContent, initialFormValues, parseFormSchema, parseQuestions, questionsResult,
  type FormField, type FormValues, type QuestionAnswer
} from '../question-form'

/** Claude asking something with `AskUserQuestion`: pick an option, or type your own. */
export function QuestionCard({ req, onResolve }: {
  req: PermissionRequest
  onResolve: (id: string, decision: 'allow' | 'deny', editedInput?: unknown, denyMessage?: string) => void
}) {
  const questions = useMemo(() => parseQuestions(req.input) ?? [], [req.input])
  const [answers, setAnswers] = useState<Map<string, QuestionAnswer>>(new Map())
  const [done, setDone] = useState<'answered' | 'skipped' | null>(null)

  const change = (question: string, next: (a: QuestionAnswer) => QuestionAnswer): void => {
    setAnswers(prev => new Map(prev).set(question, next(prev.get(question) ?? { picked: [], other: '' })))
  }
  const ready = questions.every(q => answerText(answers.get(q.question)).length > 0)

  return (
    <div className="perm-card plan-card question-card">
      <div className="perm-head"><span className="perm-badge">Claude is asking</span></div>
      {questions.map(q => {
        const a = answers.get(q.question) ?? { picked: [], other: '' }
        const previewOf = q.options.find(o => a.picked.includes(o.label) && o.preview !== null)?.preview ?? null
        return (
          <fieldset key={q.question} className="question" disabled={done !== null}>
            <legend className="question-text">{q.header.length > 0 && <span className="question-chip">{q.header}</span>}{q.question}</legend>
            {q.options.map(o => (
              <label key={o.label} className="question-option">
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${req.id}:${q.question}`} checked={a.picked.includes(o.label)}
                  onChange={e => change(q.question, cur => q.multiSelect
                    ? { ...cur, picked: e.target.checked ? [...cur.picked, o.label] : cur.picked.filter(p => p !== o.label) }
                    : { picked: [o.label], other: '' })} />
                <span><span className="question-label">{o.label}</span>{o.description.length > 0 && <span className="question-desc">{o.description}</span>}</span>
              </label>
            ))}
            <input type="text" className="question-other" placeholder="Other: type your own answer" aria-label={`Your own answer to: ${q.question}`} value={a.other}
              onChange={e => { const other = e.target.value; change(q.question, cur => q.multiSelect ? { ...cur, other } : { picked: other.trim().length > 0 ? [] : cur.picked, other }) }} />
            {previewOf !== null && <pre className="perm-input question-preview">{previewOf}</pre>}
          </fieldset>
        )
      })}
      <div className="perm-actions">
        <button type="button" className="btn-primary" disabled={done !== null || !ready}
          onClick={() => { setDone('answered'); onResolve(req.id, 'allow', questionsResult(req.input, questions, answers)) }}>
          Send answer
        </button>
        <button type="button" className="btn-secondary" disabled={done !== null}
          onClick={() => { setDone('skipped'); onResolve(req.id, 'deny', undefined, 'The user chose not to answer this question.') }}>
          Skip
        </button>
      </div>
      {done !== null && <div className="perm-resolved">{done === 'answered' ? 'Answered' : 'Skipped'}</div>}
    </div>
  )
}

function Field({ field, value, onChange }: { field: FormField; value: FormValues[string]; onChange: (v: FormValues[string]) => void }) {
  const list = Array.isArray(value) ? value : []
  return (
    <div className="question">
      <div className="question-text">{field.label}{field.required && <span className="question-required"> (required)</span>}</div>
      {field.description.length > 0 && <div className="question-desc">{field.description}</div>}
      {field.kind === 'boolean' && (
        <label className="question-option"><input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} /><span>Yes</span></label>
      )}
      {field.kind === 'choice' && field.choices.map(c => (
        <label key={c.value} className="question-option">
          <input type="radio" name={field.name} checked={value === c.value} onChange={() => onChange(c.value)} /><span>{c.label}</span>
        </label>
      ))}
      {field.kind === 'choices' && field.choices.map(c => (
        <label key={c.value} className="question-option">
          <input type="checkbox" checked={list.includes(c.value)} onChange={e => onChange(e.target.checked ? [...list, c.value] : list.filter(v => v !== c.value))} /><span>{c.label}</span>
        </label>
      ))}
      {(field.kind === 'text' || field.kind === 'number' || field.kind === 'integer') && (
        <input type={field.kind === 'text' ? 'text' : 'number'} className="question-other" aria-label={field.label} value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} />
      )}
    </div>
  )
}

/** An MCP server asking for something: a form to fill in, or a page to visit. */
export function ElicitationCard({ request, onAnswer, onOpenLink }: {
  request: Elicitation
  onAnswer: (requestId: string, answer: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) => void
  onOpenLink: (url: string) => void
}) {
  const fields = useMemo(() => (request.mode === 'url' ? [] : parseFormSchema(request.schema, request.propertyOrder)), [request])
  const [values, setValues] = useState<FormValues>(() => initialFormValues(fields ?? []))
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const answer = (action: 'accept' | 'decline', content?: Record<string, unknown>): void => {
    setDone(true)
    onAnswer(request.requestId, { action, ...(content !== undefined ? { content } : {}) })
  }
  return (
    <div className="perm-card plan-card question-card">
      <div className="perm-head">
        <span className="perm-badge">{request.server} is asking</span>
        {request.title !== null && <span className="perm-summary">{request.title}</span>}
      </div>
      <div className="question"><div className="question-text">{request.message}</div></div>
      {request.mode === 'url' && request.url !== null && (
        <div className="question"><code className="question-url">{request.url}</code></div>
      )}
      {request.mode !== 'url' && fields === null && <div className="question question-desc">This form can't be shown here. You can decline it, or open the chat in a terminal to fill it in.</div>}
      {fields !== null && fields.map(f => (
        <Field key={f.name} field={f} value={values[f.name] ?? ''} onChange={v => { setValues(prev => ({ ...prev, [f.name]: v })); setError(null) }} />
      ))}
      {error !== null && <div className="perm-edit-error question">{error}</div>}
      <div className="perm-actions">
        {request.mode === 'url' && request.url !== null && (
          <button type="button" className="btn-primary" disabled={done} onClick={() => { onOpenLink(request.url!); answer('accept') }}>Open page</button>
        )}
        {request.mode !== 'url' && fields !== null && (
          <button type="button" className="btn-primary" disabled={done} onClick={() => {
            const result = formContent(fields, values)
            if (result.ok) answer('accept', result.content)
            else setError(result.error)
          }}>Send</button>
        )}
        <button type="button" className="btn-secondary" disabled={done} onClick={() => answer('decline')}>Decline</button>
      </div>
    </div>
  )
}
