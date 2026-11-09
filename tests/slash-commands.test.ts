import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRenderItems } from '../src/main/jsonl/render'
import { isDisplayRow, textOf } from '../src/main/jsonl/parse'
import type { MessageRow } from '../src/main/jsonl/rows'
import { parseControlResponse, parseEvent } from '../src/main/engine/events'
import { Transport } from '../src/main/engine/transport'
import { mcpLoginCommand } from '../src/main/engine/terminal'
import { ClaudeInfoService, INFO_ARGS, parseAgents, parseCommands } from '../src/main/engine/claude-info'
import type { ChildLike } from '../src/main/engine/transport'
import { listProjectFiles } from '../src/main/project-files'
import { agentMention, agentOptions, keywordRanges, sendsAsTyped, applyCompletion, hideAnsweredCommands, commandTokenLength, commandTokenRanges, completionAt, midMessageCommands, rankMentions, fileMention, filterCommands, isClearCommand, matchesCommandName, mcpCommandOf, appCommandOf, nthLatestReply, mcpProblems, rankFiles, sideQuestionOf, renameCommandOf, addDirCommandOf, terminalOnlyCommand, isForkCommand, isRewindCommand } from '../src/renderer/lib'
import type { ClaudeCommand, McpServerStatus } from '../src/shared/claude-info-types'

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written: string[] = []
  pid = 1
  stdin = { write: (s: string) => { this.written.push(s); return true }, end: () => { /* unused */ } }
  kill(): void { /* unused */ }
}

let n = 0
function user(content: unknown, extra: Record<string, unknown> = {}): MessageRow {
  return { type: 'user', uuid: `u${++n}`, parentUuid: null, message: { role: 'user', content }, ...extra } as MessageRow
}
const texts = (rows: Parameters<typeof buildRenderItems>[0]) => buildRenderItems(rows).map(i => i.kind === 'text' ? `${i.role}: ${i.text}` : i.kind === 'notice' ? `notice: ${i.label ?? ''}` : i.kind)

