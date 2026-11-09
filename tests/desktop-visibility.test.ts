import { describe, it, expect } from 'vitest'
import { ChatVisibility } from '../src/main/chat-visibility'
import { suppressNotification } from '../src/main/notify-visibility'

const MAIN = 1
const SPLIT = 2

describe('suppressNotification', () => {
  it('shows a chat visible only in the split window while the main window is focused', () => {
    const vis = new ChatVisibility()
    vis.set(MAIN, [3])
    vis.set(SPLIT, [7, 8])
    expect(suppressNotification(7, MAIN, vis)).toBe(false)
  })

  it('suppresses a chat visible in the focused window', () => {
    const vis = new ChatVisibility()
    vis.set(MAIN, [3])
    vis.set(SPLIT, [7, 8])
    expect(suppressNotification(7, SPLIT, vis)).toBe(true)
    expect(suppressNotification(3, MAIN, vis)).toBe(true)
  })

  it('shows it when no registered window is focused', () => {
    const vis = new ChatVisibility()
    vis.set(MAIN, [7])
    expect(suppressNotification(7, null, vis)).toBe(false)
  })

  it('shows a chat no window shows, even with a window focused', () => {
    const vis = new ChatVisibility()
    vis.set(MAIN, [3])
    expect(suppressNotification(7, MAIN, vis)).toBe(false)
  })
})
