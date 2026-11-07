import { describe, it, expect, afterEach } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, promises as fsp } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import * as yauzl from 'yauzl'
import { encodePath, isSamePath } from '../../src/main/manage/paths'
import { permanentRemover } from '../../src/main/manage/fs-util'
import { DeleteService, SessionsLiveError } from '../../src/main/manage/delete'
import type { LiveSession } from '../../src/main/manage/live'
import type { ProjectInfo } from '../../src/main/manage/types'
import {
  ARCHIVE_FORMAT, ArchiveService, InvalidArchiveError, readManifest, RestorePointError, type NoteToExport
} from '../../src/main/manage/archive'
import { dotnetJson, dotnetUtc, parseDotnetDate } from '../../src/main/manage/archive-zip'
import { FakeClaudeTree } from './fake-tree'

/** Port of ClaudeMemoryTool's ArchiveServiceTests, plus format-compatibility tests. */

const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

function info(t: FakeClaudeTree, wd: string, ...ids: string[]): ProjectInfo {
  return {
    workingDir: wd, workingDirKnown: true, encodedName: encodePath(wd), projectDir: join(t.paths.projectsDir, encodePath(wd)),
    sessionIds: ids, lastUsed: null, sizeBytes: 0, exists: true, worktreeOf: null
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

const noLive = (): LiveSession[] => []
const oneLive = (): LiveSession[] => [{ pid: 1234, sessionId: 'live', cwd: 'x', name: 't', procStart: null }]

/** Every file under root (outside backups\) -> its bytes; keys lowercased for a case-insensitive compare. */
function snapshot(root: string): Map<string, Buffer> {
  const m = new Map<string, Buffer>()
  const walk = (d: string): void => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && !p.toLowerCase().includes('\\backups\\')) m.set(p.toLowerCase(), readFileSync(p))
    }
  }
  walk(root)
  return m
}

function expectRestored(t: FakeClaudeTree, before: Map<string, Buffer>): void {
  const after = snapshot(t.root)
  for (const [path, bytes] of before) {
    if (isSamePath(path, t.paths.claudeJson) || isSamePath(path, t.paths.historyFile)) continue
    expect(after.has(path), 'missing after import: ' + path).toBe(true)
    expect(after.get(path)!.equals(bytes), 'changed: ' + path).toBe(true)
  }
}

const keys = (m: Map<string, Buffer>): string[] => [...m.keys()].sort()

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

function historyLines(t: FakeClaudeTree): string[] {
  return readFileSync(t.paths.historyFile, 'utf8').split('\n').filter(l => l.length > 0)
}

async function zipEntryNames(zip: string): Promise<string[]> {
  const z = await yauzl.openPromise(zip, { lazyEntries: true })
  const names: string[] = []
  try { for await (const e of z.eachEntry()) names.push(e.fileName) } finally { z.close() }
  return names
}

// ------------------------------------------------------------------ a zip as .NET's ZipArchive writes it

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d: Date): { date: number; time: number } {
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  }
}

type RawEntry = { name: string; data: string | Buffer; mtime?: Date }

/** Writes a zip the way System.IO.Compression's ZipArchive (Create mode, seekable
 *  stream) does: deflate, sizes and CRC in the local header (no data descriptor),
 *  DOS local time, UTF-8 flag only for non-ASCII names, names taken verbatim
 *  (forward slashes; no validation, so `..` names can be built for attack tests). */
function writeDotNetZip(path: string, entries: RawEntry[]): string {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const comp = deflateRawSync(data)
    const crc = crc32(data)
    const { date, time } = dosTime(e.mtime ?? new Date())
    const flags = /[^\x00-\x7f]/.test(e.name) ? 0x800 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0014, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    parts.push(local, name, comp)
    offset += local.length + name.length + comp.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16)
  writeFileSync(path, Buffer.concat([...parts, cdBuf, eocd]))
  return path
}