describe('rows Claude Code stores but never typed by anyone', () => {
  it('hides context notes and shows commands as typed', () => {
    expect(texts([
      user('<local-command-caveat>The command below was run directly</local-command-caveat>', { isMeta: true }),
      user('<command-name>/context</command-name>\n   <command-message>context</command-message>\n   <command-args></command-args>'),
      user('<command-message>probe-skill</command-message>\n<command-name>/probe-skill</command-name>'),
      user('<command-name>/compact</command-name><command-args>keep the plan</command-args>'),
      user([{ type: 'text', text: 'Base directory for this skill: C:\\x' }], { isMeta: true }),
      user('[Image: source: C:\\x.png]', { isMeta: true })
    ])).toEqual(['user: /context', 'user: /probe-skill', 'user: /compact keep the plan'])
  })

  it('turns a compaction into one collapsed notice, without its receipt', () => {
    const items = buildRenderItems([
      user('This session is being continued from a previous conversation...', { isCompactSummary: true }),
      user('<local-command-stdout>Compacted </local-command-stdout>')
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'notice', label: 'Conversation compacted' })
  })

  it('shows /compact before its summary, though the file stores them the other way', () => {
    const items = buildRenderItems([
      user('Summary...', { isCompactSummary: true }),
      user('note', { isMeta: true }),
      user('<command-name>/compact</command-name>'),
      user('<local-command-stdout>Compacted </local-command-stdout>')
    ])
    expect(items.map(i => i.kind)).toEqual(['text', 'notice'])
  })

  it('shows command output as a reply, from either kind of row', () => {
    const system = (content: string, uuid: string) => ({ type: 'system', subtype: 'local_command', uuid, content }) as never
    expect(texts([
      system('<local-command-stdout>## Context Usage</local-command-stdout>', 's1'),
      system('/export', 's2'),
      system("<local-command-stdout>/export isn't available</local-command-stdout>", 's3'),
      user('<bash-input>ls</bash-input>'),
      user('<bash-stdout>a.txt\u001b[0m</bash-stdout><bash-stderr></bash-stderr>')
    ])).toEqual(['assistant: ## Context Usage', 'user: /export', "assistant: /export isn't available", 'user: !ls', 'assistant: a.txt'])
  })

  it('shows only the reply to a command that has one', () => {
    const shown = (rows: Parameters<typeof buildRenderItems>[0]) =>
      hideAnsweredCommands(buildRenderItems(rows)).map(i => i.kind === 'text' ? `${i.role}: ${i.text}` : i.kind)
    const system = (content: string, uuid: string) => ({ type: 'system', subtype: 'local_command', uuid, content }) as never
    expect(shown([
      user('<command-name>/model</command-name><command-args>claude-opus-5</command-args>'),
      user('<local-command-stdout>Set model to claude-opus-5</local-command-stdout>'),
      system('/export', 's2'),
      system("<local-command-stdout>/export isn't available</local-command-stdout>", 's3'),
      // No reply of its own: it stays, so the chat shows it ran
      user('<command-name>/compact</command-name>'),
      user('<local-command-stdout>Compacted </local-command-stdout>'),
      // A skill is a message to Claude, answered by Claude
      user('<command-name>/probe-skill</command-name>'),
      { type: 'assistant', uuid: 'a1', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } } as MessageRow,
      // Shell commands keep what was run
      user('<bash-input>ls</bash-input>'),
      user('<bash-stdout>a.txt</bash-stdout>')
    ])).toEqual([
      'assistant: Set model to claude-opus-5', "assistant: /export isn't available", 'user: /compact',
      'user: /probe-skill', 'assistant: Done.', 'user: !ls', 'assistant: a.txt'
    ])
  })

  it('keeps ordinary messages that merely mention the tags', () => {
    expect(texts([user('why does <command-name> show up?')])).toEqual(['user: why does <command-name> show up?'])
  })

  it('gives a command output row to the page holding the message before it', () => {
    const a = user('first')
    const b = user('second')
    const output = { type: 'system', subtype: 'local_command', uuid: 's', content: '<local-command-stdout>out</local-command-stdout>' } as never
    const rows = [a, output, b]
    expect(buildRenderItems(rows, new Set([a.uuid])).map(i => i.kind === 'text' && i.text)).toEqual(['first', 'out'])
    expect(buildRenderItems(rows, new Set([b.uuid])).map(i => i.kind === 'text' && i.text)).toEqual(['second'])
  })

  it('only lets local-command system rows through the display filter', () => {
    expect(isDisplayRow({ type: 'system', subtype: 'local_command', uuid: 's', content: 'x' })).toBe(true)
    expect(isDisplayRow({ type: 'system', subtype: 'compact_boundary', uuid: 's', content: 'x' })).toBe(false)
    expect(isDisplayRow({ type: 'system', subtype: 'turn_duration', uuid: 's' })).toBe(false)
  })

  it('keeps previews, titles and search free of them', () => {
    expect(textOf(user('<command-name>/compact</command-name>'))).toBe('/compact')
    expect(textOf(user('note', { isMeta: true }))).toBe('')
    expect(textOf(user('This session is being continued', { isCompactSummary: true }))).toBe('')
    expect(textOf(user('a real question'))).toBe('a real question')
  })
})

describe('live status', () => {
  it('reads compaction progress', () => {
    expect(parseEvent('{"type":"system","subtype":"status","status":"compacting"}')).toEqual({ kind: 'status', status: 'compacting' })
    expect(parseEvent('{"type":"system","subtype":"status"}')).toEqual({ kind: 'status', status: null })
  })
})

