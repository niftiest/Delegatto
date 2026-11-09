import { describe, it, expect } from 'vitest'
import { ComposeStore, nextHeld, shellCommandOf } from '../src/renderer/compose-store'
import { hasUserRenderItem, type ComposerImage, type QueuedMessage } from '../src/renderer/lib'
import type { RenderItem } from '../src/shared/types'
import type { LiveEvent } from '../src/shared/engine-types'

const image = { id: 'i', name: 'a.png', mediaType: 'image/png', dataBase64: 'x' } as unknown as ComposerImage
const queued = (id: string, uuid: string | null, text = id): QueuedMessage => ({ id, text, images: [], uuid })
const lifecycle = (state: string, uuid: string): LiveEvent => ({ kind: 'commandLifecycle', state, uuid }) as unknown as LiveEvent
const result = { kind: 'result', isError: false, text: '' } as unknown as LiveEvent
const exit = { kind: 'exit' } as unknown as LiveEvent

function setup() {
  const store = new ComposeStore()
  const ran: Array<[number, string]> = []
  const event = (pk: number, ev: LiveEvent): void => store.handleEvent(pk, ev, (chat, command) => ran.push([chat, command]))
  return { store, ran, event }
}

describe('what is being composed in each chat', () => {
  it('keeps each chat separate and unchanged while another is open', () => {
    const { store } = setup()
    store.update(1, s => ({ ...s, images: [image] }))
    store.markOpen(2)
    expect(store.get(1).images).toEqual([image])
    expect(store.get(2).images).toEqual([])
  })

  it('returns a stable value for a chat with nothing in it', () => {
    const { store } = setup()
    expect(store.get(5)).toBe(store.get(6))
  })

  it('counts pictures, pastes and queued messages in any chat as unsent', () => {
    const { store } = setup()
    expect(store.hasUnsent()).toBe(false)
    store.update(1, s => ({ ...s, images: [image] }))
    expect(store.hasUnsent()).toBe(true)
    store.update(1, s => ({ ...s, images: [] }))
    expect(store.hasUnsent()).toBe(false)
    store.dispatch(2, { type: 'add', msg: queued('a', 'u') })
    expect(store.hasUnsent()).toBe(true)
  })

  it('follows the queue of a chat that is not on screen', () => {
    const { store, event } = setup()
    store.dispatch(1, { type: 'add', msg: queued('a', 'u1') })
    store.dispatch(1, { type: 'add', msg: queued('b', 'u2') })
    store.markOpen(2)
    event(1, lifecycle('started', 'u1'))
    expect(store.get(1).queue.map(m => m.id)).toEqual(['b'])
    event(1, exit)
    expect(store.get(1).queue[0]!.uuid).toBeNull()
  })

  it('keeps a message Claude Code dropped while its chat is not on screen', () => {
    const { store, event } = setup()
    store.dispatch(1, { type: 'add', msg: queued('a', 'u1') })
    store.markOpen(2)
    event(1, lifecycle('cancelled', 'u1'))
    expect(store.get(1).queue[0]).toMatchObject({ id: 'a', uuid: null })
  })

  it('leaves a dropped message to the box when its chat is on screen', () => {
    const { store, event } = setup()
    store.dispatch(1, { type: 'add', msg: queued('a', 'u1') })
    store.markOpen(1)
    event(1, lifecycle('cancelled', 'u1'))
    expect(store.get(1).queue[0]!.uuid).toBe('u1')
  })

  it('runs a queued ! when the turn ends with its chat not on screen', () => {
    const { store, ran, event } = setup()
    store.dispatch(1, { type: 'add', msg: queued('a', null, '!whoami') })
    store.dispatch(1, { type: 'add', msg: queued('b', null, '!later') })
    store.markOpen(2)
    event(1, result)
    expect(ran).toEqual([[1, 'whoami']])
    expect(store.get(1).queue.map(m => m.id)).toEqual(['b'])
  })

  it('leaves everything else for when the chat is opened', () => {
    const { store, ran, event } = setup()
    store.dispatch(1, { type: 'add', msg: queued('a', null, '/context') })
    store.markOpen(2)
    event(1, result)
    expect(ran).toEqual([])
    expect(store.get(1).queue).toHaveLength(1)
  })

  it('leaves a queued ! to the box when its chat is on screen', () => {
    const { store, ran, event } = setup()
    store.dispatch(1, { type: 'add', msg: queued('a', null, '!whoami') })
    store.markOpen(1)
    event(1, result)
    expect(ran).toEqual([])
  })

  it('keeps a chat open while any view of it is mounted', () => {
    const store = new ComposeStore()
    const a = store.markOpen(5); const b = store.markOpen(5)
    a()
    expect(store.isOpen(5)).toBe(true)
    b()
    expect(store.isOpen(5)).toBe(false)
  })

  it('leaves the other pane chat open when one pane closes', () => {
    const store = new ComposeStore()
    const close5 = store.markOpen(5); store.markOpen(6)
    close5()
    expect(store.isOpen(6)).toBe(true)
  })

  it('holds a cancelled message only for chats not on screen in any pane', () => {
    const { store, event } = setup()
    store.dispatch(6, { type: 'add', msg: queued('a', 'u6') })
    store.dispatch(7, { type: 'add', msg: queued('b', 'u7') })
    store.markOpen(6)
    event(6, lifecycle('cancelled', 'u6'))
    event(7, lifecycle('cancelled', 'u7'))
    expect(store.get(6).queue[0]!.uuid).toBe('u6')
    expect(store.get(7).queue[0]).toMatchObject({ id: 'b', uuid: null })
  })

  it('gives a chat shown twice exactly one box that takes its returned and held messages', () => {
    const store = new ComposeStore()
    const first = {}, second = {}
    const closeFirst = store.markOpen(5, first)
    store.markOpen(5, second)
    // The first box opened leads until another is focused.
    expect(store.isLead(5, first)).toBe(true)
    expect(store.isLead(5, second)).toBe(false)
    store.focusBox(5, second)
    expect(store.isLead(5, first)).toBe(false)
    expect(store.isLead(5, second)).toBe(true)
    // The focused one closing hands it back to the first still open.
    store.focusBox(5, first)
    closeFirst()
    expect(store.isLead(5, second)).toBe(true)
    // A box that isn't open for the chat never leads it.
    expect(store.isLead(5, first)).toBe(false)
    expect(store.isLead(6, second)).toBe(false)
  })

  it('hands a returned message to one box only', () => {
    const store = new ComposeStore()
    store.returnMessage(5, { text: 'hello', images: [] })
    expect(store.takeReturned(5)).toBe('hello')
    expect(store.takeReturned(5)).toBeNull()
    expect(store.get(5).returned).toBeNull()
  })

  it('lets only one box take a held message', () => {
    const store = new ComposeStore()
    store.dispatch(5, { type: 'add', msg: queued('a', null) })
    expect(store.claimHeld(5, 'a')).toBe(true)
    expect(store.claimHeld(5, 'a')).toBe(false)
    expect(store.get(5).queue).toEqual([])
  })

  it('finds what is held and reads ! commands', () => {
    expect(nextHeld([queued('a', 'u'), queued('b', null)])?.id).toBe('b')
    expect(nextHeld([queued('a', 'u')])).toBeUndefined()
    expect(shellCommandOf('  ! whoami ')).toBe('whoami')
    expect(shellCommandOf('!')).toBeNull()
    expect(shellCommandOf('hello')).toBeNull()
  })
})

describe('knowing a sent message has landed', () => {
  const text = (role: 'user' | 'assistant'): RenderItem => ({ kind: 'text', uuid: 'u', role, ts: null, model: null, text: 'x' })
  it('counts what the user sent, text or picture, and nothing of Claude\'s', () => {
    expect(hasUserRenderItem([text('user')])).toBe(true)
    expect(hasUserRenderItem([{ kind: 'image', uuid: 'u', role: 'user', source: {} }])).toBe(true)
    expect(hasUserRenderItem([text('assistant'), { kind: 'thinking', uuid: 'u', ts: null, text: 'x' }])).toBe(false)
    expect(hasUserRenderItem([])).toBe(false)
  })
})
