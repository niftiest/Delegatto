import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { encodePath } from '../../src/main/manage/paths'
import type { FileRemover, ProjectInfo } from '../../src/main/manage/types'
import { permanentRemover } from '../../src/main/manage/fs-util'
import {
  MAX_NOTE_BYTES, NoteIndex, defaultSystemFolders, oneDriveCloudCheck, oneDriveRoots,
  type CloudOnlyCheck, type NoteFile, type NoteIndexOptions
} from '../../src/main/manage/notes'
import { FakeClaudeTree } from './fake-tree'

const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

function project(dir: string, known = true): ProjectInfo {
  return {
    workingDir: dir, workingDirKnown: known, encodedName: encodePath(dir), projectDir: null, sessionIds: [],
    lastUsed: null, sizeBytes: 0, exists: existsSync(dir), worktreeOf: null
  }
}

function write(dir: string, rel: string, text: string): string {
  const f = join(dir, rel)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, text)
  return f
}

const noCloud: CloudOnlyCheck = async () => new Set()
function index(t: FakeClaudeTree, opts: NoteIndexOptions = {}): NoteIndex {
  return new NoteIndex(t.paths, { cloudOnly: noCloud, ...opts })
}
const rels = (notes: NoteFile[]): string[] =>
  notes.map(n => n.relativePath).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

