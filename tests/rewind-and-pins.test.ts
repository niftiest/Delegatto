import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { indexFile } from '../src/main/indexer/index-file'
import { loadTranscript } from '../src/main/ipc'
import { markRewoundFrom, rewindPoints } from '../src/main/engine/chat-actions'
import { listPins, pinMessage, unpinMessage } from '../src/main/catalog/pins'
import { search } from '../src/main/catalog/search'
import { SessionPool, type TransportLike } from '../src/main/engine/pool'
import type { SpawnSpec } from '../src/main/engine/transport'
import { isRewindCommand, terminalOnlyCommand } from '../src/renderer/lib'
import type { LiveEvent } from '../src/shared/engine-types'
import type { DiscoveredMain } from '../src/main/indexer/discover'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-rewind-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ts = '2026-11-04T10:00:00.000Z'
const user = (uuid: string, parentUuid: string | null, text: string): object => ({ type: 'user', uuid, parentUuid, sessionId: 's', cwd: dir, timestamp: ts, message: { role: 'user', content: text } })
const assistant = (uuid: string, parentUuid: string, text: string): object => ({ type: 'assistant', uuid, parentUuid, sessionId: 's', cwd: dir, timestamp: ts, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } })
const toolUse = (uuid: string, parentUuid: string): object => ({ type: 'assistant', uuid, parentUuid, sessionId: 's', cwd: dir, timestamp: ts, message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } })
const toolResult = (uuid: string, parentUuid: string): object => ({ type: 'user', uuid, parentUuid, sessionId: 's', cwd: dir, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
const leaf = (leafUuid: string): object => ({ type: 'last-prompt', lastPrompt: 'x', leafUuid, sessionId: 's' })

async function indexed(rows: object[]) {
  const file = join(dir, 's.jsonl')
  writeFileSync(file, `${rows.map(r => JSON.stringify(r)).join('\n')}\n`)
  const db = openCatalog(':memory:')
  const main: DiscoveredMain = { kind: 'main', projectDir: 'p', sessionId: 's', filePath: file, size: statSync(file).size, mtimeMs: 1 }
  const { sessionPk } = await indexFile(db, main)
  const projectId = (db.prepare('SELECT project_id AS p FROM sessions WHERE id = ?').get(sessionPk) as { p: number }).p
  const shown = async (): Promise<string[]> => (await loadTranscript(db, sessionPk)).items.map(i => i.uuid)
  return { db, sessionPk, projectId, shown, file, main }
}

// The shape Claude Code 2.1.318 writes for a rewind, captured live.
const REWOUND = [
  user('u1', null, 'first'), assistant('a1', 'u1', 'reply one'),
  user('u2', 'a1', 'second'), toolUse('a2', 'u2'), toolResult('r2', 'a2'), assistant('a3', 'r2', 'reply two'),
  leaf('a1'),
  user('u3', 'a1', 'third'), assistant('a4', 'u3', 'reply three')
]

describe('a chat after a rewind', () => {
  it('leaves out everything the rewind went past', async () => {
    const { shown } = await indexed(REWOUND)
    expect(await shown()).toEqual(['u1', 'a1', 'u3', 'a4'])
  })

  it('leaves it out before anything new is sent, too', async () => {
    const { shown } = await indexed(REWOUND.slice(0, 7))
    expect(await shown()).toEqual(['u1', 'a1'])
  })

  it('keeps it out of search and of what can be gone back to', async () => {
    const { db, sessionPk } = await indexed(REWOUND)
    expect(rewindPoints(db, sessionPk).map(p => p.uuid)).toEqual(['u3', 'u1'])
    expect(search(db, 'second')).toEqual([])
    expect(search(db, 'third').length).toBe(1)
  })

  it('still works over a page boundary', async () => {
    const rows: object[] = [user('u0', null, 'start')]
    let parent = 'u0'
    for (let i = 0; i < 200; i++) { rows.push(assistant(`a${i}`, parent, `reply ${i}`)); parent = `a${i}` }
    rows.push(user('gone', 'a10', 'went back'))
    const { shown } = await indexed([...rows.slice(0, 12), user('target', 'a10', 'typed'), ...rows.slice(12, 150).map((r, i) => assistant(`b${i}`, i === 0 ? 'target' : `b${i - 1}`, 'more')), leaf('a10'), user('after', 'a10', 'next'), assistant('z', 'after', 'end')])
    expect(await shown()).toEqual(expect.arrayContaining(['after', 'z']))
    expect((await shown()).filter(u => u.startsWith('b'))).toEqual([])
  })

  it('comes through a rewritten file the same', async () => {
    const { db, main, file, shown } = await indexed(REWOUND)
    writeFileSync(file, `${REWOUND.slice(0, 7).map(r => JSON.stringify(r)).join('\n')}\n`)
    db.prepare('UPDATE sessions SET indexed_offset = 9007199254740991').run()
    await indexFile(db, { ...main, size: statSync(file).size })
    expect(await shown()).toEqual(['u1', 'a1'])
  })
})

describe('going back to a chat\'s first message', () => {
  it('leaves it empty, which the transcript alone does not say', async () => {
    const { db, sessionPk, shown } = await indexed([user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second')])
    markRewoundFrom(db, sessionPk, 'u1')
    expect(await shown()).toEqual([])
  })

  it('marks from the message on, not before it', async () => {
    const { db, sessionPk, shown } = await indexed([user('u1', null, 'first'), assistant('a1', 'u1', 'reply'), user('u2', 'a1', 'second'), assistant('a2', 'u2', 'more')])
    markRewoundFrom(db, sessionPk, 'u2')
    expect(await shown()).toEqual(['u1', 'a1'])
  })

  it('does nothing for a message it does not have', async () => {
    const { db, sessionPk, shown } = await indexed([user('u1', null, 'first')])
    markRewoundFrom(db, sessionPk, 'nobody')
    expect(await shown()).toEqual(['u1'])
  })
})

describe('ordinary chats are left alone', () => {
  it('a leaf on a reply followed by a tool result, which real chats have, hides nothing', async () => {
    const { shown } = await indexed([user('u1', null, 'go'), toolUse('a1', 'u1'), leaf('a1'), toolResult('r1', 'a1'), assistant('a2', 'r1', 'done')])
    expect(await shown()).toEqual(['u1', 'a1', 'a2'])
  })

  it('a leaf at the very end hides nothing', async () => {
    const { shown } = await indexed([user('u1', null, 'go'), assistant('a1', 'u1', 'done'), leaf('a1'), user('u2', 'a1', 'next')])
    expect(await shown()).toEqual(['u1', 'a1', 'u2'])
  })

  it('a leaf on a message of the user hides nothing', async () => {
    const { shown } = await indexed([user('u1', null, 'go'), leaf('u1'), assistant('a1', 'u1', 'done')])
    expect(await shown()).toEqual(['u1', 'a1'])
  })

  it('a leaf naming a row it does not know hides nothing', async () => {
    const { shown } = await indexed([user('u1', null, 'go'), assistant('a1', 'u1', 'done'), leaf('nobody')])
    expect(await shown()).toEqual(['u1', 'a1'])
  })
})

describe('what can be gone back to', () => {
  it('lists typed messages, newest first, not tool output or Claude Code notes', async () => {
    const { db, sessionPk } = await indexed([
      user('u1', null, 'first'), toolUse('a1', 'u1'), toolResult('r1', 'a1'),
      user('n1', 'r1', '<system-reminder>not typed</system-reminder>'),
      user('n2', 'n1', '[Request interrupted by user]'),
      user('u2', 'n2', 'second')
    ])
    expect(rewindPoints(db, sessionPk).map(p => p.text)).toEqual(['second', 'first'])
  })
})

describe('/rewind', () => {
  it('is handled here now, under both its names', () => {
    expect(isRewindCommand('/rewind')).toBe(true)
    expect(isRewindCommand('  /checkpoint ')).toBe(true)
    expect(isRewindCommand('/rewind now')).toBe(false)
    expect(isRewindCommand('please /rewind')).toBe(false)
    expect(terminalOnlyCommand('/rewind')).toBeNull()
  })
})

describe('asking a process about rewinding', () => {
  function pooled() {
    const requests: Array<[string, unknown]> = []
    const sent: object[] = []
    let answer: unknown = {}
    const transport: TransportLike = {
      pid: null, start() {}, send(m: object) { sent.push(m) }, interrupt() {}, close() {},
      request: async (subtype: string, extra: object) => { requests.push([subtype, extra]); return answer },
      on() {}, onExit() {}
    } as unknown as TransportLike
    let spawned = 0
    const pool = new SessionPool({ idleReapMs: 100000, now: () => 0, transportFactory: () => { spawned++; return transport } })
    return { pool, requests, sent, setAnswer: (a: unknown) => { answer = a }, spawnCount: () => spawned }
  }
  const spec = { cwd: 'x', skipPermissions: false } as SpawnSpec

  it('wakes a process with no message, and not as if a turn were running', () => {
    const { pool, sent, spawnCount } = pooled()
    pool.wake('k', spec)
    expect(spawnCount()).toBe(1)
    expect(sent).toEqual([])
    expect(pool.isTurnRunning('k')).toBe(false)
    pool.wake('k', spec)
    expect(spawnCount()).toBe(1)
  })

  it('reads what a dry run says would change', async () => {
    const { pool, requests, setAnswer } = pooled()
    pool.wake('k', spec)
    setAnswer({ canRewind: true, filesChanged: ['a.txt'], insertions: 2, deletions: 1 })
    expect(await pool.rewindFiles('k', 'u', true)).toEqual({ canRewind: true, error: null, files: ['a.txt'], insertions: 2, deletions: 1 })
    expect(requests.at(-1)).toEqual(['rewind_files', { user_message_id: 'u', dry_run: true }])
    await pool.rewindFiles('k', 'u', false)
    expect(requests.at(-1)).toEqual(['rewind_files', { user_message_id: 'u' }])
  })

  it('passes on why files can not go back', async () => {
    const { pool, setAnswer } = pooled()
    pool.wake('k', spec)
    setAnswer({ canRewind: false, error: 'No file checkpoint found' })
    expect(await pool.rewindFiles('k', 'u', true)).toMatchObject({ canRewind: false, error: 'No file checkpoint found', files: [] })
  })

  it('reads the text a rewound conversation hands back, and a refusal', async () => {
    const { pool, setAnswer } = pooled()
    pool.wake('k', spec)
    setAnswer({ rewound: true, prefillText: 'typed this' })
    expect(await pool.rewindConversation('k', 'u')).toEqual({ prefill: 'typed this' })
    setAnswer({ rewound: false })
    expect(await pool.rewindConversation('k', 'u')).toBeNull()
  })

  it('has no answer without a process', async () => {
    const { pool } = pooled()
    expect(await pool.rewindFiles('nobody', 'u', true)).toBeNull()
    expect(await pool.rewindConversation('nobody', 'u')).toBeNull()
    expect(await pool.taskOutput('nobody', 't')).toBeNull()
  })

  it('reads a background command\'s output', async () => {
    const { pool, requests, setAnswer } = pooled()
    pool.wake('k', spec)
    setAnswer({ output: 'tick0\n', total_bytes: 6, truncated: false })
    expect(await pool.taskOutput('k', 't1')).toEqual({ output: 'tick0\n', truncated: false })
    expect(requests.at(-1)).toEqual(['get_task_output', { task_id: 't1' }])
    setAnswer({})
    expect(await pool.taskOutput('k', 't1')).toBeNull()
  })

  it('a woken process then takes a message as usual', () => {
    const { pool, sent } = pooled()
    pool.wake('k', spec)
    pool.send('k', spec, { hello: 1 })
    expect(sent).toEqual([{ hello: 1 }])
    expect(pool.isTurnRunning('k')).toBe(true)
    const heard: LiveEvent[] = []
    pool.on('k', e => heard.push(e))
    expect(heard).toEqual([])
  })
})

describe('pinned messages', () => {
  const rows = [user('u1', null, 'pin me please'), assistant('a1', 'u1', 'a useful answer'), user('u2', 'a1', 'more')]

  it('are listed newest first, with what they said', async () => {
    const { db, sessionPk, projectId } = await indexed(rows)
    expect(pinMessage(db, sessionPk, 'u1', 1)).toBe(true)
    expect(pinMessage(db, sessionPk, 'a1', 2)).toBe(true)
    expect(listPins(db, projectId).map(p => p.uuid)).toEqual(['a1', 'u1'])
    expect(listPins(db, projectId)[1]).toMatchObject({ uuid: 'u1', role: 'user', text: 'pin me please', sessionPk })
    expect(listPins(db, projectId)[1]!.seq).toBeGreaterThanOrEqual(0)
  })

  it('pin once, and unpin', async () => {
    const { db, sessionPk, projectId } = await indexed(rows)
    pinMessage(db, sessionPk, 'u1', 1)
    pinMessage(db, sessionPk, 'u1', 2)
    expect(listPins(db, projectId)).toHaveLength(1)
    unpinMessage(db, sessionPk, 'u1')
    expect(listPins(db, projectId)).toEqual([])
  })

  it('refuses a message it does not have', async () => {
    const { db, sessionPk, projectId } = await indexed(rows)
    expect(pinMessage(db, sessionPk, 'nobody', 1)).toBe(false)
    expect(listPins(db, projectId)).toEqual([])
  })

  it('stay with their project', async () => {
    const { db, sessionPk, projectId } = await indexed(rows)
    pinMessage(db, sessionPk, 'u1', 1)
    expect(listPins(db, projectId + 1)).toEqual([])
  })

  it('hide a message a rewind went past', async () => {
    const { db, sessionPk, projectId } = await indexed(REWOUND)
    pinMessage(db, sessionPk, 'u2', 1)
    pinMessage(db, sessionPk, 'u1', 2)
    expect(listPins(db, projectId).map(p => p.uuid)).toEqual(['u1'])
  })

  it('survive the chat being re-indexed', async () => {
    const { db, sessionPk, projectId, main, file } = await indexed(rows)
    pinMessage(db, sessionPk, 'a1', 1)
    db.prepare('UPDATE sessions SET indexed_offset = 9007199254740991').run()
    await indexFile(db, { ...main, size: statSync(file).size })
    expect(listPins(db, projectId).map(p => p.uuid)).toEqual(['a1'])
  })
})