/** A hand-made projects export: one project `workingDir` in folder p1, plus raw entries (C# EvilZip). */
function evilZip(t: FakeClaudeTree, workingDir: string, projectExtra: string, ...entries: Array<[string, string]>): string {
  const zip = join(t.root, `evil-${Math.random().toString(16).slice(2)}.zip`)
  const manifest = `{"Format":"${ARCHIVE_FORMAT}","Version":1,"Kind":"Projects","CreatedUtc":"2026-01-01T00:00:00Z","Machine":"m",` +
    `"Projects":[{"WorkingDir":${JSON.stringify(workingDir)},"Folder":"p1","GithubRepoPaths":[],"HistoryLines":0,"Files":1,"Bytes":1${projectExtra}}],"Notes":[]}`
  return writeDotNetZip(zip, [{ name: 'manifest.json', data: manifest }, ...entries.map(([name, data]) => ({ name, data }))])
}

// ------------------------------------------------------------------ ported tests

describe('ArchiveService (port of ArchiveServiceTests)', () => {
  it('export, then delete, then import restores every file and entry', async () => {
    const t = tree()
    const x = t.workDir('X')
    const y = t.workDir('Y')
    populate(t, x, 's1', 'j1')
    populate(t, y, 's2', 'j2')
    const before = snapshot(t.root)
    const zip = join(t.root, 'out', 'x.zip')
    mkdirSync(dirname(zip), { recursive: true })
    const archive = new ArchiveService(t.paths)

    const exp = await archive.exportProjects([info(t, x, 's1')], zip)
    expect(exp.failures).toEqual([])
    const m = await readManifest(zip)
    expect(m.kind).toBe('Projects')
    expect(m.projects.map(p => p.workingDir)).toEqual([x])

    const del = new DeleteService(t.paths, permanentRemover, noLive)
    expect((await del.execute(info(t, x, 's1'), await del.plan(info(t, x, 's1')))).failures).toEqual([])
    expect(existsSync(join(t.paths.projectsDir, encodePath(x)))).toBe(false)

    const imp = await archive.import(zip, noLive)
    expect(imp.failures).toEqual([])
    expect(imp.backupDir).not.toBeNull()

    expectRestored(t, before)
    const json = readJson(t.paths.claudeJson)
    expect(json.projects[x]).toBeDefined()
    expect(json.projects[y]).toBeDefined()
    expect(json.githubRepoPaths['o/X']).toContain(x)
    const history = historyLines(t)
    expect(history).toHaveLength(2)
    expect(history.filter(l => l.includes(JSON.stringify(x)))).toHaveLength(1)
  })

  it('restore point, then batch delete, then import restores both projects', async () => {
    const t = tree()
    const x = t.workDir('X')
    const y = t.workDir('Y')
    const z = t.workDir('Z')
    populate(t, x, 's1', 'j1')
    populate(t, y, 's2', 'j2')
    populate(t, z, 's3', 'j3')
    const before = snapshot(t.root)
    const archive = new ArchiveService(t.paths)

    const zip = await archive.createRestorePoint([info(t, x, 's1'), info(t, y, 's2')])
    expect(zip.startsWith(t.paths.restorePointsDir)).toBe(true)
    expect(zip.endsWith(' 2 projects.zip')).toBe(true)
    const points = await archive.listRestorePoints()
    expect(points).toHaveLength(1)
    expect(points[0]!.path).toBe(zip)
    expect(points[0]!.error).toBeNull()
    expect(points[0]!.projects).toEqual([x, y])

    const del = new DeleteService(t.paths, permanentRemover, noLive)
    const r = await del.executeMany([
      { project: info(t, x, 's1'), selected: await del.plan(info(t, x, 's1')) },
      { project: info(t, y, 's2'), selected: await del.plan(info(t, y, 's2')) }
    ])
    expect(r.failures).toEqual([])

    expect((await archive.import(zip, noLive)).failures).toEqual([])
    expectRestored(t, before)
    const json = readJson(t.paths.claudeJson)
    for (const wd of [x, y, z]) expect(json.projects[wd]).toBeDefined()
    expect(historyLines(t)).toHaveLength(3)
  })

  it('a restore point that cannot save a file throws and leaves no zip', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const mem = join(t.paths.projectsDir, encodePath(x), 'memory', 'm.md')
    // Node can't take an exclusive lock on Windows: the seam plays the locked file.
    const archive = new ArchiveService(t.paths, {
      openFile: async p => {
        if (isSamePath(p, mem)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        return fsp.open(p, 'r')
      }
    })

    const e = await archive.createRestorePoint([info(t, x, 's1')]).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(RestorePointError)
    expect((e as Error).message).toContain('nothing was deleted')
    expect((e as Error).message).toContain(mem)
    expect(readdirSync(t.paths.restorePointsDir)).toEqual([])
    expect(await archive.listRestorePoints()).toEqual([])
  })

  it('an unreadable restore point is listed with an error', async () => {
    const t = tree()
    mkdirSync(t.paths.restorePointsDir, { recursive: true })
    writeFileSync(join(t.paths.restorePointsDir, 'broken.zip'), 'not a zip')
    const points = await new ArchiveService(t.paths).listRestorePoints()
    expect(points).toHaveLength(1)
    expect(points[0]!.error).not.toBeNull()
    expect(points[0]!.projects).toEqual([])
  })

  it('import never overwrites existing files, entries or history', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const zip = join(t.root, 'x.zip')
    const archive = new ArchiveService(t.paths)
    await archive.exportProjects([info(t, x, 's1')], zip)

    const mem = join(t.paths.projectsDir, encodePath(x), 'memory', 'm.md')
    writeFileSync(mem, 'changed since export')
    const historyBefore = readFileSync(t.paths.historyFile, 'utf8')

    const r = await archive.import(zip, noLive)
    expect(r.failures).toEqual([])
    expect(readFileSync(mem, 'utf8')).toBe('changed since export')
    expect(readFileSync(t.paths.historyFile, 'utf8')).toBe(historyBefore)
    expect(r.done.some(d => d.includes('kept the existing .claude.json entry'))).toBe(true)
    expect(readJson(t.paths.claudeJson).githubRepoPaths['o/X']).toHaveLength(1)
  })

  it('import of projects refuses while a session is live and changes nothing', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const zip = join(t.root, 'x.zip')
    const archive = new ArchiveService(t.paths)
    await archive.exportProjects([info(t, x, 's1')], zip)
    rmSync(join(t.paths.projectsDir, encodePath(x)), { recursive: true })
    t.addLiveSession(1234, 'live', x)
    const before = snapshot(t.root)

    await expect(archive.import(zip, oneLive)).rejects.toBeInstanceOf(SessionsLiveError)
    expect(keys(snapshot(t.root))).toEqual(keys(before))
  })

  it("export leaves out git worktrees in the project's own .claude folder", async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    mkdirSync(join(x, '.claude', 'worktrees', 'w1'), { recursive: true })
    writeFileSync(join(x, '.claude', 'worktrees', 'w1', 'big.bin'), 'x')
    const zip = join(t.root, 'x.zip')
    await new ArchiveService(t.paths).exportProjects([info(t, x, 's1')], zip)
    const names = await zipEntryNames(zip)
    expect(names).toContain('p1/workdir/.claude/settings.json')
    expect(names).toContain('p1/workdir/CLAUDE.md')
    expect(names.some(n => n.includes('worktrees'))).toBe(false)
  })

  it.each([
    'p1/claude/settings.json', // not per-project data
    'p1/claude/projects/OTHER/a.jsonl', // another project's folder
    'p1/claude/../../evil.txt', // escapes the root
    'p1/claude/file-history/../settings.json', // .. back out of an allowed folder
    'p1/claude/projects/{enc}/../../CLAUDE.md', // the global CLAUDE.md
    'p1/claude/projects/{enc}/../OTHER/x.jsonl', // into another project
    'p1/claude/projects/{enc}', // the folder itself as a file
    'p1/workdir/src/evil.cs', // only .claude\ and CLAUDE.md in the working folder
    'p1/workdir/.claude/../.git/hooks/pre-commit', // .. out of the working folder's .claude
    'p1/temp/OTHER/x.txt',
    'p1/temp/{enc}/../OTHER/x.txt',
    // Delegatto additions: backslash and Windows-trimmed segments must not escape either.
    'p1/claude/projects\\..\\settings.json',
    'p1/claude/projects/{enc}/.../x.txt',
    'p1/claude/projects/{enc}/. ./x.txt',
    'p1/claude/C:/evil.txt',
    'p1/claude/projects/{enc}/x.txt:ads'
  ])('import refuses files outside the project\'s own folders: %s', async entryName => {
    const t = tree()
    const x = t.workDir('X')
    const zip = evilZip(t, x, '', [entryName.replace('{enc}', encodePath(x)), 'evil'])
    const before = snapshot(t.root)
    const r = await new ArchiveService(t.paths).import(zip, noLive)
    expect(r.failures).toHaveLength(1)
    expect(keys(snapshot(t.root))).toEqual(keys(before))
  })

  it("import refuses a home-folder project's workdir files because that is Claude's own data", async () => {
    const t = tree()
    const zip = evilZip(t, t.root, '', ['p1/workdir/.claude/settings.json', '{"hooks":{}}'])
    const r = await new ArchiveService(t.paths).import(zip, noLive)
    expect(r.failures).toHaveLength(1)
    expect(existsSync(join(t.paths.claudeDir, 'settings.json'))).toBe(false)
  })

  it('import never writes a .claude.json entry or repo link for another folder', async () => {
    const t = tree()
    const x = t.workDir('X')
    const other = t.workDir('Other')
    t.addClaudeJsonProject(other)
    const extra = `,"ClaudeJsonKey":${JSON.stringify(other)},"GithubRepoPaths":[{"Repo":"o/r","Path":${JSON.stringify(other)}}]`
    const zip = evilZip(t, x, extra, ['p1/claude-json-entry.json', '{"evil":true}'])
    const r = await new ArchiveService(t.paths).import(zip, noLive)
    expect(r.failures).toHaveLength(2)
    const json = readJson(t.paths.claudeJson)
    expect(json.projects[other].evil).toBeUndefined()
    expect(json.githubRepoPaths['o/r']).toBeUndefined()
  })

  it('a project with an unknown working dir round-trips its chat folder', async () => {
    const t = tree()
    const enc = 'D--GIT-Gone'
    const dir = join(t.paths.projectsDir, enc)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's.jsonl'), '{}')
    const p: ProjectInfo = {
      workingDir: enc, workingDirKnown: false, encodedName: enc, projectDir: dir, sessionIds: ['s'],
      lastUsed: null, sizeBytes: 0, exists: false, worktreeOf: null
    }
    const zip = join(t.root, 'u.zip')
    const archive = new ArchiveService(t.paths)
    expect((await archive.exportProjects([p], zip)).failures).toEqual([])
    rmSync(dir, { recursive: true })
    const r = await archive.import(zip, noLive)
    expect(r.failures).toEqual([])
    expect(existsSync(join(dir, 's.jsonl'))).toBe(true)
  })

  it.each([
    ['{wd}\\..\\escape.md', '..\\escape.md'], // .. out of the project
    ['{claude}\\CLAUDE.md', 'CLAUDE.md'], // path and relative path disagree
    ['{wd}\\notes.txt', 'notes.txt'] // not a .md file
  ])('notes import only restores .md files inside their project: %s', async (pathT, rel) => {
    const t = tree()
    const a = t.workDir('A')
    const path = pathT.replace('{wd}', a).replace('{claude}', t.paths.claudeDir)
    const note = { Path: path, WorkingDir: a, RelativePath: rel, Entry: 'notes/1/x.md', ModifiedUtc: new Date().toISOString() }
    const zip = writeDotNetZip(join(t.root, 'n.zip'), [
      { name: 'manifest.json', data: `{"Format":"${ARCHIVE_FORMAT}","Version":1,"Kind":"Notes","CreatedUtc":"2026-01-01T00:00:00Z","Machine":"m","Projects":[],"Notes":[${JSON.stringify(note)}]}` },
      { name: 'notes/1/x.md', data: 'evil' }
    ])
    const r = await new ArchiveService(t.paths).import(zip, noLive)
    expect(r.done).toEqual([])
    expect(r.failures).toHaveLength(1)
    expect(existsSync(resolve(path))).toBe(false)
  })

  it('a damaged manifest with missing fields does not crash the import', async () => {
    const t = tree()
    const zip = writeDotNetZip(join(t.root, 'd.zip'), [{
      name: 'manifest.json',
      data: `{"Format":"${ARCHIVE_FORMAT}","Version":1,"Kind":"Projects","CreatedUtc":"2026-01-01T00:00:00Z","Projects":[null,{"Folder":"p1"},{"WorkingDir":"C:/x","Folder":"p2","GithubRepoPaths":null}]}`
    }])
    const r = await new ArchiveService(t.paths).import(zip, noLive)
    expect(r.failures).toEqual([])
  })

  it('rejects a zip that is not an export', async () => {
    const t = tree()
    const zip = writeDotNetZip(join(t.root, 'other.zip'), [{ name: 'readme.txt', data: '' }])
    await expect(readManifest(zip)).rejects.toBeInstanceOf(InvalidArchiveError)
  })

  it('notes round-trip restores deleted files with their dates and skips existing ones', async () => {
    const t = tree()
    const a = t.workDir('A')
    const plan = join(a, 'docs', 'plan.md')
    const readme = join(a, 'README.md')
    mkdirSync(dirname(plan), { recursive: true })
    writeFileSync(plan, 'the plan')
    writeFileSync(readme, 'readme')
    const stamp = new Date(Date.UTC(2025, 2, 4, 5, 6, 7))
    utimesSync(plan, stamp, stamp)
    // NoteIndex.FindNotes isn't ported yet: the two notes it would find.
    const notes: NoteToExport[] = [
      { path: readme, workingDir: a, relativePath: 'README.md' },
      { path: plan, workingDir: a, relativePath: 'docs\\plan.md' }
    ]
    const zip = join(t.root, 'notes.zip')
    const archive = new ArchiveService(t.paths)
    expect((await archive.exportNotes(notes, zip)).failures).toEqual([])
    expect((await readManifest(zip)).kind).toBe('Notes')

    await permanentRemover.removeFile(plan)
    rmSync(dirname(plan), { recursive: true })
    writeFileSync(readme, 'edited')

    const r = await archive.import(zip, oneLive) // notes don't need sessions closed
    expect(r.done).toEqual([plan])
    expect(r.failures.filter(f => f.path === readme)).toHaveLength(1)
    expect(r.failures).toHaveLength(1)
    expect(readFileSync(plan, 'utf8')).toBe('the plan')
    expect(statSync(plan).mtime.getTime()).toBe(stamp.getTime())
    expect(readFileSync(readme, 'utf8')).toBe('edited')
    expect(r.backupDir).toBeNull()
  })

  it('a failed export leaves no zip behind', async () => {
    const t = tree()
    const zip = join(t.root, 'x.zip')
    const ac = new AbortController()
    ac.abort()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    await expect(new ArchiveService(t.paths).exportProjects([info(t, x, 's1')], zip, ac.signal)).rejects.toThrow()
    expect(readdirSync(t.root).filter(f => f.startsWith('x.zip'))).toEqual([])
  })
})