describe('asking Claude Code what it has', () => {
  it('sorts commands by where they came from and drops what cannot run here', () => {
    const commands = parseCommands([
      { name: 'build', description: 'Build loop (user)' },
      { name: 'probe', description: 'Probe (project)' },
      { name: 'superpowers:brainstorming', description: '(superpowers) Think first', aliases: ['brainstorming'] },
      { name: 'marketing-skills:ad-creative', description: 'Ads' },
      { name: 'docx', description: 'Word files (claude.ai sync)' },
      { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
      { name: 'mcp__rea__trace', description: 'Trace (MCP)' },
      { name: 'clear', description: 'Clear (resumable with /resume)', builtin: true },
      { name: 'doctor', description: 'Check', builtin: true },
      { name: '__remote-workflow', description: 'x', builtin: true },
      { name: 'workflow-launch-exec', description: 'x (workflow_launch event sessions only)', builtin: true },
      { description: 'nameless' }
    ])
    expect(commands.map(c => [c.name, c.source, c.plugin])).toEqual([
      ['build', 'user', null],
      ['probe', 'project', null],
      ['superpowers:brainstorming', 'plugin', 'superpowers'],
      ['marketing-skills:ad-creative', 'plugin', 'marketing-skills'],
      ['docx', 'synced', null],
      ['compact', 'builtin', null],
      ['mcp__rea__trace', 'mcp', null],
      ['clear', 'builtin', null],
      // A bundled skill now: it runs headless, so it stays.
      ['doctor', 'builtin', null]
    ])
    expect(commands[0]!.description).toBe('Build loop')
    expect(commands[2]!.description).toBe('Think first')
    expect(commands[2]!.aliases).toEqual(['brainstorming'])
    expect(commands[5]!.argumentHint).toBe('<instructions>')
  })

  it('reads the agents from the initialize answer', () => {
    expect(parseAgents([
      { name: 'Explore', description: 'Read-only search agent', model: 'haiku' },
      { name: 'statusline-setup' },
      { description: 'nameless' },
      'junk'
    ])).toEqual([
      { type: 'Explore', description: 'Read-only search agent' },
      { type: 'statusline-setup', description: '' }
    ])
    expect(parseAgents(undefined)).toEqual([])
  })

  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    written: string[] = []
    ended = false
    pid = 1
    stdin = { write: (s: string) => { this.written.push(s); return true }, end: () => { this.ended = true } }
    kill(): void { /* unused */ }
  }

  function service() {
    const children: FakeChild[] = []
    const calls: Array<{ args: string[]; cwd: string }> = []
    let clock = 1000
    const svc = new ClaudeInfoService({
      claudeBin: 'claude',
      now: () => clock,
      spawnFn: (_bin, args, cwd) => {
        calls.push({ args, cwd })
        const child = new FakeChild()
        children.push(child)
        return child as unknown as ChildLike
      }
    })
    return { svc, children, calls, advance: (ms: number) => { clock += ms } }
  }
  /** Answers the newest request, echoing its id as Claude does. */
  const reply = (child: FakeChild, response: unknown): void => {
    const { request_id } = JSON.parse(child.written[child.written.length - 1]!) as { request_id: string }
    child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response } }) + '\n')
  }
  const answer = (child: FakeChild): void => reply(child, { commands: [{ name: 'a', description: 'A (user)' }], agents: [{ name: 'Explore', description: 'Search' }], claude_code_version: '2.1.316' })

  it('sends no message, closes the process when answered, and never starts MCP servers', async () => {
    const { svc, children, calls } = service()
    const request = svc.get('C:\\p')
    answer(children[0]!)
    const info = await request
    // Claude's own, then the ones Delegatto answers itself.
    expect(info.commands[0]!.name).toBe('a')
    expect(info.commands.map(c => c.name)).toEqual(expect.arrayContaining(['memory', 'status', 'add-dir', 'rewind']))
    expect(info.version).toBe('2.1.316')
    expect(info.agents).toEqual([{ type: 'Explore', description: 'Search' }])
    expect(children[0]!.ended).toBe(true)
    expect(calls[0]!.args).toBe(INFO_ARGS)
    expect(INFO_ARGS).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config']))
    expect(children[0]!.written).toHaveLength(1)
    expect(JSON.parse(children[0]!.written[0]!)).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
  })

  it('asks once per folder until the answer goes stale', async () => {
    const { svc, children, advance } = service()
    const [a, b] = [svc.get('C:\\p'), svc.get('C:\\p')]
    expect(children).toHaveLength(1)
    answer(children[0]!)
    await Promise.all([a, b])
    await svc.get('C:\\p')
    expect(children).toHaveLength(1)
    const other = svc.get('C:\\q')
    expect(children).toHaveLength(2)
    answer(children[1]!)
    await other
    advance(6 * 60_000)
    const stale = svc.get('C:\\p')
    expect(children).toHaveLength(3)
    answer(children[2]!)
    await stale
  })

  it('checks MCP servers by starting them, waits out slow ones, and hides its own', async () => {
    const children: FakeChild[] = []
    const argsSeen: string[][] = []
    const svc = new ClaudeInfoService({
      claudeBin: 'claude',
      sleep: async () => { setTimeout(() => reply(children[0]!, { mcpServers: [
        { name: 'slow', status: 'connected', tools: [{ name: 'ping' }], transport: 'stdio', source: 'user', config: { type: 'stdio', command: 'node', args: ['s.js'], env: { TOKEN: 'secret' } } },
        { name: 'down', status: 'failed', error: 'ECONNREFUSED', source: 'user', config: { type: 'http', url: 'http://x', headers: { Authorization: 'secret' } } },
        { name: 'delegatto', status: 'connected', source: 'dynamic' }
      ] }), 0) },
      chromeEnabled: () => true,
      spawnFn: (_b, args) => { argsSeen.push(args); const c = new FakeChild(); children.push(c); return c as unknown as ChildLike }
    })
    const check = svc.mcpCheck('C:\\p')
    reply(children[0]!, { mcpServers: [{ name: 'slow', status: 'pending' }] })
    const servers = await check
    expect(servers.map(s => [s.name, s.status, s.error, s.tools, s.detail])).toEqual([
      ['slow', 'connected', null, ['ping'], 'node s.js'],
      ['down', 'failed', 'ECONNREFUSED', [], 'http://x']
    ])
    expect(JSON.stringify(servers)).not.toContain('secret')
    expect(children[0]!.ended).toBe(true)
    expect(argsSeen[0]).not.toContain('--strict-mcp-config')
    expect(argsSeen[0]).toContain('--chrome')
    expect(children[0]!.written.every(w => (JSON.parse(w) as { type: string }).type === 'control_request')).toBe(true)
  })

  it('reports failures and doesn\'t cache them', async () => {
    const { svc, children } = service()
    const failed = svc.get('C:\\p')
    children[0]!.emit('exit', 1)
    await expect(failed).rejects.toThrow(/exited early/)
    const missing = svc.get('C:\\p')
    expect(children).toHaveLength(2)
    children[1]!.emit('error', new Error('spawn claude ENOENT'))
    await expect(missing).rejects.toThrow(/ENOENT/)
  })
})

