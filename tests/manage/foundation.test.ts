import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, parse as parsePath } from 'node:path'
import { encodePath, isSamePath, isSameOrUnder, pathsFor, replacePrefix, normalizePath } from '../../src/main/manage/paths'
import { scanProjects } from '../../src/main/manage/scanner'
import { collectProjectArtifacts, collectChatArtifacts } from '../../src/main/manage/artifacts'
import { backupClaudeState, rewriteLines, appendLines, mapLines } from '../../src/main/manage/safe-file'
import { loadClaudeJson, saveClaudeJson, hasUnsafeNumber, ClaudeJsonError } from '../../src/main/manage/claude-json'
import type { ClaudePaths } from '../../src/main/manage/paths'
import type { ProjectInfo } from '../../src/main/manage/types'
import { FakeClaudeTree } from './fake-tree'

let t: FakeClaudeTree
const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

describe('paths', () => {
  it.each([
    ['D:\\GIT\\X.com', 'D--GIT-X-com'],
    ['C:\\Program Files\\EffectCraft', 'C--Program-Files-EffectCraft'],
    ['D:\\GIT', 'D--GIT']
  ])('encodes %s like Claude', (dir, enc) => expect(encodePath(dir)).toBe(enc))

  it.each([
    ['D:\\GIT\\X', 'D:\\GIT\\X', true],
    ['d:/git/x/sub', 'D:\\GIT\\X', true],
    ['/d/GIT/X/server', 'D:\\GIT\\X', true],
    ['D:\\GIT\\X.com', 'D:\\GIT\\X', false],
    ['D:\\GIT\\XY', 'D:\\GIT\\X', false],
    ['D:\\GIT', 'D:\\GIT\\X', false]
  ])('isSameOrUnder(%s, %s) = %s', (c, r, want) => expect(isSameOrUnder(c, r)).toBe(want))

  it('isSamePath ignores case and slashes', () => expect(isSamePath('d:/git/x/', 'D:\\GIT\\X')).toBe(true))
  it('replacePrefix keeps the tail', () =>
    expect(replacePrefix('D:\\GIT\\Old\\client\\src', 'D:\\GIT\\Old', 'D:\\GIT\\New')).toBe('D:\\GIT\\New\\client\\src'))
  it('normalize keeps a drive root', () => expect(normalizePath('D:')).toBe('D:\\'))
  it('pathsFor builds the layout', () => {
    const p = pathsFor('C:\\r')
    expect(p.claudeDir).toBe('C:\\r\\.claude')
    expect(p.claudeJson).toBe('C:\\r\\.claude.json')
    expect(p.tempClaudeDir).toBe('C:\\r\\temp\\claude')
    expect(p.backupsDir).toBe('C:\\r\\.claude\\backups\\memory-tool')
  })
})

