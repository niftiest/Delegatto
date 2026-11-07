// tests/indexer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { runIndex } from '../src/main/indexer/indexer'
import { listProjects, listSessions, listSubagents } from '../src/main/catalog/repos'

let home: string
const SID = '61212a6c-6326-4c06-acd1-fd6d3c3b3003'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-orch-'))
  const proj = join(home, 'projects', 'C--Users-x-GIT-Demo')
  mkdirSync(join(proj, SID, 'subagents'), { recursive: true })
  writeFileSync(join(proj, `${SID}.jsonl`), JSON.stringify({
    type: 'user', uuid: 'u1', parentUuid: null, cwd: 'C:\\Demo',
    timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'hello' }
  }) + '\n')
  writeFileSync(join(proj, SID, 'subagents', 'agent-a.jsonl'), JSON.stringify({
    type: 'user', uuid: 's1', parentUuid: null, message: { role: 'user', content: 'sub work' }
  }) + '\n')
  writeFileSync(join(proj, SID, 'subagents', 'agent-a.meta.json'), JSON.stringify({
    agentType: 'general-purpose', description: 'Explore', toolUseId: 'toolu_01', spawnDepth: 1
  }))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('runIndex', () => {
  it('indexes main transcripts and subagents and links them', async () => {
    const db = openCatalog(':memory:')
    const res = await runIndex(db, { home })
    expect(res.files).toBe(2)
    const [project] = listProjects(db)
    expect(project!.cwd).toBe('C:\\Demo')
    expect(listSessions(db, project!.id)).toHaveLength(1)
    const subs = listSubagents(db, 'toolu_01')
    expect(subs).toHaveLength(1)
  })

  it('reports monotonic progress ending at total', async () => {
    const db = openCatalog(':memory:')
    const seen: number[] = []
    const res = await runIndex(db, { home, onProgress: p => seen.push(p.done) })
    expect(seen).toEqual([1, 2])
    expect(res.files).toBe(2)
  })

  it('skips everything on an unchanged second run', async () => {
    const db = openCatalog(':memory:')
    await runIndex(db, { home })
    const second = await runIndex(db, { home })
    expect(second.skipped).toBe(2)
    expect(second.added).toBe(0)
  })

  it('counts a throwing indexFile as failed, not skipped, and still finishes the archive', async () => {
    // agent-b is discovered as a real file (so discover() records it), but is
    // deleted out from under the indexer between discovery and its own read --
    // deleted from the onProgress callback fired for the (always-first) main
    // transcript, which is guaranteed to complete before any subagent is
    // attempted. That guarantees the ENOENT happens exactly when agent-b's
    // turn comes, regardless of filesystem readdir ordering between subagents.
    const proj = join(home, 'projects', 'C--Users-x-GIT-Demo')
    const corruptPath = join(proj, SID, 'subagents', 'agent-b.jsonl')
    writeFileSync(corruptPath, JSON.stringify({
      type: 'user', uuid: 's2', parentUuid: null, message: { role: 'user', content: 'will be deleted' }
    }) + '\n')

    const db = openCatalog(':memory:')
    const mainPath = join(proj, `${SID}.jsonl`)
    const seen: number[] = []
    const res = await runIndex(db, {
      home,
      onProgress: p => {
        seen.push(p.done)
        if (p.current === mainPath) rmSync(corruptPath)
      }
    })

    expect(res.files).toBe(3)
    expect(res.failed).toBe(1)
    expect(res.added).toBeGreaterThan(0)
    const [project] = listProjects(db)
    expect(project!.cwd).toBe('C:\\Demo')
    // The healthy subagent (agent-a) was still indexed despite agent-b's failure.
    expect(listSubagents(db, 'toolu_01')).toHaveLength(1)
    expect(seen).toEqual([1, 2, 3])
    expect(seen[seen.length - 1]).toBe(res.files)
  })

  it('orders all main transcripts before all subagent transcripts', async () => {
    const ordHome = mkdtempSync(join(tmpdir(), 'cc-order-'))
    try {
      const proj = join(ordHome, 'projects', 'C--Users-x-GIT-Order')
      const sessA = '11111111-1111-1111-1111-111111111111'
      const sessB = '22222222-2222-2222-2222-222222222222'
      mkdirSync(join(proj, sessA, 'subagents'), { recursive: true })
      mkdirSync(join(proj, sessB, 'subagents'), { recursive: true })

      const mainRow = (uuid: string) => JSON.stringify({
        type: 'user', uuid, parentUuid: null, cwd: 'C:\\Order',
        timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'hi' }
      }) + '\n'
      const subRow = (uuid: string) => JSON.stringify({
        type: 'user', uuid, parentUuid: null, message: { role: 'user', content: 'sub' }
      }) + '\n'

      const main1 = join(proj, `${sessA}.jsonl`)
      const main2 = join(proj, `${sessB}.jsonl`)
      writeFileSync(main1, mainRow('m1'))
      writeFileSync(main2, mainRow('m2'))
      const sub1 = join(proj, sessA, 'subagents', 'agent1.jsonl')
      const sub2 = join(proj, sessB, 'subagents', 'agent2.jsonl')
      writeFileSync(sub1, subRow('s1'))
      writeFileSync(sub2, subRow('s2'))

      const db = openCatalog(':memory:')
      const paths: string[] = []
      const res = await runIndex(db, { home: ordHome, onProgress: p => paths.push(p.current) })

      expect(res.files).toBe(4)
      const mainPaths = new Set([main1, main2])
      const subPaths = new Set([sub1, sub2])
      const lastMainIndex = Math.max(...paths.map((p, i) => (mainPaths.has(p) ? i : -1)))
      const firstSubIndex = Math.min(...paths.map((p, i) => (subPaths.has(p) ? i : Infinity)))
      expect(lastMainIndex).toBeLessThan(firstSubIndex)
    } finally {
      rmSync(ordHome, { recursive: true, force: true })
    }
  })
})