describe('MCP status', () => {
  const server = (name: string, status: string, source = 'user'): McpServerStatus => ({ name, status, source, error: null, transport: null, detail: '', tools: [] })

  it('warns about failed servers and sign-ins, except unused claude.ai connectors and ones you silenced', () => {
    const all = [server('a', 'connected'), server('b', 'failed'), server('c', 'needs-auth', 'plugin'), server('d', 'needs-auth', 'claudeai'), server('e', 'pending'), server('f', 'disabled'), server('g', 'failed')]
    expect(mcpProblems(all, ['g']).map(s => s.name)).toEqual(['b', 'c'])
  })

  it('reads the per-turn report, without Delegatto\'s own server', () => {
    const e = parseEvent(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', cwd: 'c', model: 'm', permissionMode: 'auto',
      mcp_servers: [{ name: 'rea', status: 'failed', source: 'user' }, { name: 'delegatto', status: 'connected' }] }))
    expect(e).toMatchObject({ kind: 'init', mcpServers: [{ name: 'rea', status: 'failed' }] })
    expect((e as { mcpServers: unknown[] }).mcpServers).toHaveLength(1)
  })

  it('reads control answers apart from everything else', () => {
    expect(parseControlResponse('{"type":"control_response","response":{"subtype":"success","request_id":"1","response":{"x":1}}}')).toEqual({ requestId: '1', ok: true, response: { x: 1 } })
    expect(parseControlResponse('{"type":"control_response","response":{"subtype":"error","request_id":"2","error":"nope"}}')).toEqual({ requestId: '2', ok: false, error: 'nope' })
    expect(parseControlResponse('{"type":"assistant","note":"control_response"}')).toBeNull()
  })

  it('asks a chat\'s process without treating the answer as a chat event', async () => {
    const child = new FakeProcess()
    const t = new Transport({ cwd: 'c', skipPermissions: true }, { claudeBin: 'claude', spawnFn: () => child as unknown as ChildLike })
    const events: unknown[] = []
    t.on(e => events.push(e))
    t.start()
    const asked = t.request('mcp_reconnect', { serverName: 'rea' })
    const sent = JSON.parse(child.written[0]!) as { request_id: string; request: unknown }
    expect(sent.request).toEqual({ subtype: 'mcp_reconnect', serverName: 'rea' })
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: sent.request_id, response: 'done' } }) + '\n'))
    await expect(asked).resolves.toBe('done')
    expect(events).toEqual([])
    const orphaned = t.request('mcp_status')
    child.emit('exit', 0)
    await expect(orphaned).rejects.toThrow(/stopped/)
    await expect(t.request('mcp_status')).rejects.toThrow(/no process/)
  })

  it('builds a sign-in command that can\'t break out of its quoting', () => {
    expect(mcpLoginCommand('C:\\p', 'claude.ai Gmail', 'claude', 'wt.exe')).toEqual({ file: 'wt.exe', args: ['-d', 'C:\\p', 'claude', 'mcp', 'login', 'claude.ai Gmail'], verbatim: false })
    expect(mcpLoginCommand('C:\\p', 'plugin:context7:context7', 'claude', null).args[0]).toContain('mcp login "plugin:context7:context7"')
    for (const bad of ['x"&calc', 'a;b', 'a&b', 'a%PATH%']) expect(() => mcpLoginCommand('C:\\p', bad, 'claude', null)).toThrow()
  })
})