describe('NoteIndex.findNotes', () => {
  it('finds .md files recursively with relative paths', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'README.md', 'x')
    write(a, 'docs\\notes\\plan.MD', 'y')
    write(a, 'code.cs', 'z')
    const { notes, truncated } = await index(t).findNotes([project(a)])
    expect(rels(notes)).toEqual(['docs\\notes\\plan.MD', 'README.md'])
    for (const n of notes) expect(n.workingDir).toBe(a)
    expect(truncated).toEqual([])
    const readme = notes.find(n => n.relativePath === 'README.md')!
    expect(readme.sizeBytes).toBe(1)
    expect(readme.modified).toBeGreaterThan(0)
    expect(readme.cloudOnly).toBe(false)
  })

  it('skips dependency, build and worktree folders', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'keep.md', 'x')
    write(a, 'package.json', '{}') // a code project, so its build-output folders are skipped too
    for (const skip of ['node_modules', '.git', 'bin', 'obj', '.venv', 'venv', 'dist', 'build', '.claude\\worktrees',
      '.worktrees', '__pycache__', 'Library', 'packages', 'Temp', 'Logs', '.superpowers\\sdd\\task-1', 'out', 'target',
      '.vs', '.idea', 'AppData'])
      write(a, join(skip, 'x.md'), 'x')
    write(a, '.claude\\notes.md', 'x') // .claude itself is kept; only its worktrees are skipped
    const { notes } = await index(t).findNotes([project(a)])
    expect(rels(notes)).toEqual(['.claude\\notes.md', 'keep.md'])
  })

  it('keeps build-named folders when no code project sits beside them', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'docs\\build\\how-to-build.md', 'x')
    write(a, 'notes\\dist\\release.md', 'x')
    write(a, 'Library\\reading-list.md', 'x')
    write(a, 'node_modules\\x.md', 'x') // always skipped
    write(a, '.superpowers\\x.md', 'x') // always skipped
    const { notes } = await index(t).findNotes([project(a)])
    expect(rels(notes)).toEqual(['docs\\build\\how-to-build.md', 'Library\\reading-list.md', 'notes\\dist\\release.md'])
  })

  it.each(['App.csproj', 'Game.sln', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'ProjectSettings\\ProjectVersion.txt'])(
    'skips build-named folders beside the code-project marker %s', async marker => {
      const t = tree()
      const a = t.workDir('A')
      write(a, marker, 'x')
      write(a, 'build\\x.md', 'x')
      write(a, 'Library\\x.md', 'x')
      write(a, 'docs\\build\\kept.md', 'x') // the marker is in the project root, not in docs
      const { notes } = await index(t).findNotes([project(a)])
      expect(notes.map(n => n.relativePath)).toEqual(['docs\\build\\kept.md'])
    })

  it('lists a file in a nested project once, under the innermost project', async () => {
    const t = tree()
    const parent = t.workDir('Parent')
    const child = t.workDir('Parent\\Child')
    write(parent, 'p.md', 'x')
    write(child, 'c.md', 'x')
    const { notes } = await index(t).findNotes([project(parent), project(child)])
    expect(notes).toHaveLength(2)
    expect(notes.find(n => n.relativePath === 'p.md')!.workingDir).toBe(parent)
    expect(notes.find(n => n.relativePath === 'c.md')!.workingDir).toBe(child)
  })

  it("skips unknown, missing, drive-root projects and Claude's own data", async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'a.md', 'x')
    write(t.paths.claudeDir, 'projects\\X\\memory\\MEMORY.md', 'x') // Claude's own data lives under the fixture root
    write(t.paths.tempClaudeDir, 'X\\scratch.md', 'x')
    const home = t.root // a "home folder" project that contains ~\.claude
    write(home, 'home-note.md', 'x')
    const { notes } = await index(t).findNotes(
      [project(a), project('Z:\\does\\not\\exist'), project('D--GIT-X', false), project('C:\\'), project(home)])
    expect(notes.some(n => n.path.toLowerCase().startsWith(t.paths.claudeDir.toLowerCase()))).toBe(false)
    expect(notes.some(n => n.path.toLowerCase().startsWith(t.paths.tempClaudeDir.toLowerCase()))).toBe(false)
    expect(notes.some(n => n.workingDir === 'C:\\')).toBe(false)
    expect(notes.some(n => n.relativePath === 'a.md' && n.workingDir === a)).toBe(true)
    expect(notes.some(n => n.relativePath === 'home-note.md' && n.workingDir === home)).toBe(true)
  })

  it('skips Windows and Program Files projects', async () => {
    const t = tree()
    const sys = defaultSystemFolders()
    expect(sys.length).toBeGreaterThan(0)
    const win = sys[0]!
    const { notes } = await index(t).findNotes([...sys, join(win, 'System32')].map(d => project(d)))
    expect(notes).toEqual([])
  })

  it('skips projects under injected system folders', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'a.md', 'x')
    const { notes } = await index(t, { systemFolders: [join(t.root, 'work')] }).findNotes([project(a)])
    expect(notes).toEqual([])
  })

  it('stops walking a huge project and reports it as truncated', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'top.md', 'x')
    for (let i = 0; i < 10; i++) mkdirSync(join(a, `d${i}`))
    const { notes, truncated } = await index(t, { maxDirsPerProject: 3 }).findNotes([project(a)])
    expect(notes.some(n => n.relativePath === 'top.md')).toBe(true)
    expect(truncated).toEqual([a])
  })

  it('scans duplicate and case-variant projects once', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'a.md', 'x')
    const { notes } = await index(t).findNotes([project(a), project(a.toUpperCase() + '\\')])
    expect(notes).toHaveLength(1)
  })

  it('resolves .. before matching', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'a.md', 'x')
    const { notes } = await index(t).findNotes([project(a), project(join(a, 'sub') + '\\..')])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.workingDir).toBe(a)
    // and a path that resolves into Claude's own data is still refused
    const intoClaude = a + '\\..\\..\\.claude'
    expect((await index(t).findNotes([project(intoClaude)])).notes).toEqual([])
  })

  it('does not follow folder junctions', async () => {
    const t = tree()
    const a = t.workDir('A')
    const outside = t.workDir('Outside')
    write(outside, 'secret.md', 'x')
    write(a, 'a.md', 'x')
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(a, 'link'), outside], { windowsHide: true, stdio: 'ignore' })
    const { notes } = await index(t).findNotes([project(a)])
    expect(rels(notes)).toEqual(['a.md'])
    rmSync(join(a, 'link'), { force: true, recursive: false })
  })

  it('asks the cloud check once per scan and marks the files it names', async () => {
    const t = tree()
    const a = t.workDir('A')
    const cloud = write(a, 'cloud.md', 'flint')
    write(a, 'local.md', 'flint')
    const calls: string[][] = []
    const check: CloudOnlyCheck = async files => { calls.push([...files]); return new Set([cloud]) }
    const { notes } = await index(t, { cloudOnly: check }).findNotes([project(a)])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.length).toBe(2)
    expect(notes.find(n => n.relativePath === 'cloud.md')!.cloudOnly).toBe(true)
    expect(notes.find(n => n.relativePath === 'local.md')!.cloudOnly).toBe(false)
  })

  it('a failing cloud check marks every file cloud-only (never read when unsure)', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'x.md', 'flint')
    const { notes } = await index(t, { cloudOnly: async () => { throw new Error('boom') } }).findNotes([project(a)])
    expect(notes[0]!.cloudOnly).toBe(true)
  })

  it('rejects when aborted', async () => {
    const t = tree()
    const a = t.workDir('A')
    const ac = new AbortController(); ac.abort()
    await expect(index(t).findNotes([project(a)], ac.signal)).rejects.toThrow()
  })
})