// ------------------------------------------------------------------ Delegatto additions

describe('ArchiveService (Delegatto additions)', () => {
  it('writes the manifest exactly as System.Text.Json writes the C# records', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const zip = join(t.root, 'x.zip')
    await new ArchiveService(t.paths).exportProjects([info(t, x, 's1')], zip)

    const z = await yauzl.openPromise(zip, { lazyEntries: true })
    let text = ''
    try {
      for await (const e of z.eachEntry()) {
        if (e.fileName !== 'manifest.json') continue
        const chunks: Buffer[] = []
        for await (const c of await z.openReadStreamPromise(e)) chunks.push(c as Buffer)
        text = Buffer.concat(chunks).toString('utf8')
      }
    } finally { z.close() }

    expect(text.startsWith('{\r\n  "Format": "claude-memory-tool-export",\r\n  "Version": 1,\r\n  "Kind": "Projects",\r\n  "CreatedUtc": "')).toBe(true)
    expect(text.includes('\n') && !/[^\r]\n/.test(text)).toBe(true) // CRLF only
    const m = JSON.parse(text) as Record<string, any>
    expect(Object.keys(m)).toEqual(['Format', 'Version', 'Kind', 'CreatedUtc', 'Machine', 'Projects', 'Notes'])
    expect(m.CreatedUtc).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/)
    expect(Object.keys(m.Projects[0])).toEqual(['WorkingDir', 'Folder', 'ClaudeJsonKey', 'GithubRepoPaths', 'HistoryLines', 'Files', 'Bytes', 'EncodedName'])
    expect(m.Projects[0]).toMatchObject({
      WorkingDir: x, Folder: 'p1', ClaudeJsonKey: x, GithubRepoPaths: [{ Repo: 'o/X', Path: x }], HistoryLines: 1,
      EncodedName: encodePath(x)
    })
    expect(m.Notes).toEqual([])

    const names = await zipEntryNames(zip)
    expect(names.every(n => !n.includes('\\'))).toBe(true)
    expect(names).toEqual(expect.arrayContaining([
      'manifest.json', 'p1/claude-json-entry.json', 'p1/history.jsonl', `p1/temp/${encodePath(x)}/scratch.txt`,
      `p1/claude/projects/${encodePath(x)}/s1.jsonl`, `p1/claude/projects/${encodePath(x)}/memory/m.md`,
      'p1/claude/file-history/s1/data.txt', 'p1/claude/session-env/s1/data.txt', 'p1/claude/tasks/s1/1.json',
      'p1/claude/uploads/s1/img.png', 'p1/claude/todos/s1-agent-s1.json', 'p1/claude/jobs/j1/state.json',
      'p1/workdir/.claude/settings.json', 'p1/workdir/CLAUDE.md'
    ]))
  })

  it('dotnetJson escapes like the default JavaScriptEncoder, only inside strings', () => {
    expect(dotnetJson({ a: 'é<>&\'+`"\\\n\u0001', n: 1e21, e: [] }))
      .toBe('{\r\n  "a": "\\u00E9\\u003C\\u003E\\u0026\\u0027\\u002B\\u0060\\u0022\\\\\\n\\u0001",\r\n  "n": 1e+21,\r\n  "e": []\r\n}')
    expect(dotnetUtc(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 0)))).toBe('2026-01-02T03:04:05Z')
    expect(dotnetUtc(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 120)))).toBe('2026-01-02T03:04:05.12Z')
    expect(parseDotnetDate('2026-01-02T03:04:05.1234567Z')!.getTime()).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 123))
    expect(parseDotnetDate('2026-01-02T03:04:05')!.getTime()).toBe(Date.UTC(2026, 0, 2, 3, 4, 5)) // unspecified = UTC
    expect(parseDotnetDate('nope')).toBeNull()
  })

  it('imports a zip laid out the way the C# tool (.NET ZipArchive) writes it', async () => {
    const t = tree()
    const x = t.workDir('X ü') // non-ASCII: a UTF-8 flagged entry name
    const enc = encodePath(x)
    const mtime = new Date(2025, 5, 7, 8, 9, 10) // even seconds: DOS time keeps it exactly
    const manifest = dotnetJson({
      Format: ARCHIVE_FORMAT, Version: 1, Kind: 'Projects', CreatedUtc: '2026-10-31T12:00:00.1234567Z', Machine: 'PC',
      Projects: [{
        WorkingDir: x, Folder: 'p1', ClaudeJsonKey: x.replace(/\\/g, '/'), GithubRepoPaths: [{ Repo: 'o/x', Path: x }],
        HistoryLines: 1, Files: 4, Bytes: 10, EncodedName: enc
      }],
      Notes: []
    })
    const hist = JSON.stringify({ display: 'hi', project: x, sessionId: 's1' })
    const zip = writeDotNetZip(join(t.root, 'dotnet.zip'), [
      { name: `p1/claude/projects/${enc}/s1.jsonl`, data: '{"type":"user"}\n', mtime },
      { name: `p1/claude/projects/${enc}/memory/MEMORY.md`, data: '# mem ü', mtime },
      { name: 'p1/claude/file-history/s1/', data: '' }, // a directory entry: skipped
      { name: `p1/temp/${enc}/scratch.txt`, data: 'x', mtime },
      { name: 'p1/workdir/CLAUDE.md', data: '# x', mtime },
      { name: 'p1/claude-json-entry.json', data: '{\r\n  "allowedTools": [],\r\n  "note": "\\u00FC"\r\n}' },
      { name: 'p1/history.jsonl', data: '\uFEFF' + hist + '\r\n' },
      { name: 'manifest.json', data: '\uFEFF' + manifest }
    ])

    const m = await readManifest(zip)
    expect(m.createdUtc.getTime()).toBe(Date.UTC(2026, 9, 31, 12, 0, 0, 123))
    const r = await new ArchiveService(t.paths).import(zip, noLive)
    expect(r.failures).toEqual([])
    expect(r.backupDir).not.toBeNull()

    const transcript = join(t.paths.projectsDir, enc, 's1.jsonl')
    expect(readFileSync(transcript, 'utf8')).toBe('{"type":"user"}\n')
    expect(statSync(transcript).mtime.getTime()).toBe(mtime.getTime())
    expect(readFileSync(join(t.paths.projectsDir, enc, 'memory', 'MEMORY.md'), 'utf8')).toBe('# mem ü')
    expect(readFileSync(join(t.paths.tempClaudeDir, enc, 'scratch.txt'), 'utf8')).toBe('x')
    expect(readFileSync(join(x, 'CLAUDE.md'), 'utf8')).toBe('# x')
    const json = readJson(t.paths.claudeJson)
    expect(json.projects[x.replace(/\\/g, '/')]).toEqual({ allowedTools: [], note: 'ü' })
    expect(json.githubRepoPaths['o/x']).toEqual([x])
    expect(historyLines(t)).toEqual([hist])
  })

  it('round-trips through its own export with the same bytes and mtimes', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const transcript = join(t.paths.projectsDir, encodePath(x), 's1.jsonl')
    const old = new Date(2024, 0, 2, 3, 4, 6)
    utimesSync(transcript, old, old)
    const big = join(t.paths.projectsDir, encodePath(x), 'big.jsonl')
    writeFileSync(big, Buffer.alloc(3 * 1024 * 1024 + 7, 'a')) // > one stream chunk
    const before = snapshot(t.root)
    const zip = join(t.root, 'x.zip')
    const archive = new ArchiveService(t.paths)
    const exp = await archive.exportProjects([info(t, x, 's1')], zip)
    expect(exp.failures).toEqual([])
    expect(exp.done[0]).toMatch(/: 12 files \(3 MB\), \.claude\.json entry, 1 GitHub repo link\(s\), 1 history lines$/)

    rmSync(join(t.paths.projectsDir, encodePath(x)), { recursive: true })
    const r = await archive.import(zip, noLive)
    expect(r.failures).toEqual([])
    expect(r.done).toContain(`${x}: restored 3 files, kept 9 existing`)
    expectRestored(t, before)
    expect(statSync(transcript).mtime.getTime()).toBe(old.getTime())
  })

  it('deleteRestorePoints removes only zips in the restore-points folder', async () => {
    const t = tree()
    const x = t.workDir('X')
    populate(t, x, 's1', 'j1')
    const archive = new ArchiveService(t.paths)
    const zip = await archive.createRestorePoint([info(t, x, 's1')])
    expect(basename(zip)).toMatch(/^\d{8}-\d{6} X\.zip$/)
    const outside = join(t.root, 'keep.zip')
    writeFileSync(outside, 'x')
    const removed: string[] = []
    const r = await archive.deleteRestorePoints([zip, outside, join(t.paths.restorePointsDir, 'gone.zip')], {
      removeDirectory: async () => { throw new Error('unexpected') },
      removeFile: async p => { removed.push(p); await permanentRemover.removeFile(p) },
      recyclable: () => true
    })
    expect(r.done).toEqual([zip])
    expect(r.failures.map(f => f.path)).toEqual([outside, join(t.paths.restorePointsDir, 'gone.zip')])
    expect(removed).not.toContain(outside)
    expect(existsSync(outside)).toBe(true)
    expect(await archive.listRestorePoints()).toEqual([])
  })

  it('lists restore points newest first and flags a notes export', async () => {
    const t = tree()
    mkdirSync(t.paths.restorePointsDir, { recursive: true })
    const mk = (name: string, kind: string, created: string): string => writeDotNetZip(join(t.paths.restorePointsDir, name), [{
      name: 'manifest.json',
      data: `{"Format":"${ARCHIVE_FORMAT}","Version":1,"Kind":"${kind}","CreatedUtc":"${created}","Machine":"m","Projects":[{"WorkingDir":"C:\\\\a","Folder":"p1"}],"Notes":[]}`
    }])
    const older = mk('a.zip', 'Projects', '2026-01-01T00:00:00Z')
    const newer = mk('b.zip', 'Notes', '2026-02-01T00:00:00Z')
    const points = await new ArchiveService(t.paths).listRestorePoints()
    expect(points.map(p => p.path)).toEqual([newer, older])
    expect(points[0]!.error).toBe('Not a project export.')
    expect(points[1]!.projects).toEqual(['C:\\a'])
  })

  it('rejects an export from a newer format version', async () => {
    const t = tree()
    const zip = writeDotNetZip(join(t.root, 'v2.zip'), [{ name: 'manifest.json', data: `{"Format":"${ARCHIVE_FORMAT}","Version":2}` }])
    await expect(readManifest(zip)).rejects.toThrow(/newer version/)
  })
})