const cmd = (name: string, source: ClaudeCommand['source'] = 'builtin', description = '', aliases: string[] = []): ClaudeCommand =>
  ({ name, description, argumentHint: '', aliases, source, plugin: null })

describe('composer completion', () => {
  it('offers commands only for the first word, and files after an @', () => {
    expect(completionAt('/', 1)).toMatchObject({ kind: 'command', query: '', start: 0 })
    expect(completionAt('/com', 4)).toMatchObject({ kind: 'command', query: 'com' })
    expect(completionAt('/compact now', 12)).toBeNull()
    expect(completionAt('/usr/bin', 8)).toBeNull()
    // Mid-message, a / after a space is a mention: see 'mid-message triggers'.
    expect(completionAt('run /compact', 12)).toMatchObject({ kind: 'command', mid: true })
    expect(completionAt('@', 1)).toMatchObject({ kind: 'file', query: '', start: 0 })
    expect(completionAt('read @src/ma', 12)).toMatchObject({ kind: 'file', query: 'src/ma', start: 5 })
    expect(completionAt('read @"my di', 12)).toMatchObject({ kind: 'file', query: 'my di', start: 5 })
    expect(completionAt('me@example.com', 14)).toBeNull()
    expect(completionAt('@a.txt b', 8)).toBeNull()
  })

  it('completes in place, and the caret lands after the insert', () => {
    expect(applyCompletion('/com', completionAt('/com', 4)!, '/compact')).toEqual({ text: '/compact ', caret: 9 })
    const at = completionAt('read @no please', 8)!
    expect(applyCompletion('read @no please', at, '@note.txt')).toEqual({ text: 'read @note.txt please', caret: 15 })
    expect(fileMention('src/a.ts')).toBe('@src/a.ts')
    expect(fileMention('my dir/a b.txt')).toBe('@"my dir/a b.txt"')
  })

  it('puts the exact command first when typing part of it', () => {
    const all = [cmd('marketing:competitor', 'plugin', '', ['competitor']), cmd('computer-use', 'synced'), cmd('compact')]
    expect(filterCommands(all, 'comp').map(c => c.name)).toEqual(['compact', 'computer-use', 'marketing:competitor'])
  })

  it('tells a real name match from a word in the description', () => {
    const c = cmd('update-config', 'builtin', 'Configure hooks and settings')
    expect(matchesCommandName(c, 'hooks')).toBe(false)
    expect(matchesCommandName(c, 'upd')).toBe(true)
    expect(matchesCommandName(c, 'config')).toBe(true)
    expect(matchesCommandName(c, '')).toBe(true)
  })

  it('ranks commands: exact, prefix, plugin part, anywhere, description', () => {
    const all = [cmd('recompact'), cmd('compact-helper'), cmd('compact'), cmd('x:compacting', 'plugin'), cmd('tidy', 'user', 'compact things')]
    expect(filterCommands(all, 'compact').map(c => c.name)).toEqual(['compact', 'compact-helper', 'x:compacting', 'recompact', 'tidy'])
    expect(filterCommands(all, 'zzz')).toEqual([])
    expect(filterCommands([cmd('superpowers:brainstorming', 'plugin', '', ['brainstorming'])], 'brain')).toHaveLength(1)
  })

  it('lists project and personal first when nothing is typed', () => {
    expect(filterCommands([cmd('a'), cmd('b', 'user'), cmd('c', 'project')], '').map(c => c.name)).toEqual(['c', 'b', 'a'])
  })

  it('ranks files by name before path, shortest first', () => {
    const paths = ['src/main/index.ts', 'index.html', 'docs/indexing/plan.md', 'src/', 'a/b/idx.ts']
    expect(rankFiles(paths, 'index')).toEqual(['index.html', 'src/main/index.ts', 'docs/indexing/plan.md'])
    expect(rankFiles(paths, 'idx')).toContain('a/b/idx.ts')
    expect(rankFiles(paths, 'src')[0]).toBe('src/')
    expect(rankFiles(paths, 'src\\main')).toEqual(['src/main/index.ts'])
  })

  it('highlights only commands that exist', () => {
    const known = [cmd('compact'), cmd('superpowers:brainstorming', 'plugin', '', ['brainstorming'])]
    expect(commandTokenLength('/compact keep it', known)).toBe(8)
    expect(commandTokenLength('/brainstorming', known)).toBe(14)
    expect(commandTokenLength('/nope', known)).toBe(0)
    expect(commandTokenLength('/clear', [])).toBe(6)
    expect(commandTokenLength('hi /compact', known)).toBe(0)
  })

  it('recognises /clear and its aliases', () => {
    for (const t of ['/clear', ' /CLEAR ', '/new', '/reset']) expect(isClearCommand(t)).toBe(true)
    for (const t of ['/clearly', 'please /clear', '/compact']) expect(isClearCommand(t)).toBe(false)
  })
})