describe('scanProjects', () => {
  it('lists a project with its real cwd', async () => {
    tree().addSession('D:\\GIT\\X.com', 's1')
    const [p, ...rest] = await scanProjects(t.paths)
    expect(rest).toEqual([])
    expect(p!.workingDir).toBe('D:\\GIT\\X.com')
    expect(p!.workingDirKnown).toBe(true)
    expect(p!.sessionIds).toEqual(['s1'])
    expect(p!.sizeBytes).toBeGreaterThan(0)
    expect(p!.lastUsed).not.toBeNull()
    expect(p!.encodedName).toBe('D--GIT-X-com')
  })

  it('a subfolder cwd does not become the working dir', async () => {
    tree().addSessionRaw('D:\\GIT\\X', 's1',
      JSON.stringify({ type: 'user', cwd: 'D:\\GIT\\X\\server' }), JSON.stringify({ type: 'user', cwd: 'D:\\GIT\\X' }))
    expect((await scanProjects(t.paths))[0]!.workingDir).toBe('D:\\GIT\\X')
  })

  it('falls back to the .claude.json key, else unknown', async () => {
    tree().addSessionRaw('D:\\GIT\\X', 's1', '{"type":"mode"}')
    let p = (await scanProjects(t.paths))[0]!
    expect(p.workingDirKnown).toBe(false)
    expect(p.workingDir).toBe('D--GIT-X')
    t.addClaudeJsonProject('D:\\GIT\\X')
    p = (await scanProjects(t.paths))[0]!
    expect(p.workingDirKnown).toBe(true)
    expect(p.workingDir).toBe('D:\\GIT\\X')
  })

  it('skips malformed lines', async () => {
    tree().addSessionRaw('D:\\GIT\\X', 's1', '{"type":"us', JSON.stringify({ type: 'user', cwd: 'D:\\GIT\\X' }))
    expect((await scanProjects(t.paths))[0]!.workingDir).toBe('D:\\GIT\\X')
  })

  it('lists a .claude.json-only project, merging case variants', async () => {
    tree().addClaudeJsonProject('D:\\GIT\\Y')
    t.addSession('D:\\GIT\\X', 's1'); t.addClaudeJsonProject('d:/git/x')
    const ps = await scanProjects(t.paths)
    expect(ps.map(p => p.workingDir)).toEqual(['D:\\GIT\\X', 'D:\\GIT\\Y'])
    const y = ps[1]!
    expect(y.projectDir).toBeNull()
    expect(y.sessionIds).toEqual([])
    expect(y.lastUsed).toBeNull()
  })

  it('exists reflects the real directory', async () => {
    const w = tree().workDir('proj')
    t.addSession(w, 's1'); t.addSession(join(t.root, 'gone'), 's2')
    const ps = await scanProjects(t.paths)
    expect(ps.find(p => p.workingDir === w)!.exists).toBe(true)
    expect(ps.find(p => p.workingDir !== w)!.exists).toBe(false)
  })

  it('records a worktree parent', async () => {
    const wt = 'D:\\GIT\\X\\.claude\\worktrees\\feat'
    tree().addSessionRaw(wt, 's1', JSON.stringify({ type: 'user', cwd: wt }), JSON.stringify({ type: 'user', cwd: 'D:\\GIT\\X' }))
    const p = (await scanProjects(t.paths))[0]!
    expect(p.workingDir).toBe(wt)
    expect(p.worktreeOf).toBe('D:\\GIT\\X')
  })

  it('skips empty and relative .claude.json keys', async () => {
    const good = tree().workDir('Good')
    const drive = parsePath(t.root).root.slice(0, 2)
    for (const k of ['', '   ', 'Foo', 'GIT\\x', drive + 'foo', good]) t.addClaudeJsonProject(k)
    expect((await scanProjects(t.paths)).map(p => p.workingDir)).toEqual([good])
  })
})

function info(wd: string, ...ids: string[]): ProjectInfo {
  return {
    workingDir: wd, workingDirKnown: true, encodedName: encodePath(wd),
    projectDir: join(t.paths.projectsDir, encodePath(wd)), sessionIds: ids,
    lastUsed: null, sizeBytes: 0, exists: true, worktreeOf: null
  }
}

function populate(wd: string, sid: string, job: string): void {
  t.addSession(wd, sid)
  t.addMemory(wd, 'm.md', 'mem')
  t.addClaudeJsonProject(wd)
  t.addGithubRepoPath('o/' + wd.split('\\').pop(), wd)
  t.addHistory(wd, sid, 'hi')
  t.addTemp(wd)
  for (const k of ['file-history', 'session-env', 'tasks', 'uploads']) t.addSessionDir(k, sid)
  t.addJob(job, sid, wd)
}

