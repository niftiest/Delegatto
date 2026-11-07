import { describe, it, expect } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { upsertProject, setProjectCwd, projectFolderFor, repairProjectCwds, upsertSession, listProjects, listSessions, listSubagents, sumTotalCostUsd } from '../src/main/catalog/repos'
import { search } from '../src/main/catalog/search'

function seed() {
  const db = openCatalog(':memory:')
  const p = upsertProject(db, 'C--Users-x-GIT-Demo')
  setProjectCwd(db, p, 'C:\\Users\\x\\GIT\\Demo')
  const s = upsertSession(db, {
    projectId: p, sessionId: 'sess-1', kind: 'main', filePath: '/f/sess-1.jsonl',
    fileSize: 10, fileMtimeMs: 1, title: 'Fix pagination', lastTs: '2026-07-23T10:00:00Z'
  })
  db.prepare("INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text) VALUES (?,?,?,?,?,?)")
    .run(s, 'u1', 0, 'user', 0, 'the scraper stops at page three')
  db.prepare("UPDATE sessions SET message_count = 1 WHERE id = ?").run(s)
  return { db, p, s }
}

describe('repos', () => {
  it('sumTotalCostUsd sums every session at its own model price (main + subagent)', () => {
    const db = openCatalog(':memory:')
    const p = upsertProject(db, 'C--x')
    const m = upsertSession(db, { projectId: p, sessionId: 'm', kind: 'main', filePath: '/f/m.jsonl', fileSize: 1, fileMtimeMs: 1, model: 'opus' })
    const a = upsertSession(db, { projectId: p, sessionId: 'a', kind: 'subagent', filePath: '/f/a.jsonl', fileSize: 1, fileMtimeMs: 1, model: 'sonnet', toolUseId: 't1' })
    db.prepare('UPDATE sessions SET input_tokens=? WHERE id=?').run(1_000_000, m)   // opus input: $4
    db.prepare('UPDATE sessions SET output_tokens=? WHERE id=?').run(1_000_000, a)  // sonnet output: $10
    expect(sumTotalCostUsd(db)).toBeCloseTo(14, 5)
  })

  it('sumTotalCostUsd is 0 for an empty catalog', () => {
    expect(sumTotalCostUsd(openCatalog(':memory:'))).toBe(0)
  })

  it('upsertProject is idempotent', () => {
    const { db, p } = seed()
    expect(upsertProject(db, 'C--Users-x-GIT-Demo')).toBe(p)
    expect(listProjects(db)).toHaveLength(1)
  })

  it('lists projects with session counts and cwd', () => {
    const { db } = seed()
    const [proj] = listProjects(db)
    expect(proj!.cwd).toBe('C:\\Users\\x\\GIT\\Demo')
    expect(proj!.sessionCount).toBe(1)
  })

  it('includes a preview snippet of the most recent message', () => {
    const { db } = seed()
    const [proj] = listProjects(db)
    expect(proj!.preview).toBe('the scraper stops at page three')
  })

  it('preview is the newest message and excludes sidechain rows', () => {
    const { db, s } = seed()
    // A later real message must win the preview...
    db.prepare("INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text,ts) VALUES (?,?,?,?,?,?,?)")
      .run(s, 'a2', 1, 'assistant', 100, 'here is the newest reply', '2026-07-24T09:00:00Z')
    // ...and a still-later SIDECHAIN row must NOT, even though it is newest.
    db.prepare("INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text,ts,is_sidechain) VALUES (?,?,?,?,?,?,?,1)")
      .run(s, 'sc', 2, 'assistant', 200, 'subagent chatter', '2026-07-24T10:00:00Z')
    const [proj] = listProjects(db)
    expect(proj!.preview).toBe('here is the newest reply')
  })

  it('preview is null for a project with no text messages', () => {
    const db = openCatalog(':memory:')
    const p = upsertProject(db, 'C--empty')
    upsertSession(db, { projectId: p, sessionId: 'e1', kind: 'main', filePath: '/f/e1.jsonl', fileSize: 1, fileMtimeMs: 1 })
    const [proj] = listProjects(db)
    expect(proj!.preview).toBeNull()
  })

  it('lists sessions newest activity first', () => {
    const { db, p } = seed()
    upsertSession(db, { projectId: p, sessionId: 'sess-2', kind: 'main', filePath: '/f/sess-2.jsonl', fileSize: 5, fileMtimeMs: 2, title: 'Older', lastTs: '2026-01-01T00:00:00Z' })
    expect(listSessions(db, p).map(s => s.sessionId)).toEqual(['sess-1', 'sess-2'])
  })

  it('finds subagents by their spawning toolUseId', () => {
    const { db, p } = seed()
    upsertSession(db, { projectId: p, sessionId: 'sess-1', kind: 'subagent', filePath: '/f/agent-a.jsonl', fileSize: 3, fileMtimeMs: 3, agentId: 'agent-a', toolUseId: 'toolu_01', agentType: 'general-purpose', agentDesc: 'Explore' })
    expect(listSubagents(db, 'toolu_01')).toHaveLength(1)
    expect(listSubagents(db, 'toolu_missing')).toEqual([])
  })

  it('full-text searches message bodies and returns a snippet', () => {
    const { db } = seed()
    const hits = search(db, 'scraper')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toContain('scraper')
    expect(search(db, 'nonexistentword')).toEqual([])
  })

  it('points a match in a subagent at the chat that ran it, which is the one that can open', () => {
    const { db, p, s } = seed()
    const agent = upsertSession(db, { projectId: p, sessionId: 'sess-1', kind: 'subagent', filePath: '/f/sess-1/agent-a.jsonl', fileSize: 3, fileMtimeMs: 3, agentId: 'agent-a', toolUseId: 'toolu_01' })
    db.prepare("INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text) VALUES (?,?,?,?,?,?)")
      .run(agent, 'sub1', 0, 'user', 0, 'the zebrafish report')
    const hits = search(db, 'zebrafish')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.sessionPk).toBe(s)
    expect(listSessions(db, p).map(x => x.id)).toContain(hits[0]!.sessionPk)
  })

  it('leaves out a subagent match whose chat is gone, since nothing could open it', () => {
    const { db, p } = seed()
    const agent = upsertSession(db, { projectId: p, sessionId: 'gone', kind: 'subagent', filePath: '/f/gone/agent-b.jsonl', fileSize: 3, fileMtimeMs: 3, agentId: 'agent-b', toolUseId: 'toolu_02' })
    db.prepare("INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text) VALUES (?,?,?,?,?,?)")
      .run(agent, 'sub2', 0, 'user', 0, 'the orphaned walrus')
    expect(search(db, 'walrus')).toEqual([])
  })

  it('does not throw on FTS syntax the user might type', () => {
    const { db } = seed()
    expect(() => search(db, 'page "three')).not.toThrow()
  })

  it('returns an empty array for empty or whitespace-only queries', () => {
    const { db } = seed()
    expect(search(db, '')).toEqual([])
    expect(search(db, '   ')).toEqual([])
  })

  it('does not throw on punctuation-only queries and returns no hits', () => {
    const { db } = seed()
    expect(search(db, '---')).toEqual([])
    expect(search(db, '***')).toEqual([])
    expect(search(db, '""')).toEqual([])
    expect(search(db, '()')).toEqual([])
  })

  it('treats a lone double quote as empty rather than FTS syntax', () => {
    const { db } = seed()
    expect(() => search(db, '"')).not.toThrow()
    expect(search(db, '"')).toEqual([])
  })

  it('still finds a real term when another token is only a stray quote', () => {
    const { db } = seed()
    // A naive implementation quotes every whitespace-separated term, including
    // one that is nothing but a `"` character. Stripped of its quote that term
    // is empty; wrapped as an empty `""` phrase and ANDed with the rest, it
    // would zero out the whole match even though "scraper" is right there.
    // The stray-quote term must be dropped instead of turned into a phrase.
    expect(search(db, 'scraper "')).toHaveLength(1)
    expect(search(db, '" scraper')).toHaveLength(1)
  })

  it('does not treat FTS boolean operators typed as words as query syntax', () => {
    const { db } = seed()
    // Bare terms like AND/OR/NOT/NEAR are FTS5 keywords; user prose containing
    // them as plain words must not be interpreted as boolean operators or throw.
    expect(() => search(db, 'AND OR NOT NEAR')).not.toThrow()
  })

  it('does not throw on terms containing FTS special characters like * ^ : -', () => {
    const { db } = seed()
    expect(() => search(db, 'scraper*')).not.toThrow()
    expect(() => search(db, '^scraper')).not.toThrow()
    expect(() => search(db, 'col:scraper')).not.toThrow()
    // A hyphen-prefixed real word must still be findable, not excluded as NOT.
    expect(search(db, '-scraper')).toHaveLength(1)
  })

  // The unicode61 tokenizer treats all punctuation as a separator, so a
  // whitespace-separated token made purely of punctuation tokenizes to zero
  // terms. Quoted, it becomes an empty FTS5 phrase; ANDed with a real term,
  // an empty phrase matches nothing and zeroes out the whole query even
  // though the real term is present. Each of these is ordinary human input
  // (`config.py --verbose`, `wait...`, `fix this !!!`, `the total (approx)`).
  it.each(['-', '*', '^', '(', '---', '!!!'])(
    'still finds a real term when paired with the punctuation-only token %j',
    (token) => {
      const { db } = seed()
      expect(search(db, `scraper ${token}`)).toHaveLength(1)
      expect(search(db, `${token} scraper`)).toHaveLength(1)
    }
  )

  it('returns an empty array without throwing for a query that is only punctuation', () => {
    const { db } = seed()
    expect(() => search(db, '!!! *** --- ^^^ ((()))')).not.toThrow()
    expect(search(db, '!!! *** --- ^^^ ((()))')).toEqual([])
  })

  it('keeps a term mixing punctuation with letters/digits as a phrase query', () => {
    const { db, s } = seed()
    db.prepare("INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text) VALUES (?,?,?,?,?,?)")
      .run(s, 'u2', 1, 'user', 100, 'run config.py --verbose to reproduce, foo_bar handles v2.1 fine')
    // Punctuation-plus-alphanumeric terms must survive: the tokenizer splits
    // them into multiple tokens internally, making the quoted term a phrase
    // query over adjacent tokens (e.g. "config.py" -> "config" NEAR "py"),
    // which still matches the indexed text correctly.
    expect(search(db, 'config.py')).toHaveLength(1)
    expect(search(db, '--verbose')).toHaveLength(1)
    expect(search(db, 'foo_bar')).toHaveLength(1)
    expect(search(db, 'v2.1')).toHaveLength(1)
  })

  it('treats non-ASCII letters as indexable rather than dropping the term', () => {
    const { db, s } = seed()
    db.prepare("INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text) VALUES (?,?,?,?,?,?)")
      .run(s, 'u3', 1, 'user', 100, 'the scraper needs 爬虫 fixed today')
    // An ASCII-only "is this indexable" check would treat a CJK term as having
    // no indexable characters and silently drop it, exactly like the
    // punctuation-only bug. \p{L}/\p{N} with the `u` flag must recognize it.
    expect(search(db, '爬虫')).toHaveLength(1)
    expect(search(db, 'scraper 爬虫')).toHaveLength(1)
  })
})