describe('mid-message triggers', () => {
  it('opens the / menu after whitespace or CJK punctuation, with the caret in the token', () => {
    expect(completionAt('please /', 8)).toEqual({ kind: 'command', query: '', start: 7, end: 8, mid: true })
    expect(completionAt('please /pro', 11)).toEqual({ kind: 'command', query: 'pro', start: 7, end: 11, mid: true })
    expect(completionAt('a\n/x', 4)).toMatchObject({ kind: 'command', query: 'x', start: 2, mid: true })
    expect(completionAt('。/x', 3)).toMatchObject({ kind: 'command', query: 'x', start: 1, mid: true })
    // The caret inside the token: the whole token is replaced.
    expect(completionAt('run /probe-hi now', 7)).toEqual({ kind: 'command', query: 'pr', start: 4, end: 13, mid: true })
    // Not glued to a word, not a path, not past the token.
    expect(completionAt('and/or', 6)).toBeNull()
    expect(completionAt('see /usr/bin', 12)).toBeNull()
    expect(completionAt('run /x y', 8)).toBeNull()
  })

  it('leaves the menu at the start of a message as it was', () => {
    expect(completionAt('/', 1)).toEqual({ kind: 'command', query: '', start: 0, end: 1 })
    expect(completionAt('/com', 4)).toEqual({ kind: 'command', query: 'com', start: 0, end: 4 })
  })

  it('stays off in a ! shell command', () => {
    expect(completionAt('!ls /tm', 7)).toBeNull()
    expect(completionAt('  !grep -r x /us', 16)).toBeNull()
  })

  it('stays off when the message starts with a command that takes paths or names', () => {
    for (const lead of ['/add-dir', '/cd', '/resume', '/plugin', '/plugins', '/marketplace']) {
      const text = `${lead} /x`
      expect(completionAt(text, text.length)).toBeNull()
    }
    expect(completionAt('/compact /x', 11)).toMatchObject({ kind: 'command', mid: true, query: 'x' })
  })

  it('offers only skills and prompt commands mid-message', () => {
    const all = [
      cmd('compact'), cmd('doctor'), cmd('probe-hi', 'project'), cmd('build', 'user'),
      cmd('superpowers:brainstorming', 'plugin'), cmd('docx', 'synced'), cmd('mcp__rea__trace', 'mcp'), cmd('btw')
    ]
    expect(midMessageCommands(all, null).map(c => c.name)).toEqual(['probe-hi', 'build', 'superpowers:brainstorming', 'docx'])
    // A bundled skill comes as a built-in: the chat's init says it's a skill.
    expect(midMessageCommands(all, ['doctor', 'probe-hi']).map(c => c.name)).toEqual(['doctor', 'probe-hi', 'build', 'superpowers:brainstorming', 'docx'])
  })

  it('inserts /name and a space in place of the typed token', () => {
    const text = 'please /pro and then'
    const at = completionAt(text, 11)!
    expect(applyCompletion(text, at, '/probe-hi')).toEqual({ text: 'please /probe-hi and then', caret: 17 })
    expect(applyCompletion('please /', completionAt('please /', 8)!, '/probe-hi')).toEqual({ text: 'please /probe-hi ', caret: 17 })
  })

  it('never handles a message that starts with text as one of the app commands', () => {
    for (const name of ['clear', 'btw why', 'rename x', 'add-dir docs', 'mcp', 'login', 'fork', 'rewind', 'plan it', 'theme', 'probe-hi']) {
      const text = `please /${name}`
      expect(appCommandOf(text)).toBeNull()
      expect(isClearCommand(text)).toBe(false)
      expect(sideQuestionOf(text)).toBeNull()
      expect(renameCommandOf(text)).toBeNull()
      expect(addDirCommandOf(text)).toBeNull()
      expect(mcpCommandOf(text)).toBeNull()
      expect(terminalOnlyCommand(text)).toBeNull()
      expect(isForkCommand(text)).toBe(false)
      expect(isRewindCommand(text)).toBe(false)
    }
  })

  it('highlights known commands anywhere in the message', () => {
    const known = [cmd('compact'), cmd('probe-hi', 'project'), cmd('superpowers:brainstorming', 'plugin', '', ['brainstorming'])]
    expect(commandTokenRanges('/compact then /probe-hi.', known)).toEqual([{ start: 0, end: 8 }, { start: 14, end: 23 }])
    expect(commandTokenRanges('use /brainstorming and /nope or a/probe-hi', known)).toEqual([{ start: 4, end: 18 }])
    expect(commandTokenRanges('。/compact', known)).toEqual([{ start: 1, end: 9 }])
    expect(commandTokenRanges('/clear', [])).toEqual([{ start: 0, end: 6 }])
    expect(commandTokenRanges('nothing here', known)).toEqual([])
  })
})

