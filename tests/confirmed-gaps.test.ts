import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { indexFile } from '../src/main/indexer/index-file'
import type { DiscoveredMain } from '../src/main/indexer/discover'
import { parseEvent } from '../src/main/engine/events'
import { listMcpServers } from '../src/main/mcp-skills'
import { EFFORTS, SAVED_EFFORTS } from '../src/shared/models'
import { MIGRATIONS } from '../src/main/catalog/schema'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-gaps-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('token totals', () => {
  // As in a real transcript: each content block of one API message is its own row.
  const row = (uuid: string, id: string | undefined, output: number, cacheRead = 100) => JSON.stringify({
    type: 'assistant', uuid, parentUuid: null, timestamp: '2026-11-02T10:00:00Z',
    message: { role: 'assistant', ...(id === undefined ? {} : { id }), model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 7 } }
  })
  const file = (): DiscoveredMain => {
    const filePath = join(dir, 's.jsonl')
    const s = statSync(filePath)
    return { kind: 'main', filePath, sessionId: 's', projectDir: 'C--x', size: s.size, mtimeMs: s.mtimeMs } as unknown as DiscoveredMain
  }
  const totals = (db: ReturnType<typeof openCatalog>) => db.prepare('SELECT input_tokens AS i, output_tokens AS o, cache_read AS r, cache_write AS w FROM sessions').get()

  it('counts an API message once, however many rows repeat it', async () => {
    const db = openCatalog(':memory:')
    writeFileSync(join(dir, 's.jsonl'), [row('a', 'm1', 10), row('b', 'm1', 10), row('c', 'm1', 10), row('d', 'm2', 3)].join('\n') + '\n')
    await indexFile(db, file())
    expect(totals(db)).toEqual({ i: 10, o: 13, r: 200, w: 14 })
  })

  it('takes the final figures when a later row reports more', async () => {
    const db = openCatalog(':memory:')
    writeFileSync(join(dir, 's.jsonl'), [row('a', 'm1', 2), row('b', 'm1', 40)].join('\n') + '\n')
    await indexFile(db, file())
    expect(totals(db)).toMatchObject({ o: 40, r: 100 })
  })

  it('handles a message continuing into the next indexing pass', async () => {
    const db = openCatalog(':memory:')
    writeFileSync(join(dir, 's.jsonl'), row('a', 'm1', 2) + '\n')
    await indexFile(db, file())
    appendFileSync(join(dir, 's.jsonl'), [row('b', 'm1', 40), row('c', 'm2', 1)].join('\n') + '\n')
    await indexFile(db, file())
    expect(totals(db)).toMatchObject({ o: 41, r: 200, i: 10 })
  })

  it('counts a row with no message id on its own', async () => {
    const db = openCatalog(':memory:')
    writeFileSync(join(dir, 's.jsonl'), [row('a', undefined, 2), row('b', undefined, 3)].join('\n') + '\n')
    await indexFile(db, file())
    expect(totals(db)).toMatchObject({ o: 5 })
  })

  it('corrects existing chats when the app updates', async () => {
    const db = openCatalog(':memory:')
    writeFileSync(join(dir, 's.jsonl'), [row('a', 'm1', 10), row('b', 'm1', 10)].join('\n') + '\n')
    await indexFile(db, file())
    db.prepare('UPDATE sessions SET output_tokens = 999, last_usage = NULL').run()
    MIGRATIONS.find(m => m.toVersion === 8)!.apply(db)
    await indexFile(db, file())
    expect(totals(db)).toMatchObject({ o: 10 })
  })
})

describe('a failed turn says why', () => {
  const fail = (o: object) => parseEvent(JSON.stringify({ type: 'result', is_error: true, ...o }))
  it('reads errors[], which failed turns carry instead of result', () => {
    expect(fail({ subtype: 'error_during_execution', errors: ['Prompt is too long'] })).toMatchObject({ isError: true, text: 'Prompt is too long' })
  })
  it("hides Claude Code's own diagnostics", () => {
    const e = fail({ subtype: 'error_during_execution', errors: ['[ede_diagnostic] result_type=user'], terminal_reason: 'model_error' })
    expect(e).toMatchObject({ text: 'Claude stopped because of an error (model error).' })
  })
  it('explains the known limits', () => {
    expect(fail({ subtype: 'error_max_budget_usd', errors: [] })).toMatchObject({ text: expect.stringContaining('budget') })
    expect(fail({ subtype: 'error_max_turns' })).toMatchObject({ text: expect.stringContaining('limit on turns') })
  })
  it('keeps the result text when there is one', () => {
    expect(fail({ subtype: 'success', result: 'API Error: 500' })).toMatchObject({ text: 'API Error: 500' })
  })
  it('leaves a successful result alone', () => {
    expect(parseEvent(JSON.stringify({ type: 'result', is_error: false, result: '' }))).toMatchObject({ isError: false, text: '' })
  })
})

describe('the MCP panel', () => {
  const server = (name: string) => ({ [name]: { type: 'stdio', command: 'x' } })
  const names = (cwd: string) => listMcpServers({ homeDir: dir, projectCwd: cwd }).map(s => s.name)

  it("finds a project's servers under Claude Code's forward-slash key", () => {
    const cwd = join(dir, 'Proj')
    mkdirSync(cwd)
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects: { [cwd.replace(/\\\\/g, '/').replace(/\\/g, '/')]: { mcpServers: server('local') } } }))
    expect(names(cwd)).toContain('local')
  })

  it('reads .mcp.json from the folders above the project too', () => {
    const cwd = join(dir, 'a', 'b')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: server('outer') }))
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: server('inner') }))
    expect(names(cwd)).toEqual(expect.arrayContaining(['outer', 'inner']))
  })

  it('lets the nearest folder win a name, listing it once', () => {
    const cwd = join(dir, 'a')
    mkdirSync(cwd)
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { same: { type: 'stdio', command: 'outer' } } }))
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { same: { type: 'stdio', command: 'inner' } } }))
    expect(names(cwd).filter(n => n === 'same')).toHaveLength(1)
  })
})

describe('efforts', () => {
  it("offers max for a chat, not as a saved setting Claude Code would ignore", () => {
    expect(EFFORTS).toContain('max')
    expect(SAVED_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})
