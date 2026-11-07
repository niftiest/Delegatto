import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { encodePath } from '../../src/main/manage/paths'
import type { Artifact, FileRemover, ProjectInfo } from '../../src/main/manage/types'
import { permanentRemover } from '../../src/main/manage/fs-util'
import { collectProjectArtifacts } from '../../src/main/manage/artifacts'
import { backupClaudeState } from '../../src/main/manage/safe-file'
import { scanProjects } from '../../src/main/manage/scanner'
import { getLiveSessions } from '../../src/main/manage/live'
import {
  DeleteService, SessionsLiveError, containingProjectFolder, sharedFolderOwners, isSharedFileEdit
} from '../../src/main/manage/delete'
import { FakeClaudeTree } from './fake-tree'

const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

function info(t: FakeClaudeTree, wd: string, ...ids: string[]): ProjectInfo {
  return {
    workingDir: wd, workingDirKnown: true, encodedName: encodePath(wd),
    projectDir: join(t.paths.projectsDir, encodePath(wd)), sessionIds: ids,
    lastUsed: null, sizeBytes: 0, exists: true, worktreeOf: null
  }
}

function populate(t: FakeClaudeTree, wd: string, sid: string, job: string): void {
  t.addSession(wd, sid)
  t.addMemory(wd, 'm.md', 'mem')
  t.addClaudeJsonProject(wd)
  t.addGithubRepoPath('o/' + basename(wd), wd)
  t.addHistory(wd, sid, 'hi')
  t.addTemp(wd)
  for (const k of ['file-history', 'session-env', 'tasks', 'uploads']) t.addSessionDir(k, sid)
  t.addJob(job, sid, wd)
  t.addTodo(sid)
  t.addInDirItems(wd)
}

function service(t: FakeClaudeTree, alive = false, remover: FileRemover = permanentRemover): DeleteService {
  return new DeleteService(t.paths, remover, () => getLiveSessions(t.paths, () => alive))
}

const isRemoval = (a: Artifact): boolean => !isSharedFileEdit(a.kind)

function snapshot(root: string): Map<string, Buffer> {
  const m = new Map<string, Buffer>()
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) m.set(p.toLowerCase(), readFileSync(p))
    }
  }
  walk(root)
  return m
}

function expectUnchanged(before: Map<string, Buffer>, after: Map<string, Buffer>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
  for (const [k, v] of before) expect(after.get(k)!.equals(v)).toBe(true)
}

function claudeJson(t: FakeClaudeTree): { projects: Record<string, unknown>; githubRepoPaths: Record<string, string[]> } {
  return JSON.parse(readFileSync(t.paths.claudeJson, 'utf8'))
}

function historyLines(t: FakeClaudeTree): string[] {
  return readFileSync(t.paths.historyFile, 'utf8').split('\n').filter(l => l.length > 0)
}

/** permanentRemover, but a configured path fails like a locked file. */
function lockingRemover(locked: string): FileRemover {
  const busy = (p: string): void => {
    if (p === locked) { const e = new Error(`EBUSY: resource busy or locked, rmdir '${p}'`) as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e }
  }
  return {
    async removeDirectory(p) { busy(p); await permanentRemover.removeDirectory(p) },
    async removeFile(p) { busy(p); await permanentRemover.removeFile(p) },
    recyclable: () => true
  }
}

/** Replaces `dir` with a junction to a missing folder (port of the C# Junction.MakeDangling). */
function makeDangling(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  const target = dir + '-missing-target'
  mkdirSync(target, { recursive: true })
  symlinkSync(target, dir, 'junction')
  rmSync(target, { recursive: true, force: true })
}