describe('the ultracode keyword', () => {
  const at = (text: string): string[] => keywordRanges(text, 'ultracode').map(r => text.slice(r.start, r.end))

  it('finds it as Claude Code does', () => {
    expect(at('please ultracode this')).toEqual(['ultracode'])
    expect(at('ULTRACODE. Then stop')).toEqual(['ULTRACODE'])
    expect(keywordRanges('do it ultracode', 'ultracode')).toEqual([{ start: 6, end: 15 }])
  })

  it('skips it in quotes, backticks, brackets and tags, next to / \ -, and in a leading command', () => {
    for (const text of ['say "ultracode" here', 'the `ultracode` word', "it's 'ultracode' now", '(ultracode)', '[a [ultracode]', '<ultracode> x',
      'src/ultracode', 'ultracode/x', 'pre-ultracode', 'ultracode-ish', 'ultracode?', 'ultracode.ts', '/compact ultracode', 'ultracoder']) {
      expect(at(text)).toEqual([])
    }
    // An apostrophe inside a word doesn't open a quote.
    expect(at("don't ultracode")).toEqual(['ultracode'])
  })

  it('sends a message whose only live ultracode was pasted without the typed mark', () => {
    const chip = (text: string) => ({ id: 'p', text, lineCount: 30 })
    expect(sendsAsTyped('look at this', [chip('a log line saying ultracode\n...')])).toBe(false)
    expect(sendsAsTyped('ultracode: look at this', [chip('ultracode again')])).toBe(true)
    expect(sendsAsTyped('look at "ultracode"', [chip('ultracode')])).toBe(false)
    expect(sendsAsTyped('look at this', [chip('`ultracode` in backticks')])).toBe(true)
    expect(sendsAsTyped('nothing pasted, ultracode', [])).toBe(true)
    expect(sendsAsTyped('look at this', [chip('just a log')])).toBe(true)
  })
})

describe('agents in the @ menu', () => {
  const info = [{ type: 'Explore', description: 'Read-only search' }, { type: 'Plan', description: 'Plans' }]

  it('takes the names from the chat init and the descriptions from Claude Code', () => {
    expect(agentOptions(['claude', 'Explore'], info)).toEqual([{ type: 'claude', description: '' }, { type: 'Explore', description: 'Read-only search' }])
    expect(agentOptions(null, info)).toEqual(info)
  })

  it('inserts @agent-<type>, and leaves out a type with a space, which Claude Code cannot read', () => {
    expect(agentMention('Explore')).toBe('@agent-Explore')
    expect(agentOptions(['code reviewer', 'Plan'], info)).toEqual([{ type: 'Plan', description: 'Plans' }])
    expect(agentOptions(null, [...info, { type: 'code reviewer', description: '' }])).toEqual(info)
  })

  it('lists agents with files: name matches first, other matches after the files', () => {
    const files = ['src/plan.ts', 'README.md']
    expect(rankMentions(files, info, 'pla')).toEqual([
      { kind: 'agent', agent: info[1] },
      { kind: 'file', path: 'src/plan.ts' }
    ])
    expect(rankMentions(files, info, 'xplor')).toEqual([{ kind: 'agent', agent: info[0] }])
    expect(rankMentions(files, info, 'agent-ex')).toEqual([{ kind: 'agent', agent: info[0] }])
    expect(rankMentions(files, info, '')).toEqual([
      { kind: 'file', path: 'README.md' }, { kind: 'file', path: 'src/plan.ts' },
      { kind: 'agent', agent: info[0] }, { kind: 'agent', agent: info[1] }
    ])
    // A path being typed is about files only.
    expect(rankMentions(files, info, 'src/')).toEqual([{ kind: 'file', path: 'src/plan.ts' }])
  })
})

