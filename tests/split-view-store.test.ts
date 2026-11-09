import { describe, it, expect } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { upsertProject, setProjectCwd, upsertSession } from '../src/main/catalog/repos'
import { setFriendlyName } from '../src/main/catalog/metadata'
import { loadSplitState, saveSplitState, splitPaneNames, withPaneProjects } from '../src/main/catalog/split-view-store'
import { coerceSplitState, type SplitState } from '../src/shared/split-view'

function seed() {
  const db = openCatalog(':memory:')
  const p = upsertProject(db, 'C--GIT-PlantPal')
  setProjectCwd(db, p, 'C:\\GIT\\PlantPal')
  const q = upsertProject(db, 'C--GIT-ledger')
  setProjectCwd(db, q, 'C:\\GIT\\ledger')
  const a = upsertSession(db, { projectId: p, sessionId: 'a', kind: 'main', filePath: '/f/a.jsonl', fileSize: 1, fileMtimeMs: 1 })
  const b = upsertSession(db, { projectId: q, sessionId: 'b', kind: 'main', filePath: '/f/b.jsonl', fileSize: 1, fileMtimeMs: 1 })
  return { db, a, b }
}

const state = (a: number, b: number): SplitState => ({
  layout: 'halves',
  ratios: { halves: { col: 0.4, row: 0.5 } },
  panes: [{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, { sessionPk: b, projectDir: 'C--GIT-ledger' }],
  bounds: { x: 10, y: 20, width: 1200, height: 800 },
  maximized: true,
  minimized: false,
  open: true
})

describe('split view store', () => {
  it('loads what it saved', () => {
    const { db, a, b } = seed()
    saveSplitState(db, state(a, b))
    expect(loadSplitState(db)).toEqual(state(a, b))
  })

  it('loads null when nothing is saved', () => {
    const { db } = seed()
    expect(loadSplitState(db)).toBeNull()
  })

  it('loads null when the saved row is not JSON', () => {
    const { db } = seed()
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('splitView', '{not json')").run()
    expect(loadSplitState(db)).toBeNull()
  })

  it('empties the slot of a chat that has been deleted', () => {
    const { db, a, b } = seed()
    saveSplitState(db, state(a, b))
    db.prepare('DELETE FROM sessions WHERE id = ?').run(b)
    expect(loadSplitState(db)?.panes).toEqual([{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, null])
  })

  it('takes each pane\'s project from its chat, whatever the window said', () => {
    const { db, a, b } = seed()
    const sent = [
      { sessionPk: a, projectDir: 'C--GIT-ledger' }, // the wrong project
      null,
      { sessionPk: b }, // none at all
      { sessionPk: 9999, projectDir: 'C--GIT-PlantPal' }, // a chat that isn't there
      'junk'
    ]
    expect(withPaneProjects(db, sent)).toEqual([
      { sessionPk: a, projectDir: 'C--GIT-PlantPal' },
      null,
      { sessionPk: b, projectDir: 'C--GIT-ledger' },
      null,
      null
    ])
  })

  it('so a second pane on the same project can\'t get in by naming another one', () => {
    const { db, a } = seed()
    const c = upsertSession(db, { projectId: upsertProject(db, 'C--GIT-PlantPal'), sessionId: 'c', kind: 'main', filePath: '/f/c.jsonl', fileSize: 1, fileMtimeMs: 1 })
    const panes = withPaneProjects(db, [{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, { sessionPk: c, projectDir: 'C--GIT-ledger' }])
    const exists = (pk: number): boolean => pk === a || pk === c
    expect(coerceSplitState({ ...state(a, c), panes }, exists)?.panes).toEqual([{ sessionPk: a, projectDir: 'C--GIT-PlantPal' }, null])
  })

  it('names each pane by its project, preferring the given name', () => {
    const { db, a, b } = seed()
    setFriendlyName(db, 'C--GIT-ledger', 'LedgerLite')
    expect(splitPaneNames(db, [{ sessionPk: a, projectDir: 'x' }, null, { sessionPk: b, projectDir: 'y' }, { sessionPk: 9999, projectDir: 'z' }]))
      .toEqual(['PlantPal', null, 'LedgerLite', null])
  })
})
