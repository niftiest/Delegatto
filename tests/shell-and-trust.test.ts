import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShellRunner, clipMiddle, shellCommand, shellRunBlocks, type ShellChild } from '../src/main/engine/shell-run'
import { claudeTrusts, folderContents, listTrusts, repoRoot, trustKey } from '../src/main/engine/folder-trust'
import { buildRenderItems } from '../src/main/jsonl/render'
import { textOf } from '../src/main/jsonl/parse'
import type { MessageRow } from '../src/main/jsonl/rows'
import type { ShellRun } from '../src/shared/shell-run-types'
import { imageSourceUrl } from '../src/renderer/lib'
import { SessionPool } from '../src/main/engine/pool'

class FakeShell extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 7
}

function runner(storePath: string | null = null) {
  const shells: FakeShell[] = []
  const killed: number[] = []
  const changes: ShellRun[][] = []
  const finished: string[] = []
  let id = 0
  const r = new ShellRunner({
    storePath,
    start: () => { const s = new FakeShell(); shells.push(s); return s as unknown as ShellChild },
    killTree: pid => { killed.push(pid) },
    onChange: (_pk, runs) => changes.push(runs.map(x => ({ ...x }))),
    onFinished: run => finished.push(run.id),
    makeId: () => `r${++id}`,
    now: () => 1000
  })
  return { r, shells, killed, changes, finished }
}

const run = (over: Partial<ShellRun>): ShellRun => ({ id: 'a', sessionPk: 1, command: 'ls', output: 'a.txt\n', startedAt: 0, state: 'done', exitCode: 0, ...over })

