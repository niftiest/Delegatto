import { describe, expect, it } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { upsertProject, upsertSession } from '../src/main/catalog/repos'
import { searchProject } from '../src/main/catalog/search'
import { excerptAround, findTermRanges, searchTerms } from '../src/shared/project-search'

function seed() {
  const db = openCatalog(':memory:')
  const session = (project: number, id: string, kind: 'main' | 'subagent', title: string) =>
    upsertSession(db, { projectId: project, sessionId: id, kind, filePath: `/f/${id}.jsonl`, fileSize: 1, fileMtimeMs: 1, title })
  const a = upsertProject(db, 'C--A')
  const b = upsertProject(db, 'C--B')
  const chat1 = session(a, 'chat1', 'main', 'First chat')
  const chat2 = session(a, 'chat2', 'main', 'Second chat')
  const other = session(b, 'other', 'main', 'Other project')
  const agent = session(a, 'agent', 'subagent', 'A subagent')
  let seq = 0
  const add = (s: number, role: string, text: string | null, ts: string, sidechain = 0): void => {
    seq++
    db.prepare('INSERT INTO messages (session_pk,uuid,seq,role,is_sidechain,ts,byte_offset,text) VALUES (?,?,?,?,?,?,?,?)')
      .run(s, `u${seq}`, seq, role, sidechain, ts, seq, text)
  }
  add(chat1, 'user', 'please fix config.py for me', '2026-01-01T10:00:00Z')
  add(chat1, 'assistant', 'I changed the CONFIG loader', '2026-01-01T10:01:00Z')
  add(chat2, 'user', 'what about 100% coverage_report?', '2026-01-02T10:00:00Z')
  add(chat2, 'assistant', 'the loader config is in another file', '2026-01-02T10:01:00Z')
  add(other, 'user', 'config in a different project', '2026-01-03T10:00:00Z')
  add(agent, 'assistant', 'config from a subagent', '2026-01-03T10:00:00Z')
  add(chat1, 'assistant', 'config in a sidechain', '2026-01-03T10:00:00Z', 1)
  add(chat1, 'user', '<task-notification>config</task-notification>', '2026-01-03T10:00:00Z')
  add(chat1, 'assistant', null, '2026-01-03T10:00:00Z')
  return { db, a, chat1, chat2 }
}

describe('searchProject', () => {
  it("finds this project's own chat messages only, oldest first, ignoring case", () => {
    const { db, a, chat1, chat2 } = seed()
    const { hits, total } = searchProject(db, a, 'config')
    expect(total).toBe(3)
    expect(hits.map(h => h.text)).toEqual(['please fix config.py for me', 'I changed the CONFIG loader', 'the loader config is in another file'])
    expect(hits.map(h => h.sessionPk)).toEqual([chat1, chat1, chat2])
    expect(hits[0]).toMatchObject({ role: 'user', title: 'First chat', trimmed: false })
  })

  it('matches parts of words and takes punctuation literally', () => {
    const { db, a } = seed()
    expect(searchProject(db, a, 'conf').total).toBe(3)
    expect(searchProject(db, a, 'config.py').total).toBe(1)
    expect(searchProject(db, a, 'configxpy').total).toBe(0)
  })

  it("doesn't treat % or _ as wildcards", () => {
    const { db, a } = seed()
    expect(searchProject(db, a, '100%').total).toBe(1)
    expect(searchProject(db, a, 'coverage_report').total).toBe(1)
    expect(searchProject(db, a, 'coverage%report').total).toBe(0)
    expect(searchProject(db, a, 'fi_').total).toBe(0)
    expect(searchProject(db, a, '\\').total).toBe(0)
  })

  it('needs every word, in any order', () => {
    const { db, a } = seed()
    expect(searchProject(db, a, 'loader config').total).toBe(2)
    expect(searchProject(db, a, 'config fix').total).toBe(1)
    expect(searchProject(db, a, 'config zebra').total).toBe(0)
  })

  it('finds nothing for an empty search', () => {
    const { db, a } = seed()
    expect(searchProject(db, a, '   ')).toEqual({ hits: [], total: 0 })
  })

  it('keeps the newest when there are too many, still oldest first, and counts them all', () => {
    const { db, a } = seed()
    const { hits, total } = searchProject(db, a, 'config', 2)
    expect(total).toBe(3)
    expect(hits.map(h => h.ts)).toEqual(['2026-01-01T10:01:00Z', '2026-01-02T10:01:00Z'])
  })

  it('cuts a long message down to the match', () => {
    const { db, a } = seed()
    const long = `${'x'.repeat(9000)} needle ${'y'.repeat(9000)}`
    const s = upsertSession(db, { projectId: a, sessionId: 'long', kind: 'main', filePath: '/f/long.jsonl', fileSize: 1, fileMtimeMs: 1 })
    db.prepare('INSERT INTO messages (session_pk,uuid,seq,role,ts,byte_offset,text) VALUES (?,?,?,?,?,?,?)').run(s, 'long1', 1, 'user', null, 0, long)
    const [hit] = searchProject(db, a, 'needle').hits
    expect(hit).toMatchObject({ trimmed: true })
    expect(hit!.text).toContain('needle')
    expect(hit!.text.length).toBeLessThan(4100)
  })
})

describe('search helpers', () => {
  it('splits a search into distinct words', () => {
    expect(searchTerms('  foo   bar foo ')).toEqual(['foo', 'bar'])
    expect(searchTerms('')).toEqual([])
  })

  it('finds every match, ignoring case', () => {
    expect(findTermRanges('Foo foo bar', ['foo'])).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }])
  })

  it("marks nothing when lower-casing would misplace the matches", () => {
    expect(findTermRanges('İstanbul foo', ['foo'])).toEqual([])
  })

  it('leaves a short message whole and copes with a long one with no match', () => {
    expect(excerptAround('short', ['x'])).toEqual({ text: 'short', trimmed: false })
    const { text, trimmed } = excerptAround('z'.repeat(5000), ['q'], 100)
    expect(trimmed).toBe(true)
    expect(text.startsWith('z')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })

  it('marks both ends of a cut from the middle', () => {
    const { text } = excerptAround(`${'a'.repeat(500)}hit${'b'.repeat(500)}`, ['hit'], 100)
    expect(text.startsWith('…')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
    expect(text).toContain('hit')
  })
})
