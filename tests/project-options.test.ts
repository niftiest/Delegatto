import { describe, it, expect } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { getProjectSettings, getProjectSettingsByDir, updateProjectSettings } from '../src/main/catalog/project-settings'
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../src/main/catalog/settings'
import { effectiveToolDisplay, shownToolDisplay, suggestionsWanted } from '../src/shared/project-options'
import { parseContextUsage, parseModels } from '../src/main/engine/claude-info'
import { parseEvent } from '../src/main/engine/events'
import { SessionPool } from '../src/main/engine/pool'
import type { SpawnSpec } from '../src/main/engine/transport'
import type { LiveEvent } from '../src/shared/engine-types'

function freshDb() {
  const db = openCatalog(':memory:')
  db.prepare("INSERT INTO projects (id, dir_name) VALUES (1, 'p')").run()
  db.prepare("INSERT INTO sessions (id, project_id, session_id, kind, file_path, file_size, file_mtime_ms) VALUES (7, 1, 's', 'main', 'f', 0, 0)").run()
  return db
}

describe('global setting and per-project choice', () => {
  it("a project's own choice wins, and one that never chose follows Settings", () => {
    expect(effectiveToolDisplay('hidden', { toolDisplay: 'all' })).toBe('all')
    expect(effectiveToolDisplay('grouped', { toolDisplay: 'hidden' })).toBe('hidden')
    expect(effectiveToolDisplay('all', {})).toBe('all')
    expect(effectiveToolDisplay('hidden', null)).toBe('hidden')
  })

  it('turning tool calls back on keeps the way Settings shows them', () => {
    expect(shownToolDisplay('all')).toBe('all')
    expect(shownToolDisplay('grouped')).toBe('grouped')
    expect(shownToolDisplay('hidden')).toBe('grouped')
  })

  it("suggestions follow the same rule, and Claude Code's own off switch beats both", () => {
    expect(suggestionsWanted('on', { promptSuggestions: false }, true)).toBe(false)
    expect(suggestionsWanted('off', { promptSuggestions: true }, true)).toBe(true)
    expect(suggestionsWanted('on', {}, true)).toBe(true)
    expect(suggestionsWanted('off', null, true)).toBe(false)
    expect(suggestionsWanted('on', {}, false)).toBe(false)
    expect(suggestionsWanted('off', { promptSuggestions: true }, false)).toBe(false)
  })

  it('a stored "choose per project" from an older version reads as the default', () => {
    const db = freshDb()
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('toolDisplay', '\"perProject\"'), ('promptSuggestions', '\"perProject\"')").run()
    expect(getSettings(db)).toMatchObject({ toolDisplay: 'grouped', promptSuggestions: 'off' })
    db.close()
  })

  it('defaults: grouped tool calls, suggestions off', () => {
    expect(DEFAULT_SETTINGS.toolDisplay).toBe('grouped')
    expect(DEFAULT_SETTINGS.promptSuggestions).toBe('off')
  })

  it('someone who had hidden tool calls keeps them hidden', () => {
    const db = freshDb()
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('showToolCalls', 'false')").run()
    expect(getSettings(db).toolDisplay).toBe('hidden')
    expect(updateSettings(db, { toolDisplay: 'all' }).toolDisplay).toBe('all')
    db.close()
  })

  it('rejects unknown choices', () => {
    const db = freshDb()
    expect(updateSettings(db, { toolDisplay: 'nope' as never, promptSuggestions: 'nope' as never })).toMatchObject({ toolDisplay: 'grouped', promptSuggestions: 'off' })
    db.close()
  })
})

describe('project settings', () => {
  function folders() {
    const db = freshDb()
    const add = db.prepare("INSERT INTO sessions (id, project_id, session_id, kind, file_path, file_size, file_mtime_ms) VALUES (?, ?, ?, 'main', ?, 0, 0)")
    add.run(8, 1, 'same-folder', 'f8')
    db.prepare("INSERT INTO projects (id, dir_name) VALUES (2, 'other')").run()
    add.run(20, 2, 'elsewhere', 'f20')
    return db
  }

  it('are shared by every chat in the folder, and no other folder', () => {
    const db = folders()
    updateProjectSettings(db, 7, { model: 'opus', skipPermissions: true })
    expect(getProjectSettings(db, 8)).toEqual({ model: 'opus', skipPermissions: true })
    updateProjectSettings(db, 8, { model: 'haiku' })
    expect(getProjectSettings(db, 7)).toEqual({ model: 'haiku', skipPermissions: true })
    expect(getProjectSettings(db, 20)).toEqual({})
    expect(getProjectSettingsByDir(db, 'p')).toEqual({ model: 'haiku', skipPermissions: true })
    expect(getProjectSettingsByDir(db, 'unknown')).toEqual({})
    db.close()
  })

  it('remember what was set, and fields not mentioned stay', () => {
    const db = folders()
    expect(getProjectSettings(db, 7)).toEqual({})
    updateProjectSettings(db, 7, { model: 'opus', skipPermissions: true })
    updateProjectSettings(db, 7, { toolDisplay: 'all' })
    expect(getProjectSettings(db, 7)).toEqual({ model: 'opus', skipPermissions: true, toolDisplay: 'all' })
    db.close()
  })

  it('clear a field set to undefined, and drop anything invalid', () => {
    const db = folders()
    updateProjectSettings(db, 7, { model: 'opus', effort: 'high' })
    expect(updateProjectSettings(db, 7, { model: undefined })).toEqual({ effort: 'high' })
    expect(updateProjectSettings(db, 7, { toolDisplay: 'nope', promptSuggestions: 'yes' })).toEqual({ effort: 'high' })
    db.close()
  })

  it('remember the Files panel for each project separately', () => {
    const db = folders()
    updateProjectSettings(db, 7, { filesExpanded: false })
    updateProjectSettings(db, 20, { filesExpanded: true })
    expect(getProjectSettings(db, 8).filesExpanded).toBe(false)
    expect(getProjectSettings(db, 20).filesExpanded).toBe(true)
    expect(updateProjectSettings(db, 7, { filesExpanded: 'yes' }).filesExpanded).toBeUndefined()
    db.close()
  })

  it('ignore a chat that no longer exists', () => {
    const db = folders()
    expect(updateProjectSettings(db, 999, { model: 'opus' })).toEqual({})
    expect(getProjectSettings(db, 999)).toEqual({})
    db.close()
  })
})