describe('! commands', () => {
  it('keeps output from both streams and reports how it ended', () => {
    const { r, shells } = runner()
    r.run(1, 'C:\\p', 'ls')
    expect(r.list(1)[0]).toMatchObject({ state: 'running', exitCode: null })
    shells[0]!.stdout.emit('data', 'out\n')
    shells[0]!.stderr.emit('data', Buffer.from('err\n'))
    shells[0]!.emit('close', 3)
    expect(r.list(1)[0]).toMatchObject({ state: 'done', exitCode: 3, output: 'out\nerr\n' })
    expect(r.list(2)).toEqual([])
  })

  it('reports a command that could not start', () => {
    const { r, shells } = runner()
    r.run(1, 'C:\\p', 'x')
    shells[0]!.emit('error', new Error('ENOENT'))
    expect(r.list(1)[0]).toMatchObject({ state: 'done', exitCode: null, output: expect.stringContaining('ENOENT') })
  })

  it('stops a run and everything it started', () => {
    const { r, shells, killed } = runner()
    r.run(1, 'C:\\p', 'sleep 100')
    r.stop('r1')
    expect(killed).toEqual([7])
    shells[0]!.emit('close', 1)
    expect(r.list(1)[0]).toMatchObject({ state: 'stopped', exitCode: null })
    r.stop('r1')
    expect(killed).toEqual([7])
  })

  it('announces a command that ran to its end, even a failed one, but not a stopped one', () => {
    const { r, shells, finished } = runner()
    r.run(1, 'C:\\p', 'ok')
    shells[0]!.emit('close', 0)
    r.run(1, 'C:\\p', 'bad')
    shells[1]!.emit('close', 2)
    r.run(1, 'C:\\p', 'long')
    r.stop('r3')
    shells[2]!.emit('close', 1)
    expect(finished).toEqual(['r1', 'r2'])
  })

  it('knows which chats have a command running', () => {
    const { r, shells } = runner()
    r.run(1, 'C:\\p', 'a')
    r.run(1, 'C:\\p', 'b')
    r.run(2, 'C:\\p', 'c')
    expect(r.runningChats().sort()).toEqual([1, 2])
    shells[0]!.emit('close', 0)
    shells[1]!.emit('close', 0)
    expect(r.runningChats()).toEqual([2])
  })

  it('hands over only finished runs, once', () => {
    const { r, shells } = runner()
    r.run(1, 'C:\\p', 'done')
    r.run(1, 'C:\\p', 'still going')
    shells[0]!.emit('close', 0)
    expect(r.takeFinished(1).map(x => x.command)).toEqual(['done'])
    expect(r.takeFinished(1)).toEqual([])
    expect(r.list(1).map(x => x.command)).toEqual(['still going'])
  })

  it('leaves out a dismissed run, stopping it if needed', () => {
    const { r, killed } = runner()
    r.run(1, 'C:\\p', 'x')
    r.dismiss('r1')
    expect(killed).toEqual([7])
    expect(r.list(1)).toEqual([])
    expect(r.takeFinished(1)).toEqual([])
  })

  it('keeps finished runs across a restart, but not running ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-shell-'))
    try {
      const store = join(dir, 'nested', 'runs.json')
      const a = runner(store)
      a.r.run(1, 'C:\\p', 'done')
      a.r.run(1, 'C:\\p', 'going')
      a.shells[0]!.emit('close', 0)
      const b = runner(store)
      expect(b.r.list(1).map(x => x.command)).toEqual(['done'])
      expect(b.r.takeFinished(1)).toHaveLength(1)
      expect(runner(store).r.list(1)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('uses Git Bash when installed, otherwise PowerShell', () => {
    const env = { ProgramFiles: 'C:\\Program Files' }
    const bash = join('C:\\Program Files', 'Git', 'bin', 'bash.exe')
    expect(shellCommand('ls -la', env, p => p === bash)).toEqual({ file: bash, args: ['-c', 'ls -la'] })
    expect(shellCommand('ls', env, () => false).file).toBe('powershell.exe')
    expect(shellCommand('ls', { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\b.exe' }, p => p === 'D:\\b.exe').file).toBe('D:\\b.exe')
  })

  it('clips long output in the middle', () => {
    const out = clipMiddle('a'.repeat(100) + 'b'.repeat(100), 20)
    expect(out.startsWith('aaaaaaaaaa')).toBe(true)
    expect(out.endsWith('bbbbbbbbbb')).toBe(true)
    expect(out).toContain('180 characters left out')
    expect(clipMiddle('short', 20)).toBe('short')
  })

  it('reaches the transcript in the form it already displays', () => {
    const blocks = shellRunBlocks([run({ exitCode: 2, output: 'nope </bash-stdout> tricky\n' })])
    const row = { type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: [...blocks, { type: 'text', text: 'what failed?' }] } } as MessageRow
    expect(buildRenderItems([row]).map(i => i.kind === 'text' ? `${i.role}: ${i.text}` : i.kind)).toEqual([
      'user: !ls',
      'assistant: nope <\\/bash-stdout> tricky\n[exit code 2]',
      'user: what failed?'
    ])
    expect(textOf(row)).toContain('what failed?')
  })

  it('says when the user stopped it', () => {
    expect(JSON.stringify(shellRunBlocks([run({ state: 'stopped', exitCode: null })]))).toContain('stopped by the user')
  })
})

describe('images in chats', () => {
  it('shows stored bitmaps only', () => {
    expect(imageSourceUrl({ type: 'base64', media_type: 'image/png', data: 'AAAA' })).toBe('data:image/png;base64,AAAA')
    expect(imageSourceUrl({ type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' })).toBeNull()
    expect(imageSourceUrl({ type: 'url', url: 'https://x/y.png' })).toBeNull()
    expect(imageSourceUrl({ type: 'base64', media_type: 'image/png', data: '' })).toBeNull()
    expect(imageSourceUrl(null)).toBeNull()
  })
})

describe('folder trust', () => {
  /** A temporary tree: parent/ (plain), parent/plain/deep/, and parent/repo/ (a git
   *  repository) with repo/sub/. Paths use forward slashes, as ~/.claude.json does. */
  function tree() {
    const parent = mkdtempSync(join(tmpdir(), 'cc-trust-')).split('\\').join('/')
    mkdirSync(`${parent}/plain/deep`, { recursive: true })
    mkdirSync(`${parent}/repo/.git`, { recursive: true })
    mkdirSync(`${parent}/repo/sub`, { recursive: true })
    const claudeJson = (...trusted: string[]) => JSON.stringify({ projects: Object.fromEntries(trusted.map(k => [k, { hasTrustDialogAccepted: true }])) })
    return { parent, claudeJson, done: () => rmSync(parent, { recursive: true, force: true }) }
  }

  it("honours Claude Code's own record through a parent folder, outside a repository", () => {
    const t = tree()
    try {
      expect(claudeTrusts(`${t.parent}/plain/deep`, t.claudeJson(t.parent))).toBe(true)
      // Backslashes, a trailing one and different case all name the same folder.
      expect(claudeTrusts(`${t.parent}/plain/deep/`.split('/').join('\\').toUpperCase(), t.claudeJson(t.parent))).toBe(true)
      expect(claudeTrusts(`${t.parent}/plain`, t.claudeJson(`${t.parent}/plain/deep`))).toBe(false)
      expect(claudeTrusts(t.parent, null)).toBe(false)
      expect(claudeTrusts(t.parent, 'not json')).toBe(false)
    } finally { t.done() }
  })

  it('stops at the repository root, as Claude Code does: a trusted parent folder does not cover a new repository', () => {
    const t = tree()
    try {
      expect(claudeTrusts(`${t.parent}/repo/sub`, t.claudeJson(t.parent))).toBe(false)
      expect(claudeTrusts(`${t.parent}/repo/sub`, t.claudeJson(`${t.parent}/repo`))).toBe(true)
      expect(claudeTrusts(`${t.parent}/repo`, t.claudeJson(`${t.parent}/repo/sub`))).toBe(false)
      expect(listTrusts(`${t.parent}/repo/sub`, [t.parent])).toBeNull()
    } finally { t.done() }
  })

  it('keeps trust for the repository root, and finds the answer that covers a folder', () => {
    const t = tree()
    try {
      expect(trustKey(`${t.parent}/repo/sub`)).toBe(`${t.parent}/repo`)
      expect(trustKey(`${t.parent}/plain/deep`)).toBe(`${t.parent}/plain/deep`)
      expect(repoRoot(`${t.parent}/plain`)).toBeNull()
      expect(listTrusts(`${t.parent}/plain/deep`, [t.parent.toUpperCase()])).toBe(t.parent.toUpperCase())
      expect(listTrusts(`${t.parent}/plain`, [`${t.parent}/plain/deep`])).toBeNull()
      expect(listTrusts(`${t.parent}/plainer`, [`${t.parent}/plain`])).toBeNull()
    } finally { t.done() }
  })

  it('names what in the folder would take effect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-trust-'))
    try {
      expect(folderContents(dir)).toEqual({ settings: false, hooks: [], mcpServers: [], instructions: false, extensions: false })
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
      writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }))
      writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [] } }))
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { db: {}, api: {} } }))
      writeFileSync(join(dir, 'CLAUDE.md'), 'x')
      expect(folderContents(dir)).toEqual({ settings: true, hooks: ['PreToolUse', 'Stop'], mcpServers: ['api', 'db'], instructions: true, extensions: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('copes with broken files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-trust-'))
    try {
      writeFileSync(join(dir, '.mcp.json'), '{ broken')
      expect(folderContents(dir).mcpServers).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('telling Claude Code about a folder the user trusted', () => {
  function start(trustToAttest?: (cwd: string) => string | null) {
    const requests: Array<{ subtype: string; body: object }> = []
    const pool = new SessionPool({
      idleReapMs: 100000,
      ...(trustToAttest !== undefined ? { trustToAttest } : {}),
      transportFactory: () => ({
        start() {}, send() {}, on() {}, onExit() {}, interrupt() {}, close() {}, pid: 1,
        request(subtype: string, body: object) { requests.push({ subtype, body }); return Promise.resolve({}) }
      }) as never
    })
    pool.send('k', { cwd: 'D:/work/repo/sub', skipPermissions: false, sessionId: 's' }, { n: 1 })
    return requests.find(r => r.subtype === 'initialize')?.body
  }

  it('says so at startup, naming the folder trust is kept for', () => {
    expect(start(cwd => cwd === 'D:/work/repo/sub' ? 'D:/work/repo' : null))
      .toEqual({ perTaskStopAffordance: true, workspaceTrust: { accepted: true, directory: 'D:/work/repo' } })
  })

  it('says nothing when there is no answer to pass on', () => {
    expect(start(() => null)).toEqual({ perTaskStopAffordance: true })
    expect(start()).toEqual({ perTaskStopAffordance: true })
  })
})
