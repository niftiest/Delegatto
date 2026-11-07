import { describe, it, expect } from 'vitest'
import { userMessageParts } from '../src/renderer/lib'
import type { RenderItem } from '../src/shared/types'

const text = (uuid: string): RenderItem => ({ kind: 'text', uuid, role: 'user', text: 'x', ts: null, model: null }) as RenderItem
const image = (uuid: string): RenderItem => ({ kind: 'image', uuid, role: 'user', source: {} }) as RenderItem

describe('pictures on a message of yours', () => {
  it('go with the message they were sent with, whichever came first', () => {
    expect(userMessageParts([text('a'), image('a'), image('a')])).toEqual([{ first: 0, images: [1, 2], texts: [0] }])
    expect(userMessageParts([image('a'), text('a')])).toEqual([{ first: 0, images: [0], texts: [1] }])
  })

  it('keep to their own message when a turn holds several', () => {
    expect(userMessageParts([text('a'), image('a'), text('b'), image('c')])).toEqual([
      { first: 0, images: [1], texts: [0] },
      { first: 2, images: [], texts: [2] },
      { first: 3, images: [3], texts: [] }
    ])
  })

  it('leave anything else out', () => {
    expect(userMessageParts([{ kind: 'notice', uuid: 'n', ts: null, text: 'x' } as RenderItem])).toEqual([])
  })
})