describe('what Claude reports', () => {
  it('models: named by version, without "default"', () => {
    const models = parseModels([
      { value: 'default', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
      { value: 'odd', displayName: 'Odd' }
    ])
    expect(models).toEqual([
      { value: 'opus', label: 'Opus 5.5', description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok', resolved: 'claude-opus-5-5', efforts: ['low', 'high'] },
      { value: 'odd', label: 'Odd', description: '', resolved: null, efforts: [] }
    ])
    expect(parseModels(null)).toEqual([])
  })

  it('context use, biggest first, counting only what is really in use', () => {
    const usage = parseContextUsage({ totalTokens: 22817, maxTokens: 1000000, percentage: 2.3, categories: [
      { name: 'System prompt', tokens: 3303, kind: 'used' }, { name: 'Skills', tokens: 9972, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 601, kind: 'deferred' }, { name: 'Free space', tokens: 944183, kind: 'free' }
    ] })
    expect(usage).toEqual({ usedTokens: 22817, maxTokens: 1000000, percent: 2.3, categories: [{ name: 'Skills', tokens: 9972 }, { name: 'System prompt', tokens: 3303 }] })
    expect(parseContextUsage({ totalTokens: 500, maxTokens: 1000 })?.percent).toBe(50)
    expect(parseContextUsage({})).toBeNull()
  })

  it('suggestions, ignoring empty ones', () => {
    expect(parseEvent('{"type":"prompt_suggestion","suggestion":" run it again "}')).toEqual({ kind: 'suggestion', text: 'run it again' })
    expect(parseEvent('{"type":"prompt_suggestion","suggestion":"  "}')).toEqual({ kind: 'other', type: 'prompt_suggestion' })
  })
})

describe('changing a project\'s settings while a chat\'s process is loaded', () => {
  function pool() {
    const made: Array<{ spec: SpawnSpec; closed: number; sent: object[]; emit: (e: LiveEvent) => void; exit: () => void }> = []
    const p = new SessionPool({
      idleReapMs: 100000,
      transportFactory: spec => {
        let cb: (e: LiveEvent) => void = () => {}
        const exits: Array<(code: number | null) => void> = []
        const t = { spec, closed: 0, sent: [] as object[], emit: (e: LiveEvent) => cb(e), exit: () => { for (const f of exits) f(0) } }
        made.push(t)
        return {
          start() {}, send(m: object) { t.sent.push(m) }, on(f: (e: LiveEvent) => void) { cb = f }, onExit(f: (code: number | null) => void) { exits.push(f) },
          interrupt() {}, close() { t.closed++ }, pid: 1
        } as never
      }
    })
    return { p, made }
  }
  const spec = (o: Partial<SpawnSpec> = {}): SpawnSpec => ({ cwd: 'c', skipPermissions: false, resumeId: 'r', ...o })

  it('starts a new one on the next message, once the old one has exited', () => {
    const { p, made } = pool()
    p.send('k', spec({ model: 'opus' }), { n: 1 })
    made[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
    p.send('k', spec({ model: 'haiku' }), { n: 2 })
    expect(made[0]!.closed).toBe(1)
    expect(made).toHaveLength(1) // its session lock would read as someone else holding the chat
    made[0]!.exit()
    expect(made).toHaveLength(2)
    expect(made[1]!.spec.model).toBe('haiku')
    expect(made[1]!.sent).toEqual([{ n: 2 }])
  })

  it('keeps it when nothing changed, including going from create to resume', () => {
    const { p, made } = pool()
    p.send('k', { cwd: 'c', skipPermissions: false, sessionId: 'r' }, { n: 1 })
    made[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
    p.send('k', { cwd: 'c', skipPermissions: false, resumeId: 'r' }, { n: 2 })
    expect(made).toHaveLength(1)
    expect(made[0]!.sent).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('doesn\'t interrupt a turn in progress', () => {
    const { p, made } = pool()
    p.send('k', spec({ model: 'opus' }), { n: 1 })
    p.send('k', spec({ model: 'haiku' }), { n: 2 })
    expect(made).toHaveLength(1)
    expect(made[0]!.closed).toBe(0)
  })

  it('notices suggestions being turned on', () => {
    const { p, made } = pool()
    p.send('k', spec(), { n: 1 })
    made[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
    p.send('k', spec({ extraArgs: ['--prompt-suggestions'] }), { n: 2 })
    made[0]!.exit()
    expect(made).toHaveLength(2)
  })

  it('keeps messages in order while waiting', () => {
    const { p, made } = pool()
    p.send('k', spec({ model: 'opus' }), { n: 1 })
    made[0]!.emit({ kind: 'result', isError: false, costUsd: 0, text: '' })
    p.send('k', spec({ model: 'haiku' }), { n: 2 })
    p.send('k', spec({ model: 'haiku' }), { n: 3 })
    made[0]!.exit()
    expect(made).toHaveLength(2)
    expect(made[1]!.sent).toEqual([{ n: 2 }, { n: 3 }])
  })
})
