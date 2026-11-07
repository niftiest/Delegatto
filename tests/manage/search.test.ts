import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scanProjects } from '../../src/main/manage/scanner'
import { MatchSource, matchPath, matchPlaces, searchContent, forEachLine } from '../../src/main/manage/search'
import { FakeClaudeTree } from './fake-tree'

const trees: FakeClaudeTree[] = []
function tree(): FakeClaudeTree { const t = new FakeClaudeTree(); trees.push(t); return t }
afterEach(() => { while (trees.length > 0) trees.pop()!.dispose() })

describe('search', () => {
  it('finds a word in a memory-only project', async () => {
    const t = tree()
    t.addSession('D:\\GIT\\A', 's1'); t.addMemory('D:\\GIT\\A', 'm.md', 'the Flint note')
    t.addSession('D:\\GIT\\B', 's2')
    const r = await searchContent(await scanProjects(t.paths), 'flint')
    expect(r.get('D:\\GIT\\A')).toBe(MatchSource.Memory)
    expect(r.has('D:\\GIT\\B')).toBe(false)
  })

  it('finds a word in a chat and reports it', async () => {
    const t = tree()
    t.addSession('D:\\GIT\\A', 's1', '{"type":"user","text":"hello Zebra there"}')
    const reported: [string, MatchSource][] = []
    const r = await searchContent(await scanProjects(t.paths), 'zebra', (wd, src) => reported.push([wd, src]))
    expect(r.get('D:\\GIT\\A')).toBe(MatchSource.Chat)
    expect(reported).toEqual([['D:\\GIT\\A', MatchSource.Chat]])
  })

  it('reports both memory and chat', async () => {
    const t = tree()
    t.addSession('D:\\GIT\\A', 's1', '{"text":"needle"}')
    const mem = t.addMemory('D:\\GIT\\A', 'MEMORY.md', 'index')
    mkdirSync(join(dirname(mem), 'sub'))
    writeFileSync(join(dirname(mem), 'sub', 'x.md'), 'NEEDLE') // memory is searched recursively
    const src = (await searchContent(await scanProjects(t.paths), 'needle')).get('D:\\GIT\\A')!
    expect(src).toBe(MatchSource.Memory | MatchSource.Chat)
    expect(matchPlaces(src)).toEqual(['memory', 'chat'])
  })

  it('a match must sit on one line', async () => {
    const t = tree()
    t.addSession('D:\\GIT\\A', 's1', '{"text":"abc"}', '{"text":"def"}')
    expect((await searchContent(await scanProjects(t.paths), 'abc"}\n{"')).size).toBe(0)
  })

  it('path match is case-insensitive', async () => {
    const t = tree(); t.addSession('D:\\GIT\\ConnectionOptimization', 's1')
    const [p, ...rest] = await scanProjects(t.paths)
    expect(rest).toEqual([])
    expect(matchPath(p!, 'connection')).toBe(MatchSource.Path)
    expect(matchPath(p!, 'D--GIT-conn')).toBe(MatchSource.Path)
    expect(matchPath(p!, 'nomatch')).toBe(MatchSource.None)
    expect(matchPath(p!, '')).toBe(MatchSource.None)
    expect(matchPlaces(MatchSource.Path)).toEqual(['path'])
  })

  it('an empty query finds nothing', async () => {
    const t = tree(); t.addSession('D:\\GIT\\A', 's1')
    expect((await searchContent(await scanProjects(t.paths), '')).size).toBe(0)
  })

  it('an already-aborted signal rejects', async () => {
    const t = tree(); t.addSession('D:\\GIT\\A', 's1')
    const ps = await scanProjects(t.paths)
    const ac = new AbortController(); ac.abort()
    await expect(searchContent(ps, 'x', undefined, ac.signal)).rejects.toThrow()
  })

  it('aborting during the scan stops the remaining projects', async () => {
    const t = tree()
    const n = 60
    for (let i = 0; i < n; i++) { const d = 'D:\\GIT\\P' + i; t.addSession(d, 's' + i); t.addMemory(d, 'm.md', 'needle') }
    const ps = await scanProjects(t.paths)
    const ac = new AbortController()
    let count = 0
    await expect(searchContent(ps, 'needle', () => { count++; ac.abort() }, ac.signal)).rejects.toThrow()
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(n - 1)
  })
})

describe('forEachLine', () => {
  it('splits LF and CRLF, drops a BOM, keeps a last line without newline, handles long lines', async () => {
    const t = tree()
    const f = join(t.root, 'x.txt')
    const long = 'y'.repeat(300_000)
    writeFileSync(f, '\uFEFFa\r\nb\n' + long + '\nlast')
    const lines: string[] = []
    await forEachLine(f, l => { lines.push(l) })
    expect(lines).toEqual(['a', 'b', long, 'last'])
  })

  it('stops when the callback returns false', async () => {
    const t = tree()
    const f = join(t.root, 'x.txt')
    writeFileSync(f, '1\n2\n3\n')
    const lines: string[] = []
    await forEachLine(f, l => { lines.push(l); return l !== '2' })
    expect(lines).toEqual(['1', '2'])
  })
})