describe('NoteIndex.search', () => {
  it('lists but never reads online-only cloud files', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'cloud.md', 'flint')
    const idx = index(t)
    const note = { ...(await idx.findNotes([project(a)])).notes[0]!, cloudOnly: true }
    expect(await idx.search([note], 'flint')).toEqual([])
    expect(await idx.search([note], 'cloud')).toHaveLength(1) // file name still matches
  })

  it('re-checks cloud state at search time, once per search, and skips files that became cloud-only', async () => {
    const t = tree()
    const a = t.workDir('A')
    const f = write(a, 'a.md', 'flint')
    write(a, 'b.md', 'flint')
    let calls = 0
    let cloud = new Set<string>()
    const idx = index(t, { cloudOnly: async () => { calls++; return cloud } })
    const { notes } = await idx.findNotes([project(a)])
    calls = 0
    cloud = new Set([f])
    const hits = await idx.search(notes, 'flint')
    expect(calls).toBe(1)
    expect(hits.map(h => h.note.relativePath)).toEqual(['b.md'])
  })

  it('counts matching lines and reports the first', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'router.md', '# Notes\nnothing here\nThe FLINT router at 10.0.0.1\nmore flint\n')
    write(a, 'other.md', 'unrelated')
    const idx = index(t)
    const hits = await idx.search((await idx.findNotes([project(a)])).notes, 'flint')
    expect(hits).toHaveLength(1)
    const h = hits[0]!
    expect(h.note.relativePath).toBe('router.md')
    expect(h.matchCount).toBe(2)
    expect(h.firstLineNumber).toBe(3)
    expect(h.firstLineText).toBe('The FLINT router at 10.0.0.1')
    expect(h.nameMatch).toBe(false)
  })

  it('counts lines across CRLF endings', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'n.md', 'a\r\nb\r\n  flint here  \r\n')
    const idx = index(t)
    const [h] = await idx.search((await idx.findNotes([project(a)])).notes, 'FLINT')
    expect(h!.firstLineNumber).toBe(3)
    expect(h!.firstLineText).toBe('flint here')
  })

  it('matches the file name even without a content hit', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'PARKING-plan.md', 'no keyword inside')
    const idx = index(t)
    const hits = await idx.search((await idx.findNotes([project(a)])).notes, 'parking')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.matchCount).toBe(0)
    expect(hits[0]!.nameMatch).toBe(true)
  })

  it('an empty query returns every note', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, '1.md', 'a'); write(a, '2.md', 'b')
    const idx = index(t)
    expect(await idx.search((await idx.findNotes([project(a)])).notes, '  ')).toHaveLength(2)
  })

  it('skips files over the size cap and unreadable files', async () => {
    const t = tree()
    const a = t.workDir('A')
    write(a, 'big.md', 'x'.repeat(MAX_NOTE_BYTES) + ' flint')
    const gone = write(a, 'gone.md', 'flint')
    write(a, 'ok.md', 'flint')
    const idx = index(t)
    const { notes } = await idx.findNotes([project(a)])
    rmSync(gone) // Node can't hold a file locked; a file that vanished after the scan is the unreadable case
    const hits = await idx.search(notes, 'flint')
    expect(hits.map(h => h.note.relativePath)).toEqual(['ok.md'])
  })

  it('a file that grew past the cap since the scan is matched by name only', async () => {
    const t = tree()
    const a = t.workDir('A')
    const f = write(a, 'flint-grew.md', 'flint')
    const idx = index(t)
    const { notes } = await idx.findNotes([project(a)])
    writeFileSync(f, 'x'.repeat(MAX_NOTE_BYTES + 1) + ' flint')
    const hits = await idx.search(notes, 'flint')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.matchCount).toBe(0)
    expect(hits[0]!.nameMatch).toBe(true)
  })

  it('reports progress and honours cancellation', async () => {
    const t = tree()
    const a = t.workDir('A')
    for (let i = 0; i < 60; i++) write(a, `n${i}.md`, 'flint')
    const idx = index(t)
    const { notes } = await idx.findNotes([project(a)])
    const ac = new AbortController()
    let reported = 0
    await expect(idx.search(notes, 'flint', () => { if (++reported === 1) ac.abort() }, ac.signal)).rejects.toThrow()
    expect(reported).toBeGreaterThanOrEqual(1)
    expect(reported).toBeLessThanOrEqual(59)
  })
})

