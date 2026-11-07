import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMemoryFiles, readMemoryFile, writeMemoryFile } from '../src/main/project-memory'
import { SessionPool } from '../src/main/engine/pool'
import type { LiveEvent } from '../src/shared/engine-types'

let root: string
let cwd: string
let projectDir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-mem-'))
  cwd = join(root, 'proj')
  projectDir = join(root, 'claude-project')
  mkdirSync(cwd, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('project memory files', () => {
  it('offers the two instruction files to create, and lists what exists', () => {
    expect(listMemoryFiles(cwd, projectDir).map(f => [f.id, f.exists])).toEqual([['project', false], ['local', false]])
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'CLAUDE.md'), 'x')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'y')
    mkdirSync(join(projectDir, 'memory'), { recursive: true })
    for (const n of ['a-note.md', 'MEMORY.md', 'skip.txt']) writeFileSync(join(projectDir, 'memory', n), n)
    expect(listMemoryFiles(cwd, projectDir).map(f => [f.id, f.exists])).toEqual([
      ['project', true], ['project-dir', true], ['local', false], ['memory:MEMORY.md', true], ['memory:a-note.md', true]
    ])
  })

  it('still shows auto memory when the project\'s folder is unknown', () => {
    mkdirSync(join(projectDir, 'memory'), { recursive: true })
    writeFileSync(join(projectDir, 'memory', 'MEMORY.md'), 'm')
    expect(listMemoryFiles(null, projectDir).map(f => f.id)).toEqual(['memory:MEMORY.md'])
  })

  it('creates a new file and edits an existing one', () => {
    const empty = readMemoryFile(cwd, projectDir, 'project')
    expect(empty).toEqual({ text: '', mtimeMs: null })
    const saved = writeMemoryFile(cwd, projectDir, 'project', 'first', empty.mtimeMs)
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('first')
    writeMemoryFile(cwd, projectDir, 'project', 'second', saved.mtimeMs)
    expect(readMemoryFile(cwd, projectDir, 'project').text).toBe('second')
  })

  it('refuses to save over a file that changed since it was read', () => {
    const before = writeMemoryFile(cwd, projectDir, 'project', 'mine', null)
    writeFileSync(join(cwd, 'CLAUDE.md'), 'claude wrote this')
    utimesSync(join(cwd, 'CLAUDE.md'), new Date(), new Date(Date.now() + 5000))
    expect(() => writeMemoryFile(cwd, projectDir, 'project', 'lost', before.mtimeMs)).toThrow(/changed on disk/)
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('claude wrote this')
    expect(() => writeMemoryFile(cwd, projectDir, 'project', 'x', null)).toThrow(/changed on disk/)
  })

  it('reaches nothing outside the list', () => {
    writeFileSync(join(root, 'secret.md'), 's')
    for (const id of ['../secret.md', 'memory:../../secret.md', 'memory:nope.md', join(root, 'secret.md')]) {
      expect(() => readMemoryFile(cwd, projectDir, id)).toThrow(/no longer available/)
      expect(() => writeMemoryFile(cwd, projectDir, id, 'x', null)).toThrow(/no longer available/)
    }
    expect(readFileSync(join(root, 'secret.md'), 'utf8')).toBe('s')
  })
})

describe('restarting a chat after its memory changed', () => {
  function pool() {
    const made: Array<{ closed: number; emit: (e: LiveEvent) => void; exit: () => void }> = []
    const p = new SessionPool({
      idleReapMs: 100000,
      transportFactory: () => {
        let cb: (e: LiveEvent) => void = () => {}
        const exits: Array<(c: number | null) => void> = []
        const t = { closed: 0, emit: (e: LiveEvent) => cb(e), exit: () => { for (const f of exits) f(0) } }
        made.push(t)
        return { start() {}, send() {}, on(f: (e: LiveEvent) => void) { cb = f }, onExit(f: (c: number | null) => void) { exits.push(f) }, interrupt() {}, close() { t.closed++ }, pid: 1 } as never
      }
    })
    return { p, made }
  }
  const spec = { cwd: 'c', skipPermissions: false, resumeId: 'r' }
  const done: LiveEvent = { kind: 'result', isError: false, costUsd: 0, text: '' }

  it('replaces a process on the next message, letting a reply in progress finish', () => {
    const { p, made } = pool()
    p.send('idle', spec, {})
    made[0]!.emit(done)
    p.send('busy', spec, {})
    expect(p.restartForReload('idle')).toBe('restarted')
    expect(p.restartForReload('busy')).toBe('afterTurn')
    expect(p.restartForReload('none')).toBe('none')
    expect(made[0]!.closed).toBe(0)
    expect(made[1]!.closed).toBe(0)
    p.send('idle', spec, {})
    expect(made[0]!.closed).toBe(1)
    made[0]!.exit()
    expect(made).toHaveLength(3)
    made[1]!.emit(done)
    p.send('busy', spec, {})
    expect(made[1]!.closed).toBe(1)
    made[1]!.exit()
    expect(made).toHaveLength(4)
    p.send('busy', spec, {})
    expect(made).toHaveLength(4) // only once
  })
})
