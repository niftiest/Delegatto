import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { upsertProject, upsertSession } from '../src/main/catalog/repos'
import { forkTranscript, promptHistory, replaceSessionId, titleRow } from '../src/main/engine/chat-actions'
import { filterHistory, stepHistory } from '../src/renderer/prompt-history'
import { isForkCommand, nextPermissionMode, renameCommandOf, sideQuestionOf, suggestionLabel } from '../src/renderer/lib'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-chat-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('naming and forking a chat', () => {
  it('writes the row Claude Code reads a name from', () => {
    expect(JSON.parse(titleRow('s1', 'My chat'))).toEqual({ type: 'custom-title', customTitle: 'My chat', sessionId: 's1' })
  })

  it('replaces the id only where it names the session', () => {
    expect(replaceSessionId('{"sessionId":"a","text":"a","session_id":"a"}', 'a', 'b')).toBe('{"sessionId":"b","text":"a","session_id":"b"}')
  })

  it('copies the chat under a new id, with what sits beside it, named as a fork', async () => {
    const file = join(dir, 'old.jsonl')
    writeFileSync(file, '{"sessionId":"old","n":1}\n{"sessionId":"old","n":2}\n')
    mkdirSync(join(dir, 'old', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'old', 'subagents', 'a.jsonl'), 'x')
    const out = await forkTranscript(file, 'old', 'new', 'Mine (fork)')
    const lines = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(out).toBe(join(dir, 'new.jsonl'))
    expect(lines[0]).toEqual({ sessionId: 'new', n: 1 })
    expect(lines.at(-1)).toEqual({ type: 'custom-title', customTitle: 'Mine (fork)', sessionId: 'new' })
    expect(existsSync(join(dir, 'new', 'subagents', 'a.jsonl'))).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('"sessionId":"old"')
  })

  it('leaves behind a last line still being written', async () => {
    const file = join(dir, 'old.jsonl')
    writeFileSync(file, '{"sessionId":"old"}\n{"sessionId":"ol')
    const out = await forkTranscript(file, 'old', 'new', 'T')
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})

describe('what was typed', () => {
  function seeded() {
    const db = openCatalog(':memory:')
    const p = upsertProject(db, 'p')
    const other = upsertProject(db, 'q')
    const a = upsertSession(db, { projectId: p, sessionId: 'a', kind: 'main', filePath: '/a.jsonl', fileSize: 1, fileMtimeMs: 1 })
    const b = upsertSession(db, { projectId: p, sessionId: 'b', kind: 'main', filePath: '/b.jsonl', fileSize: 1, fileMtimeMs: 1 })
    const c = upsertSession(db, { projectId: other, sessionId: 'c', kind: 'main', filePath: '/c.jsonl', fileSize: 1, fileMtimeMs: 1 })
    const add = db.prepare('INSERT INTO messages (session_pk,uuid,seq,role,is_sidechain,ts,byte_offset,text) VALUES (?,?,?,?,?,?,0,?)')
    add.run(a, 'u1', 1, 'user', 0, '2026-01-01', 'first thing')
    add.run(b, 'u2', 1, 'user', 0, '2026-01-02', 'second thing')
    add.run(a, 'u3', 2, 'user', 0, '2026-01-03', 'first thing')
    add.run(a, 'u4', 3, 'assistant', 0, '2026-01-04', 'a reply')
    add.run(a, 'u5', 4, 'user', 0, '2026-01-05', '<system-reminder>not typed')
    add.run(a, 'u6', 5, 'user', 1, '2026-01-06', 'a subagent prompt')
    add.run(c, 'u7', 1, 'user', 0, '2026-01-07', 'another project')
    return { db, a }
  }

  it('covers every chat in the project, newest first, each once, and nothing nobody typed', () => {
    const { db, a } = seeded()
    expect(promptHistory(db, a)).toEqual(['first thing', 'second thing'])
  })

  it('steps back and forward, ending at the draft', () => {
    const list = ['newest', 'older']
    expect(stepHistory(list, -1, 'older')).toEqual({ at: 0, text: 'newest' })
    expect(stepHistory(list, 0, 'older')).toEqual({ at: 1, text: 'older' })
    expect(stepHistory(list, 1, 'older')).toBeNull()
    expect(stepHistory(list, 1, 'newer')).toEqual({ at: 0, text: 'newest' })
    expect(stepHistory(list, 0, 'newer')).toEqual({ at: -1, text: '' })
    expect(stepHistory(list, -1, 'newer')).toBeNull()
  })

  it('searches by every word typed, ignoring case', () => {
    const list = ['Fix the Login page', 'login tests', 'page layout']
    expect(filterHistory(list, 'LOGIN page')).toEqual(['Fix the Login page'])
    expect(filterHistory(list, '')).toEqual(list)
  })
})

describe('commands the app handles itself', () => {
  it('reads /btw, /rename and /fork', () => {
    expect(sideQuestionOf('/btw what time is it')).toBe('what time is it')
    expect(sideQuestionOf('/btw')).toBeNull()
    expect(sideQuestionOf('tell me /btw x')).toBeNull()
    expect(renameCommandOf('/rename New name')).toBe('New name')
    expect(renameCommandOf('/rename')).toBeNull()
    expect(isForkCommand('/fork')).toBe(true)
    expect(isForkCommand('/fork please')).toBe(false)
  })

  it('goes through the modes in order, and starts again from one outside the list', () => {
    expect(nextPermissionMode('default')).toBe('acceptEdits')
    expect(nextPermissionMode('acceptEdits')).toBe('plan')
    expect(nextPermissionMode('bypassPermissions')).toBe('default')
    expect(nextPermissionMode('auto')).toBe('default')
  })

  it('says what "do not ask again" adds', () => {
    expect(suggestionLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }, { toolName: 'Read' }] }, { type: 'addDirectories', directories: ['C:\\x'] }, { type: 'setMode', mode: 'plan' }])).toBe('Bash(ls:*), Read, access to C:\\x')
    expect(suggestionLabel([])).toBeNull()
  })
})
