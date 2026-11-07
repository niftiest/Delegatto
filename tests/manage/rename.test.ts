import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, parse as parsePath } from 'node:path'
import { encodePath } from '../../src/main/manage/paths'
import { scanProjects } from '../../src/main/manage/scanner'
import {
  NEITHER_EXISTS_WARNING, RenameRefusedError, RenameService, SessionsLiveError,
  type ExecuteResult
} from '../../src/main/manage/rename'
import type { LiveSession } from '../../src/main/manage/live'
import { FakeClaudeTree } from './fake-tree'

const trees: FakeClaudeTree[] = []
const locked: string[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => {
  while (locked.length > 0) unlock(locked.pop()!)
  while (trees.length > 0) trees.pop()!.dispose()
})

function service(t: FakeClaudeTree, live: LiveSession[] = []): RenameService {
  return new RenameService(t.paths, () => live)
}
const newDir = (t: FakeClaudeTree, name: string): string => join(t.root, 'work', name)
const projDir = (t: FakeClaudeTree, wd: string): string => join(t.paths.projectsDir, encodePath(wd))
const tempDir = (t: FakeClaudeTree, wd: string): string => join(t.paths.tempClaudeDir, encodePath(wd))
const esc = (p: string): string => p.replace(/\\/g, '\\\\')
const fwd = (p: string): string => p.replace(/\\/g, '/')
const text = (f: string): string => readFileSync(f, 'utf8')
const lines = (f: string): string[] => text(f).split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l.length > 0)
const json = (f: string): Record<string, unknown> => JSON.parse(text(f)) as Record<string, unknown>

/** Node can't open a file exclusively on Windows; a read-only file makes the
 *  atomic replace in rewriteLines fail the same way a locked file would. */
function lock(f: string): void { chmodSync(f, 0o444); locked.push(f) }
function unlock(f: string): void { try { chmodSync(f, 0o666) } catch { /* gone */ } }

function snapshot(root: string): Map<string, Buffer> {
  const m = new Map<string, Buffer>()
  const backups = join('.claude', 'backups').toLowerCase()
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!p.toLowerCase().includes(backups)) m.set(p, readFileSync(p))
    }
  }
  walk(root)
  return m
}
const sortedKeys = (m: Map<string, unknown>): string[] => [...m.keys()].sort()

async function plannedAndRun(t: FakeClaudeTree, oldDir: string, nw: string): Promise<ExecuteResult> {
  const svc = service(t)
  return svc.execute(await svc.plan(oldDir, nw))
}

