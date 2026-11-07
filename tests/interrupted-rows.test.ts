import { describe, expect, it } from 'vitest'
import { buildRenderItems } from '../src/main/jsonl/render'
import { classifyEvent } from '../src/main/notify-rules'
import { openCatalog } from '../src/main/catalog/db'
import { upsertProject, upsertSession } from '../src/main/catalog/repos'
import { searchProject } from '../src/main/catalog/search'
import type { MessageRow } from '../src/main/jsonl/rows'

const row = (uuid: string, type: 'user' | 'assistant', text: string, model?: string): MessageRow =>
  ({ type, uuid, parentUuid: null, timestamp: '2026-11-02T10:00:00.000Z', message: { role: type, model, content: [{ type: 'text', text }] } }) as unknown as MessageRow

describe('what a stopped turn leaves in the transcript', () => {
  it("doesn't show Claude Code's made-up reply as Claude's", () => {
    expect(buildRenderItems([row('a', 'assistant', 'No response requested.', '<synthetic>')])).toEqual([])
  })

  it('still shows Claude actually saying those words', () => {
    expect(buildRenderItems([row('a', 'assistant', 'No response requested.', 'claude-opus-5-5')])[0]).toMatchObject({ kind: 'text' })
  })

  it('shows an API error as a note, not as Claude talking', () => {
    expect(buildRenderItems([row('a', 'assistant', 'API Error: 500\nmore detail', '<synthetic>')])).toEqual([expect.objectContaining({ kind: 'notice', label: 'API Error: 500', text: 'API Error: 500\nmore detail' })])
    const flagged = { ...row('a', 'assistant', 'Overloaded', 'claude-opus-5-5'), isApiErrorMessage: true } as MessageRow
    expect(buildRenderItems([flagged])[0]).toMatchObject({ kind: 'notice' })
  })

  it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])('shows %s as a note, not as the user talking', text => {
    expect(buildRenderItems([row('u', 'user', text)])).toEqual([expect.objectContaining({ kind: 'notice', label: 'Interrupted' })])
  })

  it('leaves a message that only mentions it alone', () => {
    expect(buildRenderItems([row('u', 'user', 'why do I see [Request interrupted by user] here?')])[0]).toMatchObject({ kind: 'text', role: 'user' })
  })

  it('stays out of Ctrl+F results', () => {
    const db = openCatalog(':memory:')
    const s = upsertSession(db, { projectId: upsertProject(db, 'C--x'), sessionId: 's', kind: 'main', filePath: '/f/s.jsonl', fileSize: 1, fileMtimeMs: 1 })
    const add = (uuid: string, role: string, text: string, seq: number): void => { db.prepare('INSERT INTO messages (session_pk,uuid,seq,role,byte_offset,text) VALUES (?,?,?,?,?,?)').run(s, uuid, seq, role, seq, text) }
    add('1', 'user', '[Request interrupted by user for tool use]', 1)
    add('2', 'assistant', 'No response requested.', 2)
    add('3', 'user', 'I interrupted by user request', 3)
    const projectId = (db.prepare('SELECT project_id AS p FROM sessions WHERE id = ?').get(s) as { p: number }).p
    expect(searchProject(db, projectId, 'interrupted').hits.map(h => h.text)).toEqual(['I interrupted by user request'])
    expect(searchProject(db, projectId, 'response requested').total).toBe(0)
  })
})

describe('notifications for a stopped turn', () => {
  const result = { kind: 'result', isError: false, costUsd: 0, text: '' } as const
  it('says nothing about a turn the user stopped', () => {
    expect(classifyEvent({ ...result, interrupted: true })).toBeNull()
  })
  it('still reports the others', () => {
    expect(classifyEvent(result)).toBe('turnComplete')
    expect(classifyEvent({ ...result, isError: true })).toBe('error')
  })
})
