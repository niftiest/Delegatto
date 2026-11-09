import { describe, it, expect } from 'vitest'
import { PendingQuestions } from '../src/main/engine/pending-questions'
import type { Elicitation, LiveEvent } from '../src/shared/engine-types'

const question = (requestId: string): Elicitation => ({ requestId, server: 's', message: 'm', title: null, mode: 'form', url: null, schema: {}, propertyOrder: [] })
const asked = (q: Elicitation): LiveEvent => ({ kind: 'elicitation', request: q }) as LiveEvent
const ev = (e: object): LiveEvent => e as unknown as LiveEvent

describe('questions MCP servers are waiting on', () => {
  it('keeps each chat\'s questions until they are answered', () => {
    const q = new PendingQuestions()
    q.onEvent(1, asked(question('a')))
    q.onEvent(1, asked(question('b')))
    q.onEvent(2, asked(question('c')))
    expect(q.list()).toEqual([{ sessionPk: 1, request: question('a') }, { sessionPk: 1, request: question('b') }, { sessionPk: 2, request: question('c') }])
    q.answered(1, 'a')
    expect(q.list().map(x => x.request.requestId)).toEqual(['b', 'c'])
  })

  it('drops a chat\'s questions when its turn or process ends, and leaves other chats alone', () => {
    const q = new PendingQuestions()
    q.onEvent(1, asked(question('a')))
    q.onEvent(2, asked(question('b')))
    q.onEvent(1, ev({ kind: 'result', isError: false, text: '' }))
    expect(q.list().map(x => x.request.requestId)).toEqual(['b'])
    q.onEvent(2, ev({ kind: 'exit' }))
    expect(q.list()).toEqual([])
  })

  it('drops a question that went away with its request', () => {
    const q = new PendingQuestions()
    q.onEvent(1, asked(question('a')))
    q.onEvent(1, ev({ kind: 'permissionGone', id: 'a' }))
    expect(q.list()).toEqual([])
  })

  it('answering drops the question and gives the event that takes it out of every window', () => {
    const q = new PendingQuestions()
    q.onEvent(1, asked(question('a')))
    q.onEvent(1, asked(question('b')))
    expect(q.answer(1, 'a')).toEqual({ kind: 'elicitationGone', requestId: 'a' })
    expect(q.list().map(x => x.request.requestId)).toEqual(['b'])
  })

  it('drops a question another window answered', () => {
    const q = new PendingQuestions()
    q.onEvent(1, asked(question('a')))
    q.onEvent(1, ev({ kind: 'elicitationGone', requestId: 'a' }))
    expect(q.list()).toEqual([])
  })

  it('does not keep the same question twice', () => {
    const q = new PendingQuestions()
    q.onEvent(1, asked(question('a')))
    q.onEvent(1, asked(question('a')))
    expect(q.list()).toHaveLength(1)
  })
})