describe('RenameService', () => {
  it('renames the project dir, temp dir and a nested project', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const sub = t.workDir('Old\\sub')
    writeFileSync(join(sub, 'code.txt'), 'x')
    t.addSession(old, 's1')
    t.addSession(sub, 's2')
    t.addTemp(old)
    t.addTemp(sub)
    // subagent log inside a session subfolder
    const agentDir = join(projDir(t, old), 's1', 'subagents')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'agent-1.jsonl'), `{"cwd":"${esc(sub)}"}\n`)
    const nw = newDir(t, 'New')
    const svc = service(t)

    const plan = await svc.plan(old, nw)
    expect(plan.moveWorkingFolder).toBe(true)
    expect(plan.jsonlFiles).toHaveLength(3)
    expect(plan.dirRenames).toHaveLength(4)

    const r = await svc.execute(plan)

    expect(r.failures).toEqual([])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(nw, 'sub', 'code.txt'))).toBe(true)
    expect(existsSync(projDir(t, old))).toBe(false)
    expect(existsSync(projDir(t, sub))).toBe(false)
    expect(existsSync(tempDir(t, old))).toBe(false)
    expect(existsSync(tempDir(t, sub))).toBe(false)
    const newSub = join(nw, 'sub')
    expect(text(join(projDir(t, nw), 's1.jsonl'))).toContain(esc(nw))
    expect(text(join(projDir(t, newSub), 's2.jsonl'))).toContain(esc(newSub))
    expect(text(join(projDir(t, nw), 's1', 'subagents', 'agent-1.jsonl'))).toContain(esc(newSub))
    expect(existsSync(join(tempDir(t, nw), 'scratch.txt'))).toBe(true)
    expect(existsSync(join(tempDir(t, newSub), 'scratch.txt'))).toBe(true)
  })

  it('rewrites references in other projects, keeping CRLF endings and untouched lines', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const parent = join(t.root, 'work')
    t.addSession(old, 's1')
    const untouched = '{"type":"assistant","text":"nothing"}'
    const first = JSON.stringify({ type: 'user', cwd: parent, sessionId: 'p1' })
    const file = t.addSessionRaw(parent, 'p1')
    writeFileSync(file, [first, `{"type":"user","cwd":"${esc(old)}","msg":"cd ${fwd(old)}"}`, untouched].map(l => l + '\r\n').join(''))
    const crBefore = readFileSync(file).filter(b => b === 13).length
    const nw = newDir(t, 'New')
    const svc = service(t)

    const plan = await svc.plan(old, nw)
    expect(plan.jsonlFiles.map(f => f.toLowerCase())).toContain(file.toLowerCase())
    expect(plan.dirRenames.some(d => d.from.toLowerCase() === projDir(t, parent).toLowerCase())).toBe(false)
    const r = await svc.execute(plan)

    expect(r.failures).toEqual([])
    const after = lines(file)
    expect(after[0]).toBe(first) // the parent's own cwd line
    expect(after[1]).toBe(`{"type":"user","cwd":"${esc(nw)}","msg":"cd ${fwd(nw)}"}`)
    expect(after).toHaveLength(3)
    expect(after[2]).toBe(untouched)
    expect(readFileSync(file).filter(b => b === 13).length).toBe(crBefore) // CRLF endings kept
    expect(existsSync(projDir(t, parent))).toBe(true)
  })

  it('preserves the transcript mtime', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const f = t.addSession(old, 's1')
    const mtime = new Date(Date.UTC(2020, 0, 2, 3, 4, 5))
    utimesSync(f, mtime, mtime)
    const nw = newDir(t, 'New')

    const r = await plannedAndRun(t, old, nw)

    expect(r.failures).toEqual([])
    const moved = join(projDir(t, nw), 's1.jsonl')
    expect(text(moved)).toContain(esc(nw))
    expect(statSync(moved).mtimeMs).toBe(mtime.getTime())
  })

  it('leaves a sibling .com untouched', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const com = t.workDir('Old.com')
    t.addSession(old, 's1', `{"see":"${esc(com)}"}`)
    t.addSession(com, 's2')
    t.addTemp(com)
    t.addClaudeJsonProject(com)
    t.addHistory(com, 's2', 'hi')
    t.addJob('j2', 's2', com)
    const comFiles = [...snapshot(t.root)].filter(([k]) =>
      k.toLowerCase().includes('old.com') || k.toLowerCase().includes(encodePath(com).toLowerCase()))
    const nw = newDir(t, 'New')
    const svc = service(t)

    const plan = await svc.plan(old, nw)
    expect(plan.claudeJsonKeys).toBe(0)
    expect(plan.historyLines).toBe(0)
    expect(plan.jobFiles).toEqual([])
    const r = await svc.execute(plan)

    expect(r.failures).toEqual([])
    expect(comFiles.length).toBeGreaterThan(0)
    for (const [path, bytes] of comFiles) expect(readFileSync(path).equals(bytes)).toBe(true)
    expect(existsSync(com)).toBe(true)
    expect(lines(join(projDir(t, nw), 's1.jsonl'))[1]).toBe(`{"see":"${esc(com)}"}`)
    expect(Object.keys(json(t.paths.claudeJson).projects as object)).toEqual([com])
  })

  it('refuses if the target exists', async () => {
    const t = tree()
    const old = t.workDir('Old')
    t.addSession(old, 's1')
    const existing = t.workDir('Taken')
    const svc = service(t)
    const before = snapshot(t.root)

    await expect(svc.plan(old, existing)).rejects.toThrow(RenameRefusedError)
    await expect(svc.plan(old, join(old, 'inner'))).rejects.toThrow(RenameRefusedError)
    await expect(svc.plan(old, old)).rejects.toThrow(RenameRefusedError)

    // working folder target is free, but the encoded project folder for it already exists
    const nw = newDir(t, 'New')
    mkdirSync(projDir(t, nw), { recursive: true })
    await expect(svc.plan(old, nw)).rejects.toThrow(RenameRefusedError)

    expect(sortedKeys(snapshot(t.root))).toEqual(sortedKeys(before))
    expect(existsSync(old)).toBe(true)
  })

  it('refuses when any session is live, before changing anything', async () => {
    const t = tree()
    const old = t.workDir('Old')
    t.addSession(old, 's1')
    t.addClaudeJsonProject(old)
    t.addHistory(old, 's1', 'hi')
    const plan = await service(t).plan(old, newDir(t, 'New'))
    const before = snapshot(t.root)

    const live: LiveSession[] = [{ pid: 4242, sessionId: 'other', cwd: 'C:\\elsewhere', name: 't', procStart: null }]
    const err = await service(t, live).execute(plan).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SessionsLiveError)
    expect((err as SessionsLiveError).sessions).toEqual(live)

    const after = snapshot(t.root)
    expect(sortedKeys(after)).toEqual(sortedKeys(before))
    for (const [k, v] of before) expect(after.get(k)!.equals(v)).toBe(true)
    expect(existsSync(t.paths.backupsDir)).toBe(false)
    expect(existsSync(old)).toBe(true)
  })

  it('re-keys .claude.json and rewrites history and job state', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const sub = join(old, 'sub')
    const com = t.workDir('Old.com')
    t.addClaudeJsonProject(com)
    t.addClaudeJsonProject(fwd(old))
    t.addClaudeJsonProject(sub)
    t.addGithubRepoPath('o/old', old)
    t.addGithubRepoPath('o/old', com)
    t.addHistory(old, 's1', 'first')
    t.addHistory(com, 's2', 'dotcom')
    t.addHistory(sub, 's3', `look at ${old}\\x`)
    t.addSession(old, 's1')
    t.addJob('j1', 's1', old)
    const historyBefore = lines(t.paths.historyFile)
    const nw = newDir(t, 'New')
    const newSub = join(nw, 'sub')
    const svc = service(t)

    const plan = await svc.plan(old, nw)
    expect(plan.claudeJsonKeys).toBe(2)
    expect(plan.historyLines).toBe(2)
    expect(plan.jobFiles).toHaveLength(1)
    const r = await svc.execute(plan)

    expect(r.failures).toEqual([])
    expect(r.backupDir).not.toBeNull()
    expect(existsSync(join(r.backupDir!, '.claude.json'))).toBe(true)
    expect(existsSync(join(r.backupDir!, 'history.jsonl'))).toBe(true)

    const raw = text(t.paths.claudeJson)
    expect(raw).not.toContain('\r\n')
    const cj = JSON.parse(raw) as { projects: object; githubRepoPaths: Record<string, string[]> }
    expect(Object.keys(cj.projects)).toEqual([com, fwd(nw), newSub])
    expect(cj.githubRepoPaths['o/old']).toEqual([nw, com])

    const history = lines(t.paths.historyFile)
    expect((JSON.parse(history[0]!) as { project: string }).project).toBe(nw)
    expect(history[1]).toBe(historyBefore[1])
    expect((JSON.parse(history[2]!) as { project: string }).project).toBe(newSub)
    expect((JSON.parse(history[2]!) as { display: string }).display).toBe(`look at ${nw}\\x`)

    const state = json(join(t.paths.jobsDir, 'j1', 'state.json'))
    expect(state.cwd).toBe(nw)
    expect(state.linkScanPath).toBe(join(projDir(t, nw), 's1.jsonl'))
  })

  it('renames temp dirs of .claude.json-only and history-only projects', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const a = join(old, 'a')
    const b = join(old, 'b')
    t.addClaudeJsonProject(a)
    t.addHistory(b, 's1', 'x')
    t.addTemp(a)
    t.addTemp(b)
    const nw = newDir(t, 'New')

    const r = await plannedAndRun(t, old, nw)

    expect(r.failures).toEqual([])
    expect(existsSync(tempDir(t, join(nw, 'a')))).toBe(true)
    expect(existsSync(tempDir(t, join(nw, 'b')))).toBe(true)
  })

  it('stops at the first failure and reports what was done so far', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const f = t.addSession(old, 's1')
    t.addHistory(old, 's1', 'hi')
    const historyBefore = readFileSync(t.paths.historyFile)
    const nw = newDir(t, 'New')
    const svc = service(t)
    const plan = await svc.plan(old, nw)

    lock(f)
    const r = await svc.execute(plan)

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]!.path.toLowerCase()).toBe(f.toLowerCase())
    expect(r.failures[0]!.error.length).toBeGreaterThan(0)
    expect(r.done).toContain(`Moved ${old} → ${nw}`) // working folder was moved
    expect(existsSync(nw)).toBe(true)
    expect(existsSync(projDir(t, old))).toBe(true) // later steps not run
    expect(readFileSync(t.paths.historyFile).equals(historyBefore)).toBe(true)
  })

  it('a missing working folder still gets its references rewritten', async () => {
    const t = tree()
    const old = join(t.root, 'work', 'Gone')
    t.addSession(old, 's1')
    const nw = newDir(t, 'New')
    const svc = service(t)

    const plan = await svc.plan(old, nw)
    expect(plan.moveWorkingFolder).toBe(false)
    const r = await svc.execute(plan)

    expect(r.failures).toEqual([])
    expect(existsSync(nw)).toBe(false)
    expect(text(join(projDir(t, nw), 's1.jsonl'))).toContain(esc(nw))
  })

  it('leaves siblings with a space or parens untouched', async () => {
    const t = tree()
    const old = t.workDir('Old')
    const stuff = t.workDir('Old Stuff')
    const copy = join(t.root, 'work', 'Old (copy)') // known only from history
    const parent = join(t.root, 'work')
    t.addSession(old, 's1', `{"see":"${esc(stuff)}\\\\x"}`)
    t.addSession(stuff, 's2', `{"see":"${esc(copy)}"}`)
    t.addTemp(stuff)
    t.addClaudeJsonProject(stuff)
    t.addClaudeJsonProject(old)
    t.addHistory(stuff, 's2', 'hi')
    t.addHistory(copy, 's3', `cd ${copy}`)
    t.addHistory(old, 's1', 'mine')
    t.addHistory(parent, 's4', `look in ${old}\\a`)
    const stuffFiles = [...snapshot(t.root)].filter(([k]) =>
      k.toLowerCase().includes('old stuff') || k.toLowerCase().includes(encodePath(stuff).toLowerCase()))
    const historyBefore = lines(t.paths.historyFile)
    const nw = newDir(t, 'New')
    const svc = service(t)

    const plan = await svc.plan(old, nw)
    expect(plan.historyLines).toBe(2) // own project line + the line that mentions old in its text
    expect(plan.claudeJsonKeys).toBe(1)
    expect(plan.jsonlFiles.some(f => f.toLowerCase().includes(encodePath(stuff).toLowerCase()))).toBe(false)
    const r = await svc.execute(plan)

    expect(r.failures).toEqual([])
    expect(stuffFiles).toHaveLength(2) // its session log and temp scratch file
    for (const [path, bytes] of stuffFiles) expect(readFileSync(path).equals(bytes)).toBe(true)
    expect(existsSync(stuff)).toBe(true)
    expect(lines(join(projDir(t, nw), 's1.jsonl'))[1]).toBe(`{"see":"${esc(stuff)}\\\\x"}`)
    const history = lines(t.paths.historyFile)
    expect(history[0]).toBe(historyBefore[0])
    expect(history[1]).toBe(historyBefore[1])
    expect((JSON.parse(history[2]!) as { project: string }).project).toBe(nw)
    expect((JSON.parse(history[3]!) as { display: string }).display).toBe(`look in ${nw}\\a`)
    expect(Object.keys(json(t.paths.claudeJson).projects as object)).toEqual([stuff, nw])
  })

  it('refuses a project folder shared through the lossy encoding', async () => {
    const t = tree()
    const app = t.workDir('App')
    const server = join(app, 'server')
    const sibling = t.workDir('App-server')
    expect(encodePath(server)).toBe(encodePath(sibling))
    t.addSession(server, 's1')
    t.addSession(sibling, 's2') // lands in the same projects folder
    const before = snapshot(t.root)

    const err = await service(t).plan(app, newDir(t, 'App2')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RenameRefusedError)
    expect((err as Error).message.toLowerCase()).toContain(projDir(t, sibling).toLowerCase())
    expect(sortedKeys(snapshot(t.root))).toEqual(sortedKeys(before))
  })

  it('refuses a temp folder shared through the lossy encoding', async () => {
    const t = tree()
    const app = t.workDir('App')
    const server = join(app, 'server')
    const sibling = t.workDir('App-server')
    t.addClaudeJsonProject(server)
    t.addClaudeJsonProject(sibling)
    t.addTemp(server) // same folder name as the sibling's temp folder

    await expect(service(t).plan(app, newDir(t, 'App2'))).rejects.toThrow(RenameRefusedError)
  })

  it("refuses when Claude's data is inside the old dir", async () => {
    const t = tree()
    const outside = join(parsePath(t.root).dir, 'cc-new-' + Math.random().toString(36).slice(2))
    await expect(service(t).plan(t.root, outside)).rejects.toThrow(RenameRefusedError)
    expect(existsSync(outside)).toBe(false)
  })

  function populateForResume(t: FakeClaudeTree): { old: string; nw: string } {
    const old = t.workDir('Old')
    writeFileSync(join(old, 'code.txt'), 'x')
    t.addSession(old, 's1', `{"msg":"cd ${fwd(old)}"}`)
    t.addSession(old, 's2')
    t.addTemp(old)
    t.addClaudeJsonProject(old)
    t.addGithubRepoPath('o/old', old)
    t.addHistory(old, 's1', 'hi')
    t.addJob('j1', 's1', old)
    return { old, nw: newDir(t, 'New') }
  }

  function canonical(t: FakeClaudeTree): Map<string, string> {
    const c = (s: string): string => s.split(esc(t.root)).join('ROOT').split(t.root).join('ROOT')
      .split(fwd(t.root)).join('ROOT').split(encodePath(t.root)).join('ENCROOT')
    const m = new Map<string, string>()
    for (const [k, v] of snapshot(t.root)) m.set(c(k), c(v.toString('utf8')))
    return m
  }

  it('resumes after a failure that followed the move', async () => {
    const clean = tree()
    const c = populateForResume(clean)
    expect((await plannedAndRun(clean, c.old, c.nw)).failures).toEqual([])

    const t = tree()
    const { old, nw } = populateForResume(t)
    const svc = service(t)
    const first = await svc.plan(old, nw)
    const lockedFile = join(projDir(t, old), 's2.jsonl')
    lock(lockedFile)
    const r1 = await svc.execute(first)
    unlock(lockedFile)
    expect(r1.failures).toHaveLength(1)
    expect(r1.done).toContain(`Moved ${old} → ${nw}`)

    // second run picks up where the first stopped
    const second = await svc.plan(old, nw)
    expect(second.moveWorkingFolder).toBe(false)
    const r2 = await svc.execute(second)

    expect(r2.failures).toEqual([])
    expect(r2.done.some(d => d.startsWith('Moved'))).toBe(false)
    const expected = canonical(clean)
    const actual = canonical(t)
    expect(sortedKeys(actual)).toEqual(sortedKeys(expected))
    for (const [k, v] of expected) expect(actual.get(k)).toBe(v)
  })

  const badTargets = [
    'Foo', // relative
    'GIT\\x', // relative
    '|DRIVE|GIT\\x', // drive-relative, e.g. D:GIT\x
    '|ROOT|\\a|b',
    '|ROOT|\\a?b',
    '|ROOT|\\a*b',
    '|ROOT|\\a<b',
    '|ROOT|\\a>b',
    '|ROOT|\\a"b',
    '|ROOT|\\a:b',
    '|ROOT|\\..\\x',
    '|ROOT|\\.\\x',
    '|ROOT|\\a\\\\b', // empty segment
    '|DRIVE|\\', // drive root
    '|DRIVE|',
    '|DRIVE|/',
    '|ROOT|\\a\u0001b' // control char
  ]

  it.each(badTargets)('refuses the malformed target %s even when the old folder is missing', async target => {
    const t = tree()
    const old = newDir(t, 'Gone') // not on disk: nothing to move, so only the path checks guard the rewrite
    t.addSession(old, 's1')
    t.addClaudeJsonProject(old)
    const nd = target.replace('|DRIVE|', parsePath(t.root).root.slice(0, 2)).replace('|ROOT|', join(t.root, 'work'))
    const before = snapshot(t.root)

    await expect(service(t).plan(old, nd)).rejects.toThrow(RenameRefusedError)

    expect(sortedKeys(snapshot(t.root))).toEqual(sortedKeys(before))
  })

  it('refuses a relative old path', async () => {
    const t = tree()
    await expect(service(t).plan('Gone', newDir(t, 'New'))).rejects.toThrow(RenameRefusedError)
  })

  it('warns when neither folder exists', async () => {
    const t = tree()
    const old = newDir(t, 'Gone')
    const nw = newDir(t, 'AlsoGone')
    t.addSession(old, 's1')
    const plan = await service(t).plan(old, nw)
    expect(plan.moveWorkingFolder).toBe(false)
    expect(plan.warning).toBe(NEITHER_EXISTS_WARNING)
    expect(plan.warning).toBe("Neither folder exists on disk — only Claude's references will be repointed.")
  })

  it('no warning when a folder exists', async () => {
    const t = tree()
    const old = t.workDir('Old')
    t.addSession(old, 's1')
    expect((await service(t).plan(old, newDir(t, 'New'))).warning).toBeNull()

    // Resume: old already moved to new.
    const gone = newDir(t, 'Gone')
    const there = t.workDir('There')
    t.addSession(gone, 's2')
    expect((await service(t).plan(gone, there)).warning).toBeNull()
  })

  it('accepts async live-session sources', async () => {
    const t = tree()
    const old = t.workDir('Old')
    t.addSession(old, 's1')
    const svc = new RenameService(t.paths, async () => [])
    expect((await svc.execute(await svc.plan(old, newDir(t, 'New')))).failures).toEqual([])
  })

  // Regression: scanner.ts firstCwd() used to leave the transcript's read stream (and its
  // Windows handle) open after an early return, so rewriteLines' atomic replace failed (EPERM).
  it('works right after scanProjects in the same process', async () => {
    const t = tree()
    const old = t.workDir('Old')
    t.addSession(old, 's1')
    await scanProjects(t.paths)
    expect((await plannedAndRun(t, old, newDir(t, 'New'))).failures).toEqual([])
  })
})
