import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { runIndex } from '../src/main/indexer/indexer'
import { loadTranscript } from '../src/main/ipc'

let home: string
let sessionFile: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-tx-'))
  const proj = join(home, 'projects', 'C--Demo')
  mkdirSync(proj, { recursive: true })
  const rows = [
    { type: 'user', uuid: 'u1', parentUuid: null, cwd: 'C:\\Demo', timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'fix it' } },
    // 'a1' was rewound and replaced by 'a2' under the same parent
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-23T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ABANDONED' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', timestamp: '2026-07-23T10:02:00Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'LIVE' }, { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: '2026-07-23T10:03:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '340 lines' }] } }
  ]
  sessionFile = join(proj, '11111111-1111-1111-1111-111111111111.jsonl')
  writeFileSync(sessionFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function seededSession() {
  const db = openCatalog(':memory:')
  await runIndex(db, { home })
  const { id } = db.prepare("SELECT id FROM sessions WHERE kind='main'").get() as { id: number }
  return { db, id }
}

describe('a subagent transcript', () => {
  function writeSubagent(): string {
    const dir = join(dirname(sessionFile), '11111111-1111-1111-1111-111111111111', 'subagents')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'agent-abc.jsonl')
    const rows = [
      { type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, agentId: 'abc', cwd: 'C:\\Demo', timestamp: '2026-07-23T10:00:30Z', message: { role: 'user', content: 'Reply with heron' } },
      { type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, agentId: 'abc', timestamp: '2026-07-23T10:00:40Z', message: { role: 'assistant', content: [{ type: 'text', text: 'heron' }] } }
    ]
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    return file
  }
  const texts = (items: Array<{ kind: string; text?: string }>): Array<string | undefined> => items.filter(i => i.kind === 'text').map(i => i.text)

  it('shows the side-chain messages it is made of', async () => {
    writeSubagent()
    const db = openCatalog(':memory:')
    await runIndex(db, { home })
    const { id } = db.prepare("SELECT id FROM sessions WHERE kind='subagent'").get() as { id: number }
    expect(texts((await loadTranscript(db, id)).items)).toEqual(['Reply with heron', 'heron'])
  })

  it('still shows the saved text once its file is gone', async () => {
    const file = writeSubagent()
    const db = openCatalog(':memory:')
    await runIndex(db, { home })
    const { id } = db.prepare("SELECT id FROM sessions WHERE kind='subagent'").get() as { id: number }
    unlinkSync(file)
    const page = await loadTranscript(db, id)
    expect(page.savedTextOnly).toBe(true)
    expect(texts(page.items)).toEqual(['Reply with heron', 'heron'])
  })

  it('stays out of the main chat', async () => {
    writeSubagent()
    const { db, id } = await seededSession()
    expect(texts((await loadTranscript(db, id)).items)).not.toContain('heron')
  })
})

