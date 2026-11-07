import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppDialogs } from '../src/main/app-dialog'
import type { AppDialogRequest } from '../src/shared/app-dialog'

const question: Omit<AppDialogRequest, 'id'> = {
  title: 'Close?',
  detail: ['Sure?'],
  buttons: [{ label: 'Cancel', kind: 'secondary' }, { label: 'Exit', kind: 'primary' }],
  defaultIndex: 1,
  cancelIndex: 0
}

describe('AppDialogs', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup(sendThrows = false) {
    const sent: AppDialogRequest[] = []
    const fallback = vi.fn(async () => 1)
    const dialogs = new AppDialogs(r => { if (sendThrows) throw new Error('gone'); sent.push(r) }, fallback, 1000)
    return { sent, fallback, dialogs }
  }

  it('gives back the button the window answered with', async () => {
    const { sent, fallback, dialogs } = setup()
    const answer = dialogs.ask(question)
    dialogs.shown(sent[0]!.id)
    await vi.advanceTimersByTimeAsync(60_000)
    dialogs.answer(sent[0]!.id, 1)
    await expect(answer).resolves.toBe(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('waits as long as it takes once the window is showing it', async () => {
    const { sent, dialogs } = setup()
    let settled = false
    void dialogs.ask(question).then(() => { settled = true })
    dialogs.shown(sent[0]!.id)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).toBe(false)
  })

  it('falls back when the window never says it is showing the question', async () => {
    const { fallback, dialogs } = setup()
    const answer = dialogs.ask(question)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(answer).resolves.toBe(1)
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the window has already gone', async () => {
    const { fallback, dialogs } = setup(true)
    const answer = dialogs.ask(question)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(answer).resolves.toBe(1)
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('takes the cancel answer if the fallback itself fails', async () => {
    const dialogs = new AppDialogs(() => {}, async () => { throw new Error('no') }, 1000)
    const answer = dialogs.ask(question)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(answer).resolves.toBe(0)
  })

  it('ignores an answer that is out of range, or for an unknown question', async () => {
    const { sent, dialogs } = setup()
    const answer = dialogs.ask(question)
    dialogs.shown(sent[0]!.id)
    dialogs.answer(sent[0]!.id, 7)
    dialogs.answer(sent[0]!.id, -1)
    dialogs.answer(999, 1)
    dialogs.answer(sent[0]!.id, 0)
    await expect(answer).resolves.toBe(0)
  })

  it('cancels whatever is open when the window goes', async () => {
    const { sent, fallback, dialogs } = setup()
    const shown = dialogs.ask(question)
    const waiting = dialogs.ask(question)
    dialogs.shown(sent[0]!.id)
    dialogs.cancelAll()
    await expect(shown).resolves.toBe(0)
    await expect(waiting).resolves.toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fallback).not.toHaveBeenCalled()
  })
})