describe('collectProjectArtifacts', () => {
  it('collects every kind', async () => {
    const wd = tree().workDir('X')
    populate(wd, 's1', 'j1')
    t.addInDirItems(wd)
    const a = await collectProjectArtifacts(t.paths, info(wd, 's1'))
    expect(new Set(a.map(x => x.kind))).toEqual(new Set([
      'ProjectFolder', 'Memory', 'ClaudeJsonEntry', 'GithubRepoPath', 'HistoryLines', 'TempScratch',
      'FileHistory', 'SessionEnv', 'Tasks', 'Uploads', 'Job', 'InDirClaudeFolder', 'InDirClaudeMd'
    ]))
    for (const x of a.filter(x => ['ProjectFolder', 'Memory', 'TempScratch'].includes(x.kind) && x.parent === undefined)) {
      expect(x.sizeBytes).toBeGreaterThan(0)
    }
  })

  it('collects todos by session prefix', async () => {
    const wd = tree().workDir('X')
    t.addSession(wd, 's1')
    const todo = t.addTodo('s1'); t.addTodo('s2')
    const a = await collectProjectArtifacts(t.paths, info(wd, 's1'))
    expect(a.filter(x => x.kind === 'Todos').map(x => x.path)).toEqual([todo])
  })

  it('never collects a sibling X.com', async () => {
    const x = tree().workDir('X'); const xc = t.workDir('X.com')
    populate(x, 's1', 'j1'); populate(xc, 's2', 'j2')
    const a = await collectProjectArtifacts(t.paths, info(x, 's1'))
    expect(a.some(i => i.path.includes('s2') || i.path.includes('j2') || i.path.includes(encodePath(xc)) || i.description.includes('X.com'))).toBe(false)
    expect(a.find(i => i.kind === 'HistoryLines')!.description).toBe('1 lines')
    expect(a.filter(i => i.kind === 'ClaudeJsonEntry')).toHaveLength(1)
    expect(a.filter(i => i.kind === 'GithubRepoPath')).toHaveLength(1)
  })

  it('in-dir items are optional; everything else is not', async () => {
    const wd = tree().workDir('X')
    t.addSession(wd, 's1')
    expect((await collectProjectArtifacts(t.paths, info(wd, 's1'))).some(i => i.optional)).toBe(false)
    t.addInDirItems(wd)
    const a = await collectProjectArtifacts(t.paths, info(wd, 's1'))
    for (const i of a) expect(i.optional).toBe(i.kind === 'InDirClaudeFolder' || i.kind === 'InDirClaudeMd')
  })

  it('malformed json does not throw', async () => {
    const wd = tree().workDir('X')
    t.addSession(wd, 's1')
    writeFileSync(t.paths.historyFile, 'garbage\n{bad\n')
    writeFileSync(t.paths.claudeJson, '{not json')
    mkdirSync(join(t.paths.jobsDir, 'j'), { recursive: true })
    writeFileSync(join(t.paths.jobsDir, 'j', 'state.json'), '{{')
    const a = await collectProjectArtifacts(t.paths, info(wd, 's1'))
    expect(a.map(i => i.kind)).toEqual(['ProjectFolder'])
  })

  it('a home-folder project never offers Claude data as its own', async () => {
    const home = tree().workDir('home')
    const paths: ClaudePaths = { ...t.paths, claudeDir: join(home, '.claude') }
    mkdirSync(paths.claudeDir, { recursive: true })
    writeFileSync(join(paths.claudeDir, 'CLAUDE.md'), '# global')
    writeFileSync(join(home, 'CLAUDE.md'), '# home project')
    const a = await collectProjectArtifacts(paths, info(home))
    expect(a.some(i => i.kind === 'InDirClaudeFolder')).toBe(false)
    expect(a.some(i => isSameOrUnder(i.path, paths.claudeDir))).toBe(false)
    expect(a.find(i => i.kind === 'InDirClaudeMd')!.path).toBe(join(home, 'CLAUDE.md'))
  })

  it('warns about git worktrees inside .claude', async () => {
    const wd = tree().workDir('X')
    for (const name of ['agent-1', 'agent-2']) {
      const d = join(wd, '.claude', 'worktrees', name)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'big.bin'), Buffer.alloc(1536 * 1024))
    }
    const a = (await collectProjectArtifacts(t.paths, info(wd))).find(i => i.kind === 'InDirClaudeFolder')!
    expect(a.optional).toBe(true)
    expect(a.description).toContain('contains 2 git worktrees (3 MB)')
    expect(a.description).toContain('deleting breaks them')
  })

  it('lists memory files as display-only children', async () => {
    const wd = tree().workDir('X')
    t.addSession(wd, 's1'); t.addMemory(wd, 'b.md', 'b'); t.addMemory(wd, 'a.md', 'a')
    const kids = (await collectProjectArtifacts(t.paths, info(wd, 's1'))).filter(i => i.parent !== undefined)
    expect(kids.map(k => k.description)).toEqual(['Memory file a.md', 'Memory file b.md'])
  })
})

