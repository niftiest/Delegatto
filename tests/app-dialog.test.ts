import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppDialogs } from '../src/main/app-dialog'
import { choiceReady, toggleChoice, type MainDialogRequest } from '../src/shared/app-dialog'

const question: Omit<MainDialogRequest, 'id'> = {
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
    const sent: MainDialogRequest[] = []
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

  it('can\'t be asked for picks, since main only hears which button was pressed', () => {
    const { dialogs } = setup()
    const withChoice = { ...question, choice: { label: 'Pick', options: ['A', 'B'], count: 1, selected: [0] } }
    // @ts-expect-error a question from main has no choice
    void dialogs.ask(withChoice) // Checked by tsc, which runs over the tests too.
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

  it('asks in the window that asked, and cancels only that window\'s questions when it goes', async () => {
    const sent: Array<[number, string | undefined]> = []
    const fallback = vi.fn(async (_r: MainDialogRequest, _to: string | undefined) => 1)
    const dialogs = new AppDialogs<string>((r, to) => { sent.push([r.id, to]) }, fallback, 1000)
    const inSplit = dialogs.ask(question, 'split')
    const inMain = dialogs.ask(question)
    expect(sent).toEqual([[1, 'split'], [2, undefined]])
    dialogs.shown(1)
    dialogs.shown(2)
    dialogs.cancelFor('split')
    await expect(inSplit).resolves.toBe(0)
    dialogs.answer(2, 1)
    await expect(inMain).resolves.toBe(1)
  })

  it('hands the asking window to the fallback', async () => {
    const fallback = vi.fn(async (_r: MainDialogRequest, _to: string | undefined) => 1)
    const dialogs = new AppDialogs<string>(() => {}, fallback, 1000)
    const answer = dialogs.ask(question, 'split')
    await vi.advanceTimersByTimeAsync(1000)
    await expect(answer).resolves.toBe(1)
    expect(fallback.mock.calls[0]![1]).toBe('split')
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

describe('a question with options to pick', () => {
  const choice = { label: 'Pick 2 panes to close', options: ['A', 'B', 'C', 'D'], count: 2, selected: [2, 3] }
  it('is ready only with exactly the number asked for', () => {
    expect(choiceReady(choice, [2, 3])).toBe(true)
    expect(choiceReady(choice, [2])).toBe(false)
    expect(choiceReady(choice, [0, 1, 2])).toBe(false)
    expect(choiceReady(choice, [1, 1])).toBe(false)
    expect(choiceReady(choice, [1, 7])).toBe(false)
  })
  it('toggles a checkbox, keeping the picks in option order', () => {
    expect(toggleChoice([3], 0, 2)).toEqual([0, 3])
    expect(toggleChoice([0, 3], 3, 2)).toEqual([0])
  })
  it('replaces the pick when only one is asked for', () => {
    expect(toggleChoice([3], 1, 1)).toEqual([1])
  })
})