describe('DeleteService (project scope)', () => {
  it('deletes everything for the project and nothing else', async () => {
    const t = tree()
    const x = t.workDir('X'), xc = t.workDir('X.com')
    populate(t, x, 's1', 'j1'); populate(t, xc, 's2', 'j2')
    t.addGithubRepoPath('o/shared', x); t.addGithubRepoPath('o/shared', xc)
    t.addClaudeJsonProject(x.replace(/\\/g, '/')) // same project, other spelling
    const svc = service(t)
    const xcBefore = await svc.plan(info(t, xc, 's2'))
    const plan = await svc.plan(info(t, x, 's1'))
    expect(new Set(plan.map(a => a.kind)).size).toBe(14)

    const r = await svc.execute(info(t, x, 's1'), plan)

    expect(r.failures).toEqual([])
    for (const a of plan.filter(isRemoval)) expect(existsSync(a.path), a.path).toBe(false)
    expect(existsSync(x)).toBe(true) // the working folder itself is never removed
    for (const a of xcBefore.filter(isRemoval)) expect(existsSync(a.path), a.path).toBe(true)
    const desc = (as: Artifact[]): unknown[] => as.map(a => [a.kind, a.path, a.description])
    expect(desc(await svc.plan(info(t, xc, 's2')))).toEqual(desc(xcBefore))

    const json = claudeJson(t)
    expect(Object.keys(json.projects)).toEqual([xc])
    expect('o/X' in json.githubRepoPaths).toBe(false)
    expect(json.githubRepoPaths['o/X.com']).toEqual([xc])
    expect(json.githubRepoPaths['o/shared']).toEqual([xc])
    const h = historyLines(t)
    expect(h).toHaveLength(1)
    expect(JSON.parse(h[0]!).project).toBe(xc)
  })

  it('backs up .claude.json and history.jsonl before editing them (Delegatto: on by default)', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const jsonBefore = readFileSync(t.paths.claudeJson)
    const historyBefore = readFileSync(t.paths.historyFile)
    const svc = service(t)

    const r = await svc.execute(info(t, x, 's1'), await svc.plan(info(t, x, 's1')))

    expect(r.failures).toEqual([])
    expect(r.backupDir).not.toBeNull()
    expect(readFileSync(join(r.backupDir!, '.claude.json')).equals(jsonBefore)).toBe(true)
    expect(readFileSync(join(r.backupDir!, 'history.jsonl')).equals(historyBefore)).toBe(true)
    expect(readFileSync(t.paths.claudeJson).equals(jsonBefore)).toBe(false)
  })

  it('makes no backup with backup: false, or when no shared file is edited', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const jsonBefore = readFileSync(t.paths.claudeJson)
    const svc = service(t)
    const plan = await svc.plan(info(t, x, 's1'))

    let r = await svc.execute(info(t, x, 's1'), plan.filter(a => a.kind === 'Todos'))
    expect(r.backupDir).toBeNull()
    r = await svc.execute(info(t, x, 's1'), plan.filter(a => a.kind !== 'Todos'), { backup: false })

    expect(r.failures).toEqual([])
    expect(r.backupDir).toBeNull()
    expect(existsSync(t.paths.backupsDir)).toBe(false)
    expect(readFileSync(t.paths.claudeJson).equals(jsonBefore)).toBe(false)
  })

  it('executeMany deletes several projects and keeps the rest', async () => {
    const t = tree()
    const a = t.workDir('A'), b = t.workDir('B'), c = t.workDir('C')
    populate(t, a, 's1', 'j1'); populate(t, b, 's2', 'j2'); populate(t, c, 's3', 'j3')
    const svc = service(t)
    const cBefore = await svc.plan(info(t, c, 's3'))
    const planA = await svc.plan(info(t, a, 's1'))
    const planB = await svc.plan(info(t, b, 's2'))

    const r = await svc.executeMany([{ project: info(t, a, 's1'), selected: planA }, { project: info(t, b, 's2'), selected: planB }])

    expect(r.failures).toEqual([])
    for (const x of [...planA, ...planB].filter(isRemoval)) expect(existsSync(x.path), x.path).toBe(false)
    for (const x of cBefore.filter(isRemoval)) expect(existsSync(x.path), x.path).toBe(true)
    expect(Object.keys(claudeJson(t).projects)).toEqual([c])
    const h = historyLines(t)
    expect(h).toHaveLength(1)
    expect(JSON.parse(h[0]!).project).toBe(c)
  })

  it('executeMany removes folders shared by twins once, without skip failures', async () => {
    const t = tree()
    const x = t.workDir('X-com'), xc = t.workDir('X.com')
    populate(t, x, 's1', 'j1'); populate(t, xc, 's2', 'j2')
    const svc = service(t)
    const planX = await svc.plan(info(t, x, 's1'))
    const planXc = await svc.plan(info(t, xc, 's2'))

    const r = await svc.executeMany([{ project: info(t, x, 's1'), selected: planX }, { project: info(t, xc, 's2'), selected: planXc }])

    expect(r.failures).toEqual([])
    for (const a of [...planX, ...planXc].filter(isRemoval)) expect(existsSync(a.path), a.path).toBe(false)
  })

  it('executeMany with a live session changes nothing', async () => {
    const t = tree()
    const a = t.workDir('A')
    populate(t, a, 's1', 'j1')
    const svc = service(t, true)
    t.addLiveSession(1, 's9', 'D:\\z')
    const plan = await svc.plan(info(t, a, 's1'))
    const before = snapshot(t.root)
    await expect(svc.executeMany([{ project: info(t, a, 's1'), selected: plan }])).rejects.toBeInstanceOf(SessionsLiveError)
    expectUnchanged(before, snapshot(t.root))
  })

  it('refuses when any session is live, changing nothing and making no backup', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    t.addLiveSession(4242, 'other', t.workDir('Unrelated'))
    const svc = service(t, true)
    const plan = await svc.plan(info(t, x, 's1'))
    const before = snapshot(t.root)

    const err = await svc.execute(info(t, x, 's1'), plan).catch(e => e)

    expect(err).toBeInstanceOf(SessionsLiveError)
    expect((err as SessionsLiveError).sessions.map(s => s.pid)).toEqual([4242])
    expect((err as Error).message).toBe('1 Claude Code session(s) still running. Close them before deleting or renaming.')
    expectUnchanged(before, snapshot(t.root))
    expect(existsSync(t.paths.backupsDir)).toBe(false)
  })

  it('keeps malformed history lines byte-for-byte and preserves the mtime', async () => {
    const t = tree()
    const x = t.workDir('X'), xc = t.workDir('X.com')
    t.addSession(x, 's1')
    writeFileSync(t.paths.historyFile, Buffer.concat([Buffer.from('garbage {\n'), Buffer.from([0xff, 0xfe, 0x7a, 0x0a])]))
    t.addHistory(x, 's1', 'drop me')
    t.addHistory(xc, 's2', 'keep me')
    const keptXc = readFileSync(t.paths.historyFile, 'utf8').split('\n')[3]!
    const mtime = new Date(Date.UTC(2025, 0, 2, 3, 4, 5))
    utimesSync(t.paths.historyFile, mtime, mtime)
    const svc = service(t)
    const hist = (await svc.plan(info(t, x, 's1'))).filter(a => a.kind === 'HistoryLines')
    expect(hist).toHaveLength(1)

    const r = await svc.execute(info(t, x, 's1'), hist)

    expect(r.failures).toEqual([])
    const expected = Buffer.concat([Buffer.from('garbage {\n'), Buffer.from([0xff, 0xfe, 0x7a, 0x0a]), Buffer.from(keptXc + '\n')])
    expect(readFileSync(t.paths.historyFile).equals(expected)).toBe(true)
    expect(statSync(t.paths.historyFile).mtime.getTime()).toBe(mtime.getTime())
    expect(existsSync(info(t, x).projectDir!)).toBe(true) // not selected
  })

  it('a locked item is reported and the others are deleted', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const plan = await service(t).plan(info(t, x, 's1'))
    const tasks = plan.find(a => a.kind === 'Tasks')!.path
    const svc = service(t, false, lockingRemover(tasks))

    const r = await svc.execute(info(t, x, 's1'), plan)

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]!.path).toBe(tasks)
    expect(r.failures[0]!.error.trim()).not.toBe('')
    for (const a of plan.filter(a => isRemoval(a) && a.kind !== 'Tasks')) expect(existsSync(a.path), a.path).toBe(false)
    expect(existsSync(tasks)).toBe(true)
    expect(r.done).toContain(t.paths.claudeJson)
    expect(r.done).toContain(t.paths.historyFile)
  })

  it('optional items are removed only when selected', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const svc = service(t)
    const plan = await svc.plan(info(t, x, 's1'))
    const optional = plan.filter(a => a.optional)
    expect(optional).toHaveLength(2)

    let r = await svc.execute(info(t, x, 's1'), plan.filter(a => !a.optional))
    expect(r.failures).toEqual([])
    expect(existsSync(join(x, '.claude'))).toBe(true)
    expect(existsSync(join(x, 'CLAUDE.md'))).toBe(true)

    r = await svc.execute(info(t, x, 's1'), optional)
    expect(r.failures).toEqual([])
    expect(existsSync(join(x, '.claude'))).toBe(false)
    expect(existsSync(join(x, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(x)).toBe(true)
  })

  it('only selected artifacts are touched', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const svc = service(t)
    const plan = await svc.plan(info(t, x, 's1'))
    const todo = plan.find(a => a.kind === 'Todos')!
    const jsonBefore = readFileSync(t.paths.claudeJson)
    const historyBefore = readFileSync(t.paths.historyFile)

    const r = await svc.execute(info(t, x, 's1'), [todo])

    expect(r.failures).toEqual([])
    expect(r.done).toEqual([todo.path])
    expect(existsSync(todo.path)).toBe(false)
    for (const a of plan.filter(a => isRemoval(a) && a !== todo)) expect(existsSync(a.path), a.path).toBe(true)
    expect(readFileSync(t.paths.claudeJson).equals(jsonBefore)).toBe(true)
    expect(readFileSync(t.paths.historyFile).equals(historyBefore)).toBe(true)
  })

  it('refuses a removal outside the current plan', async () => {
    const t = tree()
    const x = t.workDir('X'), xc = t.workDir('X.com')
    populate(t, x, 's1', 'j1'); populate(t, xc, 's2', 'j2')
    const svc = service(t)
    const foreign = (await svc.plan(info(t, xc, 's2'))).find(a => a.kind === 'ProjectFolder')!

    const r = await svc.execute(info(t, x, 's1'), [foreign])

    expect(r.failures.map(f => f.path)).toEqual([foreign.path])
    expect(r.failures[0]!.error).toBe("Skipped: no longer part of this project's data.")
    expect(existsSync(foreign.path)).toBe(true)
  })

  it('an unparseable .claude.json is reported, not written, and the rest continues', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const svc = service(t)
    const plan = await svc.plan(info(t, x, 's1'))
    writeFileSync(t.paths.claudeJson, '{"projects": {broken')
    const corrupt = readFileSync(t.paths.claudeJson)

    const r = await svc.execute(info(t, x, 's1'), plan)

    expect(r.failures.map(f => f.path)).toEqual([t.paths.claudeJson])
    expect(readFileSync(t.paths.claudeJson).equals(corrupt)).toBe(true)
    expect(r.done).toContain(t.paths.historyFile)
    for (const a of plan.filter(isRemoval)) expect(existsSync(a.path), a.path).toBe(false)
  })

  it(".claude.json's other content is preserved and indented", async () => {
    const t = tree()
    const x = t.workDir('X')
    t.addClaudeJsonProject(x)
    const node = claudeJson(t) as Record<string, unknown>
    node.numStartups = 42
    node.userID = 'café <&> "q"'
    node.nested = { a: [1, 2.5, true, null], e: {} }
    writeFileSync(t.paths.claudeJson, JSON.stringify(node))
    const svc = service(t)

    const r = await svc.execute(info(t, x), await svc.plan(info(t, x)))

    expect(r.failures).toEqual([])
    const bytes = readFileSync(t.paths.claudeJson)
    expect(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf).toBe(false)
    const text = bytes.toString('utf8')
    expect(text).toContain('\n  "numStartups": 42')
    expect(text).toContain('café <&> \\"q\\"')
    const after = JSON.parse(text)
    expect(after.projects).toEqual({})
    expect(after).toEqual({ ...node, projects: {} })
  })

  it('a .claude.json number too large for JS is refused (reported, file untouched), the rest continues', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const text = readFileSync(t.paths.claudeJson, 'utf8').replace('{', '{"big":123456789012345678901234567890,')
    writeFileSync(t.paths.claudeJson, text)
    const svc = service(t)
    const plan = await svc.plan(info(t, x, 's1'))

    const r = await svc.execute(info(t, x, 's1'), plan)

    expect(r.failures.map(f => f.path)).toEqual([t.paths.claudeJson])
    expect(readFileSync(t.paths.claudeJson, 'utf8')).toBe(text)
    expect(r.done).toContain(t.paths.historyFile)
  })

  it('a re-check failure is reported and keeps the .claude.json / history edits', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    let calls = 0
    const svc = new DeleteService(t.paths, permanentRemover, () => getLiveSessions(t.paths, () => false),
      async p => { if (++calls === 1) return collectProjectArtifacts(t.paths, p); throw new Error('jobs is not readable') })
    const plan = await svc.plan(info(t, x, 's1'))

    const r = await svc.execute(info(t, x, 's1'), plan)

    expect(r.done).toEqual([t.paths.claudeJson, t.paths.historyFile])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]!.error).toContain('Could not re-check project data: jobs is not readable; nothing further was removed')
    for (const a of plan.filter(isRemoval)) expect(existsSync(a.path), a.path).toBe(true)
    expect(claudeJson(t).projects).toEqual({})
  })

  it.runIf(process.platform === 'win32')('an unreadable jobs folder does not break execute', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    makeDangling(t.paths.jobsDir)
    makeDangling(join(t.paths.claudeDir, 'todos'))
    const svc = service(t)
    const plan = await svc.plan(info(t, x, 's1'))

    const r = await svc.execute(info(t, x, 's1'), plan)

    expect(r.failures).toEqual([])
    expect(r.done).toContain(t.paths.claudeJson)
    expect(r.done).toContain(t.paths.historyFile)
    expect(existsSync(info(t, x).projectDir!)).toBe(false)
  })

  it('memory children and the memory folder are not removed twice', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    t.addMemory(x, 'MEMORY.md', 'index')
    const svc = service(t)
    const everything = await collectProjectArtifacts(t.paths, info(t, x, 's1')) // includes memory\*.md children
    expect(everything.some(a => a.parent !== undefined)).toBe(true)

    const r = await svc.execute(info(t, x, 's1'), everything)

    expect(r.failures).toEqual([])
    expect(r.done.some(d => d.toLowerCase().endsWith('.md') && d.includes('memory'))).toBe(false)
    expect(r.done).not.toContain(join(info(t, x).projectDir!, 'memory'))
    expect(existsSync(info(t, x).projectDir!)).toBe(false)
  })

  it('the memory folder is contained by the project folder', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const plan = await service(t).plan(info(t, x, 's1'))
    const folder = plan.find(a => a.kind === 'ProjectFolder')!
    const memory = plan.find(a => a.kind === 'Memory')!
    expect(containingProjectFolder(memory, plan)).toBe(folder)
    for (const a of plan.filter(a => a.kind !== 'Memory')) expect(containingProjectFolder(a, plan)).toBeUndefined()
  })

  it('sharedFolderOwners finds lossy-encoding twins', async () => {
    const t = tree()
    const dotted = t.workDir('X.com'), dashed = t.workDir('X-com'), other = t.workDir('X')
    t.addSession(dotted, 's1'); t.addSession(other, 's3')
    t.addClaudeJsonProject(dashed.replace(/\\/g, '/'))
    t.addHistory(dashed, 's2', 'hi'); t.addHistory(dotted, 's1', 'hi')
    const ps = await scanProjects(t.paths)
    const dottedInfo = ps.find(p => p.workingDir === dotted)!

    expect(await sharedFolderOwners(t.paths, dottedInfo, ps)).toEqual([dashed])
    expect(await sharedFolderOwners(t.paths, dottedInfo)).toEqual([dashed]) // scans itself
    expect(await sharedFolderOwners(t.paths, ps.find(p => p.workingDir === other)!, ps)).toEqual([])
  })
})