describe('collectChatArtifacts', () => {
  it("collects only that chat's own data", async () => {
    const wd = tree().workDir('X')
    populate(wd, 's1', 'j1')
    t.addSession(wd, 's2'); t.addSessionDir('tasks', 's2'); t.addHistory(wd, 's2', 'other')
    mkdirSync(join(t.paths.projectsDir, encodePath(wd), 's1', 'subagents'), { recursive: true })
    t.addTodo('s1')
    const a = await collectChatArtifacts(t.paths, join(t.paths.projectsDir, encodePath(wd)), 's1')
    expect(new Set(a.map(x => x.kind))).toEqual(new Set([
      'SessionTranscript', 'SessionFolder', 'FileHistory', 'SessionEnv', 'Tasks', 'Uploads', 'Todos', 'Job', 'HistoryLines'
    ]))
    expect(a.some(x => x.path.includes('s2'))).toBe(false)
    expect(a.find(x => x.kind === 'HistoryLines')!.description).toBe('1 lines')
  })
})

describe('safe-file', () => {
  it('backs up .claude.json and history.jsonl into a fresh stamped folder', () => {
    tree().addHistory('D:\\X', 's', 'hi')
    const a = backupClaudeState(t.paths)
    const b = backupClaudeState(t.paths)
    expect(a).not.toBe(b)
    expect(readdirSync(a).sort()).toEqual(['.claude.json', 'history.jsonl'])
  })

  it('rewriteLines drops/changes lines, keeps others byte-for-byte, preserves mtime', () => {
    const f = join(tree().root, 'f.jsonl')
    writeFileSync(f, 'keep \u00e9\nDROP\nchange\nlast-no-newline')
    const old = new Date(2020, 0, 1)
    utimesSync(f, old, old)
    const changed = rewriteLines(f, l => l === 'DROP' ? null : l === 'change' ? 'changed' : l, true)
    expect(changed).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('keep \u00e9\nchanged\nlast-no-newline')
    expect(statSync(f).mtime.getTime()).toBe(old.getTime())
  })

  it('rewriteLines is a no-op when nothing changes, and strips a BOM', () => {
    const f = join(tree().root, 'f.jsonl')
    writeFileSync(f, 'a\nb\n')
    expect(rewriteLines(f, l => l, false)).toBe(false)
    expect(mapLines(Buffer.from('\uFEFFa\n', 'utf8'), l => l)!.toString('utf8')).toBe('a\n')
  })

  it('appendLines adds a missing newline first', () => {
    const f = join(tree().root, 'h.jsonl')
    writeFileSync(f, 'one')
    appendLines(f, ['two', 'three'])
    expect(readFileSync(f, 'utf8')).toBe('one\ntwo\nthree\n')
    appendLines(join(t.root, 'new.jsonl'), ['x'])
    expect(readFileSync(join(t.root, 'new.jsonl'), 'utf8')).toBe('x\n')
  })
})

describe('claude-json', () => {
  it('round-trips in Claude style, keeping non-ASCII and the trailing newline', () => {
    const f = join(tree().root, 'c.json')
    writeFileSync(f, '{"a":"caf\u00e9","n":1.5,"o":{"x":[1,2]}}\n')
    const j = loadClaudeJson(f)
    delete (j.root as { a?: unknown }).a
    saveClaudeJson(f, j)
    expect(readFileSync(f, 'utf8')).toBe('{\n  "n": 1.5,\n  "o": {\n    "x": [\n      1,\n      2\n    ]\n  }\n}\n')
  })

  it('refuses invalid UTF-8, non-objects, and numbers that would lose precision', () => {
    const f = join(tree().root, 'c.json')
    writeFileSync(f, Buffer.from([0x7b, 0xff, 0x7d]))
    expect(() => loadClaudeJson(f)).toThrow(ClaudeJsonError)
    writeFileSync(f, '[1]')
    expect(() => loadClaudeJson(f)).toThrow(ClaudeJsonError)
    writeFileSync(f, '{"id":12345678901234567890}')
    expect(() => loadClaudeJson(f)).toThrow(/too large/)
  })

  it('hasUnsafeNumber ignores strings and exact values', () => {
    expect(hasUnsafeNumber('{"s":"12345678901234567890","t":1762917016684,"f":0.30000000000000004}')).toBe(false)
    expect(hasUnsafeNumber('{"x":9007199254740993}')).toBe(true)
  })
})
