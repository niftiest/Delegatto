import { describe, it, expect } from 'vitest'
import { answerText, formContent, initialFormValues, parseFormSchema, parseQuestions, questionsResult } from '../src/renderer/question-form'
import { elicitationFrom, parseControlRequest, parseEvent } from '../src/main/engine/events'
import { isQuestion, reduceLivePreview, retryLabel } from '../src/renderer/lib'

const QUESTION = {
  questions: [
    { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool', preview: 'blue!' }] },
    { question: 'Which sizes?', header: 'Size', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] }
  ]
}

describe('questions from Claude', () => {
  it('recognises the tool and reads its questions', () => {
    expect(isQuestion('AskUserQuestion')).toBe(true)
    expect(isQuestion('Bash')).toBe(false)
    const q = parseQuestions(QUESTION)!
    expect(q).toHaveLength(2)
    expect(q[0]!.options[1]).toEqual({ label: 'Blue', description: 'Cool', preview: 'blue!' })
    expect(q[1]!.multiSelect).toBe(true)
  })

  it('falls back when it is not shaped as expected', () => {
    for (const bad of [null, {}, { questions: [] }, { questions: [{}] }, 'x']) expect(parseQuestions(bad)).toBeNull()
  })

  it('answers each question by its text, keeping the original input', () => {
    const q = parseQuestions(QUESTION)!
    const answers = new Map([['Which colour?', { picked: ['Red'], other: '' }], ['Which sizes?', { picked: ['S', 'L'], other: ' XL ' }]])
    const result = questionsResult(QUESTION, q, answers)
    expect(result.questions).toBe(QUESTION.questions)
    expect(result.answers).toEqual({ 'Which colour?': 'Red', 'Which sizes?': 'S, L, XL' })
  })

  it('treats nothing picked as no answer', () => {
    expect(answerText(undefined)).toBe('')
    expect(answerText({ picked: [], other: '  ' })).toBe('')
    expect(answerText({ picked: [], other: 'mine' })).toBe('mine')
  })
})

describe('forms from MCP servers', () => {
  const SCHEMA = {
    type: 'object', required: ['name', 'age'],
    properties: {
      name: { type: 'string', title: 'Name', description: 'Who' },
      age: { type: 'integer' },
      ratio: { type: 'number' },
      ok: { type: 'boolean', default: true },
      colour: { type: 'string', enum: ['r', 'g'], enumNames: ['Red', 'Green'] },
      pick: { type: 'string', oneOf: [{ const: 'a', title: 'Ay' }] },
      many: { type: 'array', items: { enum: ['x', 'y'] } }
    }
  }

  it('reads every kind of field, in the order asked for', () => {
    const f = parseFormSchema(SCHEMA, ['age', 'name'])!
    expect(f.map(x => x.name).slice(0, 2)).toEqual(['age', 'name'])
    const by = Object.fromEntries(f.map(x => [x.name, x]))
    expect(by.name).toMatchObject({ kind: 'text', label: 'Name', required: true })
    expect(by.age!.kind).toBe('integer')
    expect(by.ok).toMatchObject({ kind: 'boolean', defaultValue: true })
    expect(by.colour!.choices).toEqual([{ value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }])
    expect(by.pick!.choices).toEqual([{ value: 'a', label: 'Ay' }])
    expect(by.many!.kind).toBe('choices')
  })

  it('says when a form cannot be shown', () => {
    expect(parseFormSchema(null)).toBeNull()
    expect(parseFormSchema({ properties: { x: { type: 'object' } } })).toBeNull()
    expect(parseFormSchema({ properties: { x: { type: 'array', items: { type: 'object' } } } })).toBeNull()
  })

  it('types values, leaves out blank optional ones, and insists on required ones', () => {
    const f = parseFormSchema(SCHEMA)!
    const v = initialFormValues(f)
    expect(formContent(f, v)).toEqual({ ok: false, error: 'Name is required.' })
    expect(formContent(f, { ...v, name: 'A', age: '1.5' })).toEqual({ ok: false, error: 'age has to be a whole number.' })
    expect(formContent(f, { ...v, name: ' A ', age: '30', ratio: '0.5', many: ['x'] })).toEqual({
      ok: true, content: { name: 'A', age: 30, ratio: 0.5, ok: true, many: ['x'] }
    })
  })
})

describe('what Claude Code sends', () => {
  it('reads an elicitation request, keeping only web links', () => {
    const line = JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'elicitation', mcp_server_name: 'srv', message: 'Name?', requested_schema: { properties: {} } } })
    const asked = parseControlRequest(line)!
    expect(asked).toMatchObject({ requestId: 'r1', subtype: 'elicitation' })
    expect(elicitationFrom(asked)).toMatchObject({ requestId: 'r1', server: 'srv', message: 'Name?', mode: 'form', url: null })
    const bad = parseControlRequest(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'elicitation', mode: 'url', url: 'file:///c:/x' } }))!
    expect(elicitationFrom(bad).url).toBeNull()
    expect(parseControlRequest(JSON.stringify({ type: 'control_response', response: {} }))).toBeNull()
  })

  it('reads API retries and hooks', () => {
    const retry = parseEvent(JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error: 'overloaded' }))!
    expect(retry).toEqual({ kind: 'retry', attempt: 2, maxRetries: 10, delayMs: 500, error: 'overloaded' })
    expect(retryLabel(retry as never)).toBe('Retrying after an API error (attempt 2 of 10: overloaded)')
    const hook = parseEvent(JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'lint', hook_event: 'Stop', outcome: 'error', stderr: ' nope ' }))!
    expect(hook).toEqual({ kind: 'hook', phase: 'finished', name: 'lint', hookEvent: 'Stop', outcome: 'error', output: 'nope' })
    expect(reduceLivePreview({ text: 'x', sealed: false }, hook)).toEqual({ text: 'x', sealed: false })
  })
})