describe('NoteIndex.deleteNotes', () => {
  it('removes .md notes once each, refuses other files, reports failures and carries on', async () => {
    const t = tree()
    const a = t.workDir('A')
    const md = write(a, 'a.md', 'x')
    const txt = write(a, 'b.txt', 'x')
    const missing = join(a, 'missing.md')
    const note = (p: string): NoteFile => ({ path: p, workingDir: a, relativePath: p.slice(a.length + 1), modified: 0, sizeBytes: 1, cloudOnly: false })
    const removed: string[] = []
    const remover: FileRemover = { ...permanentRemover, removeFile: async p => { removed.push(p); await permanentRemover.removeFile(p) } }
    const r = await NoteIndex.deleteNotes([note(md), note(md.toUpperCase()), note(txt), note(missing)], remover)
    expect(r.done).toEqual([md])
    expect(removed).toEqual([md, missing])
    expect(r.failures.map(f => f.path)).toEqual([txt, missing])
    expect(r.failures[0]!.error).toBe('Not a .md file.')
    expect(existsSync(md)).toBe(false)
    expect(existsSync(txt)).toBe(true)
  })
})

describe('oneDriveCloudCheck', () => {
  it('reads the OneDrive roots from the environment', () => {
    expect(oneDriveRoots({ OneDrive: 'C:\\Users\\x\\OneDrive', OneDriveConsumer: 'c:/users/x/onedrive', OneDriveCommercial: '' }))
      .toEqual(['C:\\Users\\x\\OneDrive'])
    expect(oneDriveRoots({})).toEqual([])
  })

  it('never runs PowerShell for files outside OneDrive', async () => {
    let ran = 0
    const check = oneDriveCloudCheck(() => ['C:\\OneDrive'], async () => { ran++; return 'done\n' })
    expect(await check(['D:\\x\\a.md'])).toEqual(new Set())
    expect(await oneDriveCloudCheck(() => [], async () => { ran++; return 'done\n' })(['C:\\OneDrive\\a.md'])).toEqual(new Set())
    expect(ran).toBe(0)
  })

  it('batches the candidates into one query and maps the indices back', async () => {
    const inputs: string[] = []
    const check = oneDriveCloudCheck(() => ['C:\\OneDrive'], async (_script, input) => { inputs.push(input); return '1\r\ndone\r\n' })
    const r = await check(['C:\\OneDrive\\a.md', 'D:\\other.md', 'C:\\onedrive\\sub\\b.md'])
    expect(inputs).toEqual(['C:\\OneDrive\\a.md\nC:\\onedrive\\sub\\b.md\n'])
    expect(r).toEqual(new Set(['C:\\onedrive\\sub\\b.md']))
  })

  it('treats every candidate as cloud-only when the query fails or is cut short', async () => {
    const files = ['C:\\OneDrive\\a.md', 'C:\\OneDrive\\b.md']
    expect(await oneDriveCloudCheck(() => ['C:\\OneDrive'], async () => { throw new Error('no powershell') })(files))
      .toEqual(new Set(files))
    expect(await oneDriveCloudCheck(() => ['C:\\OneDrive'], async () => '0\n')(files)).toEqual(new Set(files))
  })

  it.runIf(process.platform === 'win32')('the real PowerShell query spots the Offline attribute', async () => {
    const t = tree()
    const a = t.workDir('Cloud é')
    const offline = write(a, 'offline é.md', 'x')
    const local = write(a, 'local.md', 'x')
    const missing = join(a, 'missing.md')
    execFileSync('attrib', ['+O', offline], { windowsHide: true })
    const r = await oneDriveCloudCheck(() => [a])([offline, local, missing])
    expect(r).toEqual(new Set([offline, missing])) // can't check -> counted as cloud-only
  }, 60_000)
})
