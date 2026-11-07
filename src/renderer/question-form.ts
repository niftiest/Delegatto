/** Reading what Claude asks: the `AskUserQuestion` tool's questions, and the form an MCP
 *  server sends when it needs something from the user. */

export type QuestionOption = { label: string; description: string; preview: string | null }
export type Question = { question: string; header: string; multiSelect: boolean; options: QuestionOption[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The questions in a tool call, or null if it isn't shaped as expected. */
export function parseQuestions(input: unknown): Question[] | null {
  if (!isObject(input) || !Array.isArray(input.questions)) return null
  const out: Question[] = []
  for (const q of input.questions) {
    if (!isObject(q) || str(q.question).length === 0) return null
    const options = Array.isArray(q.options)
      ? q.options.filter(isObject).map(o => ({ label: str(o.label), description: str(o.description), preview: typeof o.preview === 'string' ? o.preview : null })).filter(o => o.label.length > 0)
      : []
    out.push({ question: str(q.question), header: str(q.header), multiSelect: q.multiSelect === true, options })
  }
  return out.length > 0 ? out : null
}

/** One question's answer: what's picked, plus any typed-in "Other". */
export type QuestionAnswer = { picked: string[]; other: string }

export function answerText(a: QuestionAnswer | undefined): string {
  if (a === undefined) return ''
  const other = a.other.trim()
  return [...a.picked, ...(other.length > 0 ? [other] : [])].join(', ')
}

/** What the tool reads back: the original input, plus each question's answer by its text. */
export function questionsResult(input: unknown, questions: Question[], answers: Map<string, QuestionAnswer>): Record<string, unknown> {
  const out: Record<string, string> = {}
  for (const q of questions) out[q.question] = answerText(answers.get(q.question))
  return { ...(isObject(input) ? input : {}), answers: out }
}

export type FormField = {
  name: string
  label: string
  description: string
  required: boolean
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices'
  choices: Array<{ value: string; label: string }>
  defaultValue: string | boolean | string[] | null
}

function choicesOf(schema: Record<string, unknown>): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
    return schema.enum.map((v, i) => ({ value: String(v), label: typeof names[i] === 'string' ? names[i] as string : String(v) }))
  }
  const list = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null
  if (list === null) return []
  return list.filter(isObject).filter(o => o.const !== undefined).map(o => ({ value: String(o.const), label: typeof o.title === 'string' ? o.title : String(o.const) }))
}

/** The fields of an elicitation's schema, in the order the server asked for. Null when the
 *  form can't be shown, in which case the user can only decline it. */
export function parseFormSchema(schema: unknown, order?: unknown): FormField[] | null {
  if (!isObject(schema) || !isObject(schema.properties)) return null
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const names = Object.keys(schema.properties)
  const ordered = Array.isArray(order) ? [...order.map(String).filter(n => names.includes(n)), ...names.filter(n => !order.includes(n))] : names
  const fields: FormField[] = []
  for (const name of ordered) {
    const raw = schema.properties[name]
    if (!isObject(raw)) return null
    const base = { name, label: str(raw.title) || name, description: str(raw.description), required: required.has(name) }
    const type = raw.type
    const choices = choicesOf(raw)
    if (type === 'array') {
      const items = isObject(raw.items) ? choicesOf(raw.items) : []
      if (items.length === 0) return null
      fields.push({ ...base, kind: 'choices', choices: items, defaultValue: Array.isArray(raw.default) ? raw.default.map(String) : [] })
    } else if (choices.length > 0) {
      fields.push({ ...base, kind: 'choice', choices, defaultValue: raw.default === undefined ? null : String(raw.default) })
    } else if (type === 'boolean') {
      fields.push({ ...base, kind: 'boolean', choices: [], defaultValue: raw.default === true })
    } else if (type === 'number' || type === 'integer') {
      fields.push({ ...base, kind: type, choices: [], defaultValue: raw.default === undefined ? null : String(raw.default) })
    } else if (type === 'string' || type === undefined) {
      fields.push({ ...base, kind: 'text', choices: [], defaultValue: typeof raw.default === 'string' ? raw.default : null })
    } else {
      return null
    }
  }
  return fields
}

export type FormValues = Record<string, string | boolean | string[]>

/** Starting values for a form. */
export function initialFormValues(fields: FormField[]): FormValues {
  const out: FormValues = {}
  for (const f of fields) out[f.name] = f.defaultValue ?? (f.kind === 'boolean' ? false : f.kind === 'choices' ? [] : '')
  return out
}

/** Typed values for the server, or what needs fixing first. Blank optional fields are left out. */
export function formContent(fields: FormField[], values: FormValues): { ok: true; content: Record<string, unknown> } | { ok: false; error: string } {
  const content: Record<string, unknown> = {}
  for (const f of fields) {
    const v = values[f.name]
    if (f.kind === 'boolean') { content[f.name] = v === true; continue }
    if (f.kind === 'choices') {
      const list = Array.isArray(v) ? v : []
      if (list.length === 0 && f.required) return { ok: false, error: `Choose at least one for ${f.label}.` }
      if (list.length > 0) content[f.name] = list
      continue
    }
    const text = typeof v === 'string' ? v.trim() : ''
    if (text.length === 0) {
      if (f.required) return { ok: false, error: `${f.label} is required.` }
      continue
    }
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(text)
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))) return { ok: false, error: `${f.label} has to be a ${f.kind === 'integer' ? 'whole ' : ''}number.` }
      content[f.name] = n
      continue
    }
    content[f.name] = text
  }
  return { ok: true, content }
}
