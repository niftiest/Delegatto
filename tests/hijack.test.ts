import { describe, it, expect } from 'vitest'
import { hijackChat } from '../src/main/engine/hijack'
import type { LiveSessionEntry } from '../src/main/engine/live-sessions'
import { hijackBlock } from '../src/shared/hijack'
import { childEnv } from '../src/main/engine/transport'
import { terminalCommand } from '../src/main/engine/terminal'

const SID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb'
const FILE = `C:\\h\\.claude\\projects\\p\\${SID}.jsonl`

function setup(entry: Partial<LiveSessionEntry> | null, end: { failures?: Array<{ error: string }> } = {}) {
  const ended: unknown[] = []
  const removed: string[] = []
  const sessions: LiveSessionEntry[] = entry === null ? [] : [{ pid: 42, sessionId: SID, cwd: 'C:\\p', status: 'idle', entrypoint: 'cli', procStart: '123', ...entry }]
  const deps = {
    sessionsDir: 'C:\\h\\.claude\\sessions',
    owned: () => [],
    readSessions: () => sessions,
    isAlive: () => true,
    unlink: (p: string) => { removed.push(p) },
    end: (async (list: Iterable<unknown>) => { ended.push(...list); return { ended: [], failures: end.failures ?? [] } }) as never
  }
  return { deps, ended, removed }
}

describe('processes Delegatto starts', () => {
  it('do not inherit the session that launched Delegatto, but keep the settings of the user', () => {
    const env = childEnv({ CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_EFFORT: 'medium', CLAUDECODE: '1', CLAUDE_CODE_BRIDGE_SESSION_ID: 'y', CLAUDE_CONFIG_DIR: 'C:\c', ENABLE_LSP_TOOL: '1', PATH: 'p' })
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: 'C:\c', ENABLE_LSP_TOOL: '1', PATH: 'p', CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' })
  })
})

describe('opening a chat in a terminal', () => {
  const id = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb'
  it('carries the flags in either kind of terminal', () => {
    const flags = ['--dangerously-skip-permissions', '--model', 'opus', '--add-dir', 'D:\\my stuff']
    expect(terminalCommand('C:\\p', id, 'claude', 'wt.exe', flags).args).toEqual(['-d', 'C:\\p', 'claude', '--resume', id, ...flags])
    expect(terminalCommand('C:\\p', id, 'claude', null, flags).args[0]).toContain(`--resume ${id} --dangerously-skip-permissions --model opus --add-dir "D:\\my stuff"`)
    expect(terminalCommand('C:\\p', id, 'claude', 'wt.exe').args).toEqual(['-d', 'C:\\p', 'claude', '--resume', id])
  })
  it('refuses a flag that could break out of the command', () => {
    for (const bad of ['a&calc', 'a"b', 'a;b', '%PATH%']) expect(() => terminalCommand('C:\\p', id, 'claude', null, [bad])).toThrow(/extra CLI flag/)
  })
})

describe('who can be hijacked', () => {
  it('only a terminal waiting at its prompt', () => {
    expect(hijackBlock({ entrypoint: 'cli', status: 'idle' })).toBeNull()
    expect(hijackBlock({ entrypoint: 'cli', status: 'busy' })).toBe('working')
    expect(hijackBlock({ entrypoint: 'cli', status: 'shell' })).toBe('working')
    expect(hijackBlock({ entrypoint: 'cli', status: null })).toBe('working')
    expect(hijackBlock({ entrypoint: 'cli', status: 'something-new' })).toBe('working')
    expect(hijackBlock({ entrypoint: 'sdk-cli', status: 'idle' })).toBe('not-terminal')
    expect(hijackBlock({ entrypoint: null, status: 'idle' })).toBe('not-terminal')
  })
})

describe('hijackChat', () => {
  it('ends the idle terminal, verified by its start time, and clears its lock', async () => {
    const { deps, ended, removed } = setup({})
    await expect(hijackChat(FILE, deps)).resolves.toEqual({ ok: true })
    expect(ended).toEqual([{ pid: 42, sessionId: SID, cwd: 'C:\\p', name: null, procStart: '123' }])
    expect(removed).toEqual(['C:\\h\\.claude\\sessions\\42.json'])
  })

  it('refuses without touching anything while Claude is working', async () => {
    for (const status of ['busy', 'shell', undefined]) {
      const { deps, ended, removed } = setup({ status })
      const r = await hijackChat(FILE, deps)
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/still working/) })
      expect(ended).toEqual([])
      expect(removed).toEqual([])
    }
  })

  it('refuses another Claude app', async () => {
    const { deps, ended } = setup({ entrypoint: 'sdk-cli' })
    expect(await hijackChat(FILE, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/another Claude app/) })
    expect(ended).toEqual([])
  })

  it('leaves the lock in place if the process could not be ended', async () => {
    const { deps, removed } = setup({}, { failures: [{ error: 'Not ended: different start time' }] })
    expect(await hijackChat(FILE, deps)).toEqual({ ok: false, error: 'Not ended: different start time' })
    expect(removed).toEqual([])
  })

  it('has nothing to do when the chat is already free, or held for a different chat', async () => {
    const free = setup(null)
    await expect(hijackChat(FILE, free.deps)).resolves.toEqual({ ok: true })
    expect(free.ended).toEqual([])
    const other = setup({ sessionId: 'cccccccc-1111-4222-8333-dddddddddddd' })
    await expect(hijackChat(FILE, other.deps)).resolves.toEqual({ ok: true })
    expect(other.ended).toEqual([])
  })
})
