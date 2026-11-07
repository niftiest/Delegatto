import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog, type Catalog } from '../src/main/catalog/db'
import { runIndex } from '../src/main/indexer/indexer'
import { loadTranscript, PAGE_SIZE } from '../src/main/ipc'

const COUNT = 300
const row = (i: number) => JSON.stringify({
  type: 'user', uuid: `u${i}`, parentUuid: null, cwd: 'C:\\x',
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), message: { role: 'user', content: `message ${i}` }
})

let home: string
let db: Catalog
const texts = (items: Array<{ kind: string; text?: string }>): string[] => items.filter(i => i.kind === 'text').map(i => i.text!)
const seqOf = (uuid: string): number => (db.prepare('SELECT seq FROM messages WHERE uuid = ?').get(uuid) as { seq: number }).seq
const pk = (): number => (db.prepare('SELECT id FROM sessions').get() as { id: number }).id

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-jump-'))
  const dir = join(home, 'projects', 'C--x')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 's.jsonl'), Array.from({ length: COUNT }, (_, i) => row(i)).join('\n') + '\n')
  db = openCatalog(':memory:')
  await runIndex(db, { home })
})
afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }) })

describe('loading back to a message', () => {
  it('joins up with what is already loaded, with a few messages before it', async () => {
    const latest = await loadTranscript(db, pk())
    const page = await loadTranscript(db, pk(), { before: latest.oldestSeq!, fromSeq: seqOf('u50') })
    const got = texts(page.items as Array<{ kind: string; text?: string }>)
    expect(got[0]).toBe('message 40')
    expect(got).toContain('message 50')
    expect(got[got.length - 1]).toBe(`message ${COUNT - PAGE_SIZE - 1}`)
    expect(page.hasMore).toBe(true)
  })

  it('reports nothing older once it reaches the first message', async () => {
    const latest = await loadTranscript(db, pk())
    const page = await loadTranscript(db, pk(), { before: latest.oldestSeq!, fromSeq: seqOf('u3') })
    expect(texts(page.items as Array<{ kind: string; text?: string }>)[0]).toBe('message 0')
    expect(page.hasMore).toBe(false)
  })

  it('still loads at least a normal page for a message just above the loaded part', async () => {
    const latest = await loadTranscript(db, pk())
    const page = await loadTranscript(db, pk(), { before: latest.oldestSeq!, fromSeq: seqOf(`u${COUNT - PAGE_SIZE - 1}`) })
    expect(texts(page.items as Array<{ kind: string; text?: string }>)).toHaveLength(PAGE_SIZE)
  })

  it('is an ordinary page when no message is named', async () => {
    const page = await loadTranscript(db, pk())
    expect(texts(page.items as Array<{ kind: string; text?: string }>)).toHaveLength(PAGE_SIZE)
  })
})