describe('DeleteService.planForReview', () => {
  it('flags removals on a drive without a Recycle Bin as permanent and unticks them', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const tempRoot = t.paths.tempClaudeDir
    const remover: FileRemover = { ...permanentRemover, recyclable: p => !p.startsWith(tempRoot) }
    const plan = await service(t, false, remover).planForReview(info(t, x, 's1'))

    const by = (k: string): (typeof plan)[number] => plan.find(a => a.kind === k)!
    expect(by('TempScratch')).toMatchObject({ permanent: true, defaultSelected: false })
    expect(by('ProjectFolder')).toMatchObject({ permanent: false, defaultSelected: true, containedIn: null })
    expect(by('Memory')).toMatchObject({ containedIn: by('ProjectFolder').path })
    expect(by('InDirClaudeMd')).toMatchObject({ permanent: false, defaultSelected: false }) // optional
    // Shared-file edits are never "permanent" removals.
    for (const k of ['ClaudeJsonEntry', 'GithubRepoPath', 'HistoryLines']) expect(by(k)).toMatchObject({ permanent: false, defaultSelected: true })
  })

  it('with the permanent remover every removal is permanent', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const plan = await service(t).planForReview(info(t, x, 's1'))
    for (const a of plan.filter(isRemoval)) expect(a).toMatchObject({ permanent: true, defaultSelected: false })
  })
})

