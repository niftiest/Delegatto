// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, within } from '@testing-library/react'
import { fake } from './fake-api'
import { flush } from './render'
import { Composer } from '../../src/renderer/components/Composer'
import type { ClaudeCommand, ClaudeInfo } from '../../src/shared/claude-info-types'

const cmd = (name: string, source: ClaudeCommand['source'], description = ''): ClaudeCommand =>
  ({ name, description, argumentHint: '', aliases: [], source, plugin: null })

const INFO: ClaudeInfo = {
  commands: [
    cmd('compact', 'builtin', 'Free up context'),
    cmd('simplify', 'builtin', 'A bundled skill'),
    cmd('probe-hi', 'project', 'Says hi'),
    cmd('build', 'user', 'Build loop'),
    cmd('anthropic-skills:docs', 'plugin', 'Docs'),
    cmd('mcp__rea__trace', 'mcp', 'Trace')
  ],
  agents: [{ type: 'Explore', description: 'Read-only search agent' }, { type: 'Plan', description: 'Plans' }],
  models: [],
  version: '2.1.319',
  fetchedAt: 0
}

function mount(props: { agents?: string[] | null; skills?: string[] | null } = {}) {
  fake.override({
    claudeInfo: () => Promise.resolve({ ok: true, info: INFO }),
    listProjectFiles: () => Promise.resolve(['src/plan.ts', 'README.md'])
  })
  const onSend = vi.fn()
  const view = render(<Composer sessionPk={1} running={false} cwd="C:\\p" onSend={onSend} onInterrupt={() => {}} {...props} />)
  const box = view.container.querySelector('textarea')!
  /** Types `text` as the box's whole content, with the caret at the end. */
  const type = async (text: string): Promise<void> => {
    act(() => { fireEvent.change(box, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } }) })
    await flush()
  }
  const menu = (): HTMLElement | null => view.queryByRole('listbox')
  const options = (): string[] => within(menu()!).getAllByRole('option').map(o => o.querySelector('.composer-menu-name')!.textContent!)
  return { view, box, type, menu, options, onSend }
}

describe('the / menu mid-message', () => {
  it('typing "please /" offers only skills and prompt commands', async () => {
    const { type, menu, options } = mount()
    await type('please /')
    expect(menu()).not.toBeNull()
    expect(menu()!.getAttribute('aria-label')).toBe('Skills and commands')
    expect(options()).toEqual(['/probe-hi', '/build', '/anthropic-skills:docs'])
  })

  it('offers a bundled skill once the chat says it is one', async () => {
    const { type, options } = mount({ skills: ['simplify', 'probe-hi'] })
    await type('please /')
    expect(options()).toEqual(['/probe-hi', '/build', '/anthropic-skills:docs', '/simplify'])
    expect(options()).not.toContain('/compact')
  })

  it('choosing one puts /name and a space where the token was', async () => {
    const { box, type, menu } = mount()
    await type('please /pro')
    const option = within(menu()!).getAllByRole('option')[0]!
    act(() => { fireEvent.mouseDown(option) })
    await flush()
    expect(box.value).toBe('please /probe-hi ')
    expect(box.selectionStart).toBe('please /probe-hi '.length)
  })

  it('leaves the menu at the start of a message as it was, built-ins included', async () => {
    const { type, menu, options } = mount()
    await type('/')
    expect(menu()!.getAttribute('aria-label')).toBe('Commands')
    expect(options()).toEqual(expect.arrayContaining(['/compact', '/probe-hi', '/mcp__rea__trace']))
  })

  it('sends a message with a /skill in it as typed', async () => {
    const { box, type, onSend } = mount()
    await type('please run /probe-hi now')
    act(() => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(onSend).toHaveBeenCalledWith('please run /probe-hi now', [], [], undefined, true)
  })

  // A mid-message / is often a path: Enter sends, as in the terminal.
  it('Enter with the menu open mid-message sends the message as typed', async () => {
    const { box, type, menu, onSend } = mount()
    await type('fix /docs')
    expect(menu()).not.toBeNull()
    act(() => { fireEvent.keyDown(box, { key: 'Enter' }) })
    expect(onSend).toHaveBeenCalledWith('fix /docs', [], [], undefined, true)
  })

  it('Enter takes the item after the user arrows into the list, and Tab takes it straight away', async () => {
    const { box, type, onSend } = mount()
    await type('fix /docs')
    act(() => { fireEvent.keyDown(box, { key: 'ArrowDown' }) })
    act(() => { fireEvent.keyDown(box, { key: 'ArrowUp' }) })
    act(() => { fireEvent.keyDown(box, { key: 'Enter' }) })
    await flush()
    expect(onSend).not.toHaveBeenCalled()
    expect(box.value).toBe('fix /anthropic-skills:docs ')

    await type('then /pro')
    act(() => { fireEvent.keyDown(box, { key: 'Tab' }) })
    await flush()
    expect(box.value).toBe('then /probe-hi ')
  })

  it('has no / menu in a ! shell command', async () => {
    const { type, menu } = mount()
    await type('!ls /docs')
    expect(menu()).toBeNull()
  })

  it('leaves keys to an IME while it is composing', async () => {
    const { box, type, onSend } = mount()
    await type('にほんご')
    act(() => { fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 }) })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('marks a live ultracode, and says what it does', async () => {
    const { view, type } = mount()
    await type('ultracode the "ultracode" docs')
    const marks = [...view.container.querySelectorAll('.composer-highlight mark.composer-keyword')].map(m => m.textContent)
    expect(marks).toEqual(['ultracode'])
    expect(view.getByText(/asks Claude to run a multi-agent workflow/)).toBeTruthy()
  })

  it('highlights known commands anywhere in the message', async () => {
    const { view, type } = mount()
    await type('/compact then /probe-hi and /nope')
    const marks = [...view.container.querySelectorAll('.composer-highlight mark')].map(m => m.textContent)
    expect(marks).toEqual(['/compact', '/probe-hi'])
  })
})

describe('agents in the @ menu', () => {
  it('lists the chat init agents beside files, and inserts @agent-<type>', async () => {
    const { box, type, menu, options } = mount({ agents: ['Explore', 'Plan'] })
    await type('ask @pla')
    expect(menu()!.getAttribute('aria-label')).toBe('Files and agents')
    expect(options()).toEqual(['Plan', 'plan.ts'])
    act(() => { fireEvent.mouseDown(within(menu()!).getAllByRole('option')[0]!) })
    await flush()
    expect(box.value).toBe('ask @agent-Plan ')
  })

  it('uses Claude Code’s own list before the chat has run, and files still work', async () => {
    const { box, type, menu, options } = mount()
    await type('read @READ')
    expect(options()).toEqual(['README.md'])
    act(() => { fireEvent.mouseDown(within(menu()!).getAllByRole('option')[0]!) })
    await flush()
    expect(box.value).toBe('read @README.md ')
    await type('ask @expl')
    expect(options()).toEqual(['Explore'])
  })
})
