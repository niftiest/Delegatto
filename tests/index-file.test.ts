import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { indexFile } from '../src/main/indexer/index-file'
import type { DiscoveredMain } from '../src/main/indexer/discover'

let dir: string
const userRow = (uuid: string, text: string, gitBranch: string = 'main') => JSON.stringify({
  type: 'user', uuid, parentUuid: null, cwd: 'C:\\Users\\x\\GIT\\Demo', gitBranch,
  timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: text }
})
const assistantRow = (uuid: string) => JSON.stringify({
  type: 'assistant', uuid, parentUuid: 'u1', timestamp: '2026-07-23T10:01:00Z',
  message: { role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }],
    usage: { input_tokens: 10, output_tokens: 5 } }
})
const assistantRowWithCache = (uuid: string) => JSON.stringify({
  type: 'assistant', uuid, parentUuid: 'u1', timestamp: '2026-07-23T10:01:00Z',
  message: { role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } }
})

function fileRecord(path: string): DiscoveredMain {
  const st = statSync(path)
  return { kind: 'main', projectDir: 'C--Users-x-GIT-Demo', sessionId: 'sess-1', filePath: path, size: st.size, mtimeMs: st.mtimeMs }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-idx-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('indexFile', () => {
  it('indexes rows and derives cwd, branch, model and title', async () => {
    const f = join(dir, 'sess-1.jsonl')
    writeFileSync(f, `${userRow('u1', 'fix the scraper')}\n${assistantRow('a1')}\n`)
    const db = openCatalog(':memory:')
    const res = await indexFile(db, fileRecord(f))
    expect(res.added).toBe(2)

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(res.sessionPk) as Record<string, unknown>
    expect(session.title).toBe('fix the scraper')
    expect(session.git_branch).toBe('main')
    expect(session.model).toBe('claude-opus-4-8')
    expect(session.message_count).toBe(2)
    expect(session.input_tokens).toBe(10)
    expect(session.output_tokens).toBe(5)

    const project = db.prepare('SELECT cwd FROM projects').get() as { cwd: string }
    expect(project.cwd).toBe('C:\\Users\\x\\GIT\\Demo')

    const tools = db.prepare("SELECT tool_names FROM messages WHERE uuid='a1'").get() as { tool_names: string }
    expect(tools.tool_names).toBe('Read')
  })

  it('skips a file whose size and mtime are unchanged', async () => {
    const f = join(dir, 'sess-1.jsonl')
    writeFileSync(f, `${userRow('u1', 'hello')}\n`)
    const db = openCatalog(':memory:')
    await indexFile(db, fileRecord(f))
    const second = await indexFile(db, fileRecord(f))
    expect(second.skipped).toBe(true)
    expect(second.added).toBe(0)
  })

  it('indexes only appended rows on a second pass', async () => {
    const f = join(dir, 'sess-1.jsonl')
    writeFileSync(f, `${userRow('u1', 'hello')}\n`)
    const db = openCatalog(':memory:')
    await indexFile(db, fileRecord(f))
    appendFileSync(f, `${assistantRow('a1')}\n`)
    const second = await indexFile(db, fileRecord(f))
    expect(second.skipped).toBe(false)
    expect(second.added).toBe(1)
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(2)
  })

  it('populates the FTS index so text is searchable', async () => {
    const f = join(dir, 'sess-1.jsonl')
    writeFileSync(f, `${userRow('u1', 'cursor pagination is broken')}\n`)
    const db = openCatalog(':memory:')
    await indexFile(db, fileRecord(f))
    const hit = db.prepare("SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'pagination'").get() as { c: number }
    expect(hit.c).toBe(1)
  })

  it('reindexes from scratch when the file is smaller than last indexed (rewritten, not appended)', async () => {
    const f = join(dir, 'sess-1.jsonl')
    // First pass: seed with non-trivial aggregates (assistant with cache tokens, user with branch)
    writeFileSync(f, `${userRow('u1', 'first take', 'old-branch')}\n${assistantRowWithCache('a1')}\n`)
    const db = openCatalog(':memory:')
    const first = await indexFile(db, fileRecord(f))
    expect(first.added).toBe(2)

    // Verify first pass seeded the aggregates correctly
    let session = db.prepare(
      'SELECT message_count, title, model, git_branch, input_tokens, output_tokens, cache_read, cache_write FROM sessions WHERE id = ?'
    ).get(first.sessionPk) as Record<string, unknown>
    expect(session.message_count).toBe(2)
    expect(session.title).toBe('first take')
    expect(session.model).toBe('claude-opus-4-8')
    expect(session.git_branch).toBe('old-branch')
    expect(session.input_tokens).toBe(10)
    expect(session.output_tokens).toBe(5)
    expect(session.cache_read).toBe(2)
    expect(session.cache_write).toBe(3)

    // The transcript was rewritten shorter than before (e.g. compaction),
    // not appended to. A stale indexed_offset past the new end of file must
    // not be trusted -- the old rows it points past no longer exist.
    writeFileSync(f, `${userRow('u2', 'second take', 'new-branch')}\n`)
    const second = await indexFile(db, fileRecord(f))
    expect(second.skipped).toBe(false)
    expect(second.added).toBe(1)

    const messages = db.prepare('SELECT uuid FROM messages WHERE session_pk = ? ORDER BY seq').all(second.sessionPk) as { uuid: string }[]
    expect(messages.map(m => m.uuid)).toEqual(['u2'])

    // Verify the reset worked: aggregates reflect ONLY the new content, not accumulated totals
    session = db.prepare(
      'SELECT message_count, title, model, git_branch, input_tokens, output_tokens, cache_read, cache_write FROM sessions WHERE id = ?'
    ).get(second.sessionPk) as Record<string, unknown>
    expect(session.message_count).toBe(1)
    expect(session.title).toBe('second take')
    expect(session.model).toBeNull() // No assistant in second pass
    expect(session.git_branch).toBe('new-branch') // User row carries gitBranch
    // Guard against accumulation: explicitly verify tokens are not summed across both passes
    expect(session.input_tokens).toBe(0) // Only second pass (user row, no usage)
    expect(session.output_tokens).toBe(0) // Only second pass (user row, no usage)
    expect(session.cache_read).toBe(0) // Only second pass (user row, no usage)
    expect(session.cache_write).toBe(0) // Only second pass (user row, no usage)
  })

  it('does not double-count token usage when a pass re-reads already-indexed rows', async () => {
    const f = join(dir, 'sess-1.jsonl')
    writeFileSync(f, `${userRow('u1', 'hello')}\n${assistantRow('a1')}\n`)
    const db = openCatalog(':memory:')
    const first = await indexFile(db, fileRecord(f))
    expect(first.added).toBe(2)

    const before = db.prepare('SELECT input_tokens, output_tokens, message_count FROM sessions WHERE id = ?')
      .get(first.sessionPk) as { input_tokens: number; output_tokens: number; message_count: number }
    expect(before.input_tokens).toBe(10)
    expect(before.output_tokens).toBe(5)
    expect(before.message_count).toBe(2)

    // Simulate a pass that re-reads rows already present in the catalog
    // (e.g. a crash between inserting rows and persisting indexed_offset).
    // ON CONFLICT DO NOTHING keeps the row count correct; the usage rollup
    // must not add the same row's tokens a second time.
    db.prepare('UPDATE sessions SET indexed_offset = 0, indexed_seq = 0 WHERE id = ?').run(first.sessionPk)
    const second = await indexFile(db, fileRecord(f))
    expect(second.skipped).toBe(false)
    expect(second.added).toBe(0)

    const after = db.prepare('SELECT input_tokens, output_tokens, message_count FROM sessions WHERE id = ?')
      .get(first.sessionPk) as { input_tokens: number; output_tokens: number; message_count: number }
    expect(after.input_tokens).toBe(10)
    expect(after.output_tokens).toBe(5)
    expect(after.message_count).toBe(2)
  })
})