describe('DeleteService.executeChat', () => {
  function twoChats(t: FakeClaudeTree): { x: string; dir: string } {
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    t.addSession(x, 's2')
    t.addHistory(x, 's2', 'other chat')
    t.addSessionDir('tasks', 's2')
    t.addTodo('s2')
    t.addJob('j2', 's2', x)
    const dir = info(t, x).projectDir!
    mkdirSync(join(dir, 's1', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 's1', 'subagents', 'a.jsonl'), '{}\n')
    return { x, dir }
  }

  it("removes only that chat's data and its history lines", async () => {
    const t = tree()
    const { x, dir } = twoChats(t)
    const svc = service(t)
    const jsonBefore = readFileSync(t.paths.claudeJson)
    const plan = await svc.planChat(dir, 's1')
    expect(new Set(plan.map(a => a.kind))).toEqual(new Set(
      ['SessionTranscript', 'SessionFolder', 'FileHistory', 'SessionEnv', 'Tasks', 'Uploads', 'Todos', 'Job', 'HistoryLines']))
    const s2Before = (await svc.planChat(dir, 's2')).map(a => a.path)

    const r = await svc.executeChat(dir, 's1', plan)

    expect(r.failures).toEqual([])
    expect(r.backupDir).not.toBeNull()
    expect(r.done).toContain(t.paths.historyFile)
    for (const a of plan.filter(isRemoval)) expect(existsSync(a.path), a.path).toBe(false)
    for (const p of s2Before) expect(existsSync(p), p).toBe(true)
    expect(existsSync(join(dir, 'memory', 'm.md'))).toBe(true)
    expect(existsSync(x)).toBe(true)
    expect(readFileSync(t.paths.claudeJson).equals(jsonBefore)).toBe(true)
    expect(historyLines(t).map(l => JSON.parse(l).sessionId)).toEqual(['s2'])
  })

  it('a live session of another chat blocks only when history.jsonl is edited', async () => {
    const t = tree()
    const { dir } = twoChats(t)
    t.addLiveSession(77, 's2', 'D:\\elsewhere')
    const svc = service(t, true)
    const plan = await svc.planChat(dir, 's1')
    const before = snapshot(t.root)

    await expect(svc.executeChat(dir, 's1', plan)).rejects.toBeInstanceOf(SessionsLiveError)
    expectUnchanged(before, snapshot(t.root))

    const r = await svc.executeChat(dir, 's1', plan.filter(a => a.kind !== 'HistoryLines'))
    expect(r.failures).toEqual([])
    expect(r.backupDir).toBeNull()
    expect(existsSync(join(dir, 's1.jsonl'))).toBe(false)
    expect(historyLines(t)).toHaveLength(2) // s1 and s2 lines both kept
  })

  it("the chat's own live process always blocks", async () => {
    const t = tree()
    const { dir } = twoChats(t)
    t.addLiveSession(78, 'S1', 'D:\\x')
    const svc = service(t, true)
    const plan = (await svc.planChat(dir, 's1')).filter(a => a.kind !== 'HistoryLines')
    const err = await svc.executeChat(dir, 's1', plan).catch(e => e)
    expect(err).toBeInstanceOf(SessionsLiveError)
    expect((err as SessionsLiveError).sessions.map(s => s.pid)).toEqual([78])
    expect(existsSync(join(dir, 's1.jsonl'))).toBe(true)
  })

  it("refuses another chat's items", async () => {
    const t = tree()
    const { dir } = twoChats(t)
    const svc = service(t)
    const foreign = (await svc.planChat(dir, 's2')).find(a => a.kind === 'SessionTranscript')!
    const r = await svc.executeChat(dir, 's1', [foreign])
    expect(r.failures).toEqual([{ path: foreign.path, error: "Skipped: no longer part of this chat's data." }])
    expect(existsSync(foreign.path)).toBe(true)
  })
})

describe('backups (ported from DeleteServiceTests)', () => {
  it('never overwrites an existing backup', () => {
    const t = tree()
    t.addHistory('D:\\a', 's', 'hi')
    const dirs = [backupClaudeState(t.paths), backupClaudeState(t.paths), backupClaudeState(t.paths)]
    expect(new Set(dirs.map(d => d.toLowerCase())).size).toBe(3)
    for (const d of dirs) {
      expect(existsSync(join(d, '.claude.json'))).toBe(true)
      expect(existsSync(join(d, 'history.jsonl'))).toBe(true)
    }
  })

  it('copies only existing files', () => {
    const t = tree()
    const d = backupClaudeState(t.paths)
    expect(existsSync(join(d, '.claude.json'))).toBe(true)
    expect(existsSync(join(d, 'history.jsonl'))).toBe(false)
  })
})