describe("a project's own folder", () => {
  const folder = (db: ReturnType<typeof openCatalog>, id: number) => (db.prepare('SELECT cwd FROM projects WHERE id = ?').get(id) as { cwd: string | null }).cwd

  it('stays the folder the chat started in after Claude moves into a subfolder', () => {
    const db = openCatalog(':memory:')
    const p = upsertProject(db, 'D--GIT-SockProxy')
    setProjectCwd(db, p, 'D:/GIT/SockProxy')
    setProjectCwd(db, p, 'D:/GIT/SockProxy/build/audit/sfw-1.14.4/extracted')
    expect(folder(db, p)).toBe('D:/GIT/SockProxy')
    setProjectCwd(db, p, '/d/GIT/SockProxy')
    expect(folder(db, p)).toBe('D:/GIT/SockProxy')
  })

  it('finds the project folder above a subfolder when that is all it has seen', () => {
    const db = openCatalog(':memory:')
    const p = upsertProject(db, 'D--GIT-SockProxy')
    setProjectCwd(db, p, 'D:/GIT/SockProxy/app/src')
    expect(folder(db, p)).toBe('D:/GIT/SockProxy')
    expect(projectFolderFor('D:/GIT/Other/x', 'D--GIT-SockProxy')).toBeNull()
  })

  it('keeps a folder that matches nothing only until a better one turns up', () => {
    const db = openCatalog(':memory:')
    const p = upsertProject(db, 'D--GIT-SockProxy')
    setProjectCwd(db, p, '/d/GIT/SockProxy')
    expect(folder(db, p)).toBe('/d/GIT/SockProxy')
    setProjectCwd(db, p, 'D:/GIT/SockProxy')
    expect(folder(db, p)).toBe('D:/GIT/SockProxy')
  })

  it('repairs a folder saved wrongly before', () => {
    const db = openCatalog(':memory:')
    const p = upsertProject(db, 'D--GIT-SockProxy')
    const q = upsertProject(db, 'D--GIT-Fine')
    db.prepare('UPDATE projects SET cwd = ? WHERE id = ?').run('D:/GIT/SockProxy/build/audit', p)
    db.prepare('UPDATE projects SET cwd = ? WHERE id = ?').run('D:/GIT/Fine', q)
    expect(repairProjectCwds(db)).toBe(1)
    expect(folder(db, p)).toBe('D:/GIT/SockProxy')
    expect(folder(db, q)).toBe('D:/GIT/Fine')
  })
})