describe('project files for the @ picker', () => {
  it('walks a folder without git, skipping generated ones and listing folders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-files-'))
    try {
      mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
      mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
      writeFileSync(join(dir, 'a.txt'), '')
      writeFileSync(join(dir, 'src', 'deep', 'b.ts'), '')
      writeFileSync(join(dir, 'node_modules', 'x', 'c.js'), '')
      const paths = listProjectFiles(dir)
      expect(paths).toEqual(expect.arrayContaining(['a.txt', 'src/', 'src/deep/', 'src/deep/b.ts']))
      expect(paths.some(p => p.includes('node_modules'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('copes with no folder', () => {
    expect(listProjectFiles(null)).toEqual([])
    expect(listProjectFiles('')).toEqual([])
  })
})

describe('/mcp', () => {
  it('opens the servers when bare, or for anything it does not act on', () => {
    expect(mcpCommandOf('/mcp')).toEqual({ action: 'open' })
    expect(mcpCommandOf('  /MCP  ')).toEqual({ action: 'open' })
    expect(mcpCommandOf('/mcp reconnect')).toEqual({ action: 'open' })
    expect(mcpCommandOf('/mcp something')).toEqual({ action: 'open' })
  })

  it('acts at once, as the terminal does, with all servers when none is named', () => {
    expect(mcpCommandOf('/mcp reconnect github')).toEqual({ action: 'reconnect', target: 'github' })
    expect(mcpCommandOf('/mcp disable claude.ai Gmail')).toEqual({ action: 'disable', target: 'claude.ai Gmail' })
    expect(mcpCommandOf('/mcp enable')).toEqual({ action: 'enable', target: 'all' })
    expect(mcpCommandOf('/mcp Disable all')).toEqual({ action: 'disable', target: 'all' })
  })

  it('leaves other messages alone', () => {
    expect(mcpCommandOf('/mcpx')).toBeNull()
    expect(mcpCommandOf('tell me about /mcp')).toBeNull()
  })
})

describe('commands Delegatto answers itself', () => {
  it('maps the terminal commands that have a screen or action here', () => {
    expect(appCommandOf('/theme')).toEqual({ kind: 'settings', section: 'appearance' })
    expect(appCommandOf('/allowed-tools')).toEqual({ kind: 'settings', section: 'claude' })
    expect(appCommandOf('/config')).toEqual({ kind: 'settings', section: 'claude' })
    expect(appCommandOf('/memory')).toEqual({ kind: 'memory' })
    expect(appCommandOf('/continue')).toEqual({ kind: 'search' })
    expect(appCommandOf('/copy 3')).toEqual({ kind: 'copy', nth: 3 })
    expect(appCommandOf('/plan add tests')).toEqual({ kind: 'plan', text: 'add tests' })
    expect(appCommandOf('/plan open')).toEqual({ kind: 'plan', text: '' })
    expect(appCommandOf('/cost')).toEqual({ kind: 'usage' })
    expect(appCommandOf('/focus off')).toEqual({ kind: 'focus', on: false })
    expect(appCommandOf('/quit')).toEqual({ kind: 'exit' })
    expect(appCommandOf('/color')).toMatchObject({ kind: 'note' })
  })

  it('leaves the rest to Claude Code, including /config with a setting to change', () => {
    expect(appCommandOf('/config autoCompact=false')).toBeNull()
    expect(appCommandOf('/context')).toBeNull()
    expect(appCommandOf('/compact')).toBeNull()
    expect(appCommandOf('hello')).toBeNull()
  })

  it('counts replies back from the latest for /copy', () => {
    const item = (role: 'user' | 'assistant', text: string) => ({ kind: 'text' as const, uuid: text, role, ts: null, model: null, text })
    const items = [item('assistant', 'first'), item('user', 'q'), item('assistant', 'second'), item('assistant', '  ')]
    expect(nthLatestReply(items, 1)).toBe('second')
    expect(nthLatestReply(items, 2)).toBe('first')
    expect(nthLatestReply(items, 3)).toBeNull()
  })
})

describe('/model and /effort with a value', () => {
  it('set the header’s choice, so it lasts past the chat’s process', () => {
    expect(appCommandOf('/model opus')).toEqual({ kind: 'model', value: 'opus' })
    expect(appCommandOf('/model default')).toEqual({ kind: 'model', value: '' })
    expect(appCommandOf('/effort high')).toEqual({ kind: 'effort', value: 'high' })
    expect(appCommandOf('/effort auto')).toEqual({ kind: 'effort', value: '' })
  })
  it('leave the rest to Claude Code: listing, and options only it knows', () => {
    expect(appCommandOf('/model')).toBeNull()
    expect(appCommandOf('/effort')).toBeNull()
    expect(appCommandOf('/effort ultracode on')).toBeNull()
  })
})