describe('loadTranscript', () => {
  it('renders every message chronologically, including rewound branches, and pairs tool results', async () => {
    const { db, id } = await seededSession()
    const page = await loadTranscript(db, id)

    // A chat-history viewer shows the full timeline in write (seq) order — the
    // rewound 'a1' ("ABANDONED") is part of what happened, not hidden. The old
    // behaviour walked the parentUuid tree to render only a "live branch",
    // which catastrophically truncated real multi-day sessions (parentUuid
    // threads through non-message rows and long sessions have many roots); see
    // loadTranscript's comment. So all of u1 -> a1 -> a2 render, in order.
    const texts = page.items.filter(i => i.kind === 'text').map(i => (i as { text: string }).text)
    expect(texts).toEqual(['fix it', 'ABANDONED', 'LIVE'])

    // u3's tool_result still pairs with a2's tool_use into one card.
    const tool = page.items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('340 lines')
    expect(page.hasMore).toBe(false)
  })

  it('renders the full history when parentUuid threads through a non-message row (regression)', async () => {
    // The real truncation bug: a message's parentUuid points at a NON-message
    // row (e.g. an `attachment`, which has a uuid but is never inserted into the
    // messages table). The old tree-walk treated that as a dangling parent and
    // stopped, so a 4,000-message session rendered ~6 messages. Verified against
    // live data: IntelligentCube's chain broke at an `attachment` row.
    const home2 = mkdtempSync(join(tmpdir(), 'cc-tx-thread-'))
    const proj = join(home2, 'projects', 'C--Thread')
    mkdirSync(proj, { recursive: true })
    const rows = [
      { type: 'user', uuid: 'm1', parentUuid: null, cwd: 'C:\\T', timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'm2', parentUuid: 'm1', timestamp: '2026-07-23T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
      // non-message row WITH a uuid, sitting in the parent chain (not indexed)
      { type: 'attachment', uuid: 'att1', parentUuid: 'm2' },
      // this message's parent is the attachment — the old walk broke here
      { type: 'user', uuid: 'm3', parentUuid: 'att1', timestamp: '2026-07-23T10:02:00Z', message: { role: 'user', content: 'third' } },
      { type: 'assistant', uuid: 'm4', parentUuid: 'm3', timestamp: '2026-07-23T10:03:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'fourth' }] } }
    ]
    writeFileSync(join(proj, '22222222-2222-2222-2222-222222222222.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    try {
      const db = openCatalog(':memory:')
      await runIndex(db, { home: home2 })
      const { id } = db.prepare("SELECT id FROM sessions WHERE kind='main'").get() as { id: number }
      const page = await loadTranscript(db, id)
      const texts = page.items.filter(i => i.kind === 'text').map(i => (i as { text: string }).text)
      // All four messages render despite the attachment breaking the
      // message->message chain (old behaviour returned only ['third','fourth']).
      expect(texts).toEqual(['first', 'second', 'third', 'fourth'])
    } finally {
      rmSync(home2, { recursive: true, force: true })
    }
  })

  it('returns an empty page for an unknown session', async () => {
    const db = openCatalog(':memory:')
    expect(await loadTranscript(db, 999)).toEqual({ items: [], oldestSeq: null, hasMore: false })
  })

  it('returns the newest window and reports more remaining', async () => {
    const { db, id } = await seededSession()
    const page = await loadTranscript(db, id, { limit: 1 })
    // Chronological order is u1 -> a1 -> a2 -> u3; a limit of 1 yields the newest.
    expect(page.items.every(i => i.uuid === 'u3')).toBe(true)
    expect(page.hasMore).toBe(true)
    expect(page.oldestSeq).not.toBeNull()
  })

  it('pages older messages via before, and stops when exhausted', async () => {
    const { db, id } = await seededSession()
    const first = await loadTranscript(db, id, { limit: 1 })
    const older = await loadTranscript(db, id, { limit: 1, before: first.oldestSeq! })
    expect(older.items.length).toBeGreaterThan(0)
    expect(older.oldestSeq!).toBeLessThan(first.oldestSeq!)

    // Walk to the start; the page before the oldest message must be empty.
    let cursor = older.oldestSeq!
    for (let i = 0; i < 10; i++) {
      const next = await loadTranscript(db, id, { limit: 1, before: cursor })
      if (next.items.length === 0) { expect(next.hasMore).toBe(false); return }
      cursor = next.oldestSeq!
    }
    throw new Error('paging did not terminate')
  })

  it('resolves a tool result that lives beyond the page window', async () => {
    // 'a2' holds the tool_use; its tool_result is in 'u3', outside a 1-row window
    // ending at a2. The lookahead must still supply it.
    const { db, id } = await seededSession()
    const u3Seq = (db.prepare("SELECT seq FROM messages WHERE uuid='u3'").get() as { seq: number }).seq
    const page = await loadTranscript(db, id, { limit: 1, before: u3Seq })
    const tool = page.items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('340 lines')
  })

  it('returns an empty page, not a throw, when before predates the whole conversation', async () => {
    const { db, id } = await seededSession()
    const page = await loadTranscript(db, id, { before: -1000 })
    expect(page).toEqual({ items: [], oldestSeq: null, hasMore: false })
  })

  it('clamps a zero or negative limit up to the same single-message page as limit:1', async () => {
    const { db, id } = await seededSession()
    const one = await loadTranscript(db, id, { limit: 1 })
    const zero = await loadTranscript(db, id, { limit: 0 })
    const negative = await loadTranscript(db, id, { limit: -5 })
    expect(zero).toEqual(one)
    expect(negative).toEqual(one)
  })

  it('reads to end of file when the window includes the last row (no lookahead row exists)', async () => {
    const { db, id } = await seededSession()
    // The default page (limit 60) already covers the whole 3-node live path,
    // including its final row -- MIN(byte_offset) WHERE seq > lastSeq+LOOKAHEAD
    // has no match here, exercising the null -> undefined toOffset branch. If
    // that branch mishandled the null (e.g. passed it straight through as
    // toOffset), createReadStream would receive end:null and misbehave, or the
    // trailing tool_result would be dropped.
    const page = await loadTranscript(db, id)
    const tool = page.items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('340 lines')
    expect(page.hasMore).toBe(false)
  })

  it('shows the text the catalog saved when the transcript file has been deleted', async () => {
    const { db, id } = await seededSession()
    unlinkSync(sessionFile)
    // The JSONL is gone (moved, or Claude Code's cleanupPeriodDays pruned it), and the
    // catalog may hold the only copy left of what was said.
    const page = await loadTranscript(db, id)
    expect(page.savedTextOnly).toBe(true)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every(i => i.kind === 'text')).toBe(true)
    expect(page.fileMissing).toBeUndefined()
  })

  it('flags fileMissing (not a throw) when the transcript has gone and no text was saved', async () => {
    const { db, id } = await seededSession()
    unlinkSync(sessionFile)
    db.prepare('UPDATE messages SET text = NULL WHERE session_pk = ?').run(id)
    await expect(loadTranscript(db, id)).resolves.toEqual({ items: [], oldestSeq: null, hasMore: false, fileMissing: true })
  })

  it('surfaces a non-ENOENT read error instead of swallowing it (Finding 3)', async () => {
    // The catch around streamRange must only degrade to an empty page for a
    // genuinely missing file (ENOENT). Anything else -- including a real
    // fs error like reading a path that is a directory -- must propagate,
    // or a real corruption (e.g. streamRange's MAX_LINE_BYTES rejection)
    // would be silently reported as "empty transcript, nothing wrong."
    // This exercises a real fs error (no mocking): pointing file_path at a
    // directory that actually exists produces a real, non-ENOENT stream error.
    const { db, id } = await seededSession()
    const dirPath = dirname(sessionFile)
    db.prepare('UPDATE sessions SET file_path = ? WHERE id = ?').run(dirPath, id)
    await expect(loadTranscript(db, id)).rejects.toThrow()
  })

  it('excludes sidechain rows from branch resolution (Finding 2)', async () => {
    // Older-format transcripts can inline subagent traffic into the main file
    // as rows with isSidechain: true. If such a row isn't excluded from the
    // nodes query, it can win leaf selection (highest seq) and send
    // resolveActivePath walking the wrong parent chain, corrupting the whole
    // rendered branch. Here the sidechain row is last in the file (highest
    // seq) with no parent, so under the bug it alone would become the page.
    const sideHome = mkdtempSync(join(tmpdir(), 'cc-tx-side-'))
    try {
      const proj = join(sideHome, 'projects', 'C--Side')
      mkdirSync(proj, { recursive: true })
      const rows = [
        { type: 'user', uuid: 's1', parentUuid: null, timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'fix it' } },
        { type: 'assistant', uuid: 's2', parentUuid: 's1', timestamp: '2026-07-23T10:01:00Z', message: { role: 'assistant', content: 'the fix' } },
        { type: 'assistant', uuid: 'side1', parentUuid: null, isSidechain: true, timestamp: '2026-07-23T10:02:00Z', message: { role: 'assistant', content: 'SIDECHAIN' } }
      ]
      writeFileSync(
        join(proj, '44444444-4444-4444-4444-444444444444.jsonl'),
        rows.map(r => JSON.stringify(r)).join('\n') + '\n'
      )
      const db = openCatalog(':memory:')
      await runIndex(db, { home: sideHome })
      const { id } = db.prepare("SELECT id FROM sessions WHERE kind='main'").get() as { id: number }

      const page = await loadTranscript(db, id)
      const uuids = page.items.map(i => i.uuid)
      expect(uuids).not.toContain('side1')
      const texts = page.items.filter(i => i.kind === 'text').map(i => (i as { text: string }).text)
      expect(texts).toEqual(['fix it', 'the fix'])
    } finally {
      rmSync(sideHome, { recursive: true, force: true })
    }
  })

  it('pairs a boundary tool_result across a run of non-message rows longer than LOOKAHEAD_ROWS (Finding 1)', async () => {
    // Regression for the seq-gap bug: streamRows assigns `seq` to every
    // parsed JSONL line, including non-message rows (file-history-snapshot,
    // summary, attachment, ...) that are never inserted into `messages`. The
    // old lookahead query did arithmetic directly on stored seq values
    // (`seq > lastSeq + LOOKAHEAD_ROWS`), which counts line-space, not
    // message-space. A run of non-message rows longer than LOOKAHEAD_ROWS
    // (5) pushes the *next real message's* seq past that threshold, making
    // it the stop row -- and the stop row is excluded from the byte range,
    // dropping the boundary tool_result. Six non-message rows reproduce it.
    const gapHome = mkdtempSync(join(tmpdir(), 'cc-tx-gap-'))
    try {
      const proj = join(gapHome, 'projects', 'C--Gap')
      mkdirSync(proj, { recursive: true })
      const rows: Record<string, unknown>[] = [
        { type: 'user', uuid: 'g1', parentUuid: null, timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'go' } },
        { type: 'assistant', uuid: 'g2', parentUuid: 'g1', timestamp: '2026-07-23T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_gap', name: 'Read', input: {} }] } }
      ]
      for (let i = 0; i < 6; i++) rows.push({ type: 'file-history-snapshot', snapshot: i })
      rows.push({ type: 'user', uuid: 'g3', parentUuid: 'g2', timestamp: '2026-07-23T10:10:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gap', content: 'gap result' }] } })

      writeFileSync(
        join(proj, '33333333-3333-3333-3333-333333333333.jsonl'),
        rows.map(r => JSON.stringify(r)).join('\n') + '\n'
      )
      const db = openCatalog(':memory:')
      await runIndex(db, { home: gapHome })
      const { id } = db.prepare("SELECT id FROM sessions WHERE kind='main'").get() as { id: number }

      const g3Seq = (db.prepare("SELECT seq FROM messages WHERE uuid='g3'").get() as { seq: number }).seq
      const page = await loadTranscript(db, id, { limit: 1, before: g3Seq })
      const tool = page.items.find(i => i.kind === 'tool')
      expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('gap result')
    } finally {
      rmSync(gapHome, { recursive: true, force: true })
    }
  })

  it('pages with no gap and no overlap: oldestSeq fed back as before yields the exact adjacent page', async () => {
    // A plain 5-message chain, one text block per message, so every rendered
    // item maps 1:1 to a message uuid -- isolating the page-boundary math
    // from tool/text pairing concerns tested elsewhere.
    const plainHome = mkdtempSync(join(tmpdir(), 'cc-tx-plain-'))
    try {
      const proj = join(plainHome, 'projects', 'C--Plain')
      mkdirSync(proj, { recursive: true })
      const rows = []
      let parent: string | null = null
      for (let i = 0; i < 5; i++) {
        const uuid = `m${i}`
        const role = i % 2 === 0 ? 'user' : 'assistant'
        rows.push({
          type: role, uuid, parentUuid: parent,
          timestamp: `2026-07-23T10:${String(i).padStart(2, '0')}:00Z`,
          message: { role, content: `msg-${i}` }
        })
        parent = uuid
      }
      writeFileSync(
        join(proj, '22222222-2222-2222-2222-222222222222.jsonl'),
        rows.map(r => JSON.stringify(r)).join('\n') + '\n'
      )
      const db = openCatalog(':memory:')
      await runIndex(db, { home: plainHome })
      const { id } = db.prepare("SELECT id FROM sessions WHERE kind='main'").get() as { id: number }

      const first = await loadTranscript(db, id, { limit: 2 })
      expect(first.items.map(i => i.uuid)).toEqual(['m3', 'm4'])
      expect(first.hasMore).toBe(true)

      const second = await loadTranscript(db, id, { limit: 2, before: first.oldestSeq! })
      expect(second.items.map(i => i.uuid)).toEqual(['m1', 'm2'])
      expect(second.hasMore).toBe(true)

      const third = await loadTranscript(db, id, { limit: 2, before: second.oldestSeq! })
      expect(third.items.map(i => i.uuid)).toEqual(['m0'])
      expect(third.hasMore).toBe(false)

      // Concatenated oldest -> newest, the three pages reconstruct the whole
      // conversation exactly once each: no gap, no overlap.
      const reconstructed = [...third.items, ...second.items, ...first.items].map(i => i.uuid)
      expect(reconstructed).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    } finally {
      rmSync(plainHome, { recursive: true, force: true })
    }
  })
})
