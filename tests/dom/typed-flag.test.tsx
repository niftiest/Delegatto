// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { fake } from './fake-api'
import { channel, flush, renderSettled, session } from './render'
import { SplitApp } from '../../src/renderer/SplitApp'
import type { SplitState } from '../../src/shared/split-view'

// The whole way from the message box through ChatPane to api.send, in a real pane: whether
// a message goes to Claude Code marked as typed by the user (the `typed` argument).
const plant = channel(1, 'PlantPal')
const STATE: SplitState = {
  layout: 'halves', ratios: {}, bounds: null, maximized: false, minimized: false, open: true,
  panes: [{ sessionPk: 11, projectDir: plant.dirName }, null]
}

async function mount(): Promise<HTMLTextAreaElement> {
  fake.override({
    splitViewGet: () => Promise.resolve(STATE),
    listChannels: () => Promise.resolve([plant]),
    listSessions: () => Promise.resolve([session(11, 'Water schedule')])
  })
  await renderSettled(<SplitApp />)
  await flush(5)
  return document.querySelector<HTMLTextAreaElement>('[data-pane="0"] .composer textarea')!
}

async function type(box: HTMLTextAreaElement, text: string): Promise<void> {
  act(() => { fireEvent.change(box, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } }) })
  await flush()
}

async function pasteLarge(box: HTMLTextAreaElement, text: string): Promise<void> {
  act(() => { fireEvent.paste(box, { clipboardData: { files: [], getData: () => text } }) })
  await flush()
}

const sends = (): unknown[][] => fake.fn('send').mock.calls as unknown[][]

describe('typed messages reach api.send marked as typed', () => {
  it('a message typed in the box goes with typed = true', async () => {
    const box = await mount()
    await type(box, 'please run /probe-hi')
    act(() => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await flush()
    expect(sends()).toHaveLength(1)
    expect(sends()[0]![1]).toBe('please run /probe-hi')
    expect(sends()[0]![4]).toBe(true)
  })

  it('a message whose only live "ultracode" was pasted goes with typed = false', async () => {
    const box = await mount()
    await pasteLarge(box, Array.from({ length: 40 }, (_, i) => `line ${i} ultracode`).join('\n'))
    await type(box, 'what does this log say')
    act(() => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await flush()
    expect(sends()).toHaveLength(1)
    expect(String(sends()[0]![1])).toContain('[Pasted text #1')
    expect(sends()[0]![4]).toBe(false)
  })
})
