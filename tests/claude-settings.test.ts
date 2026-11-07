import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addAllowRule, readSettingsText, readSettingsView, settingsPath, validateSetting, writeSettings, writeSettingsText, type SettingsLocations
} from '../src/main/claude-settings/files'
import { daysFor, findCandidates, isPolicyActive, previewOf, readRetentionStatus, runAutoClean, DAY_MS } from '../src/main/claude-settings/retention'
import { openCatalog } from '../src/main/catalog/db'
import { encodePath } from '../src/main/manage/paths'
import { permanentRemover } from '../src/main/manage/fs-util'
import type { FileRemover } from '../src/main/manage/types'
import { FakeClaudeTree } from './manage/fake-tree'

let root: string
let loc: SettingsLocations
let cwd: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-settings-'))
  loc = { claudeDir: join(root, '.claude'), managedFiles: [join(root, 'managed-settings.json')] }
  mkdirSync(loc.claudeDir, { recursive: true })
  cwd = join(root, 'work', 'app')
  mkdirSync(cwd, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>

describe('Claude Code settings files', () => {
  it('writes only the keys it is given and keeps everything else', () => {
    const user = settingsPath(loc, { scope: 'user' })
    writeFileSync(user, JSON.stringify({ hooks: { Stop: [] }, permissions: { allow: ['Read'], additionalDirectories: ['D:\\x'] }, env: { A: '1' } }))
    writeSettings(loc, { scope: 'user' }, { model: 'opus', 'permissions.defaultMode': 'plan' })
    const after = readJson(user)
    expect(after.model).toBe('opus')
    expect(after.hooks).toEqual({ Stop: [] })
    expect(after.env).toEqual({ A: '1' })
    expect(after.permissions).toEqual({ allow: ['Read'], additionalDirectories: ['D:\\x'], defaultMode: 'plan' })
    // The user file was backed up first.
    expect(readdirSync(join(loc.claudeDir, 'backups', 'delegatto')).length).toBe(1)
  })

  it('null removes a key and an emptied parent object', () => {
    writeSettings(loc, { scope: 'user' }, { 'attribution.commit': '', 'attribution.pr': '' })
    expect(readJson(settingsPath(loc, { scope: 'user' })).attribution).toEqual({ commit: '', pr: '' })
    writeSettings(loc, { scope: 'user' }, { 'attribution.commit': null, 'attribution.pr': null })
    expect(readJson(settingsPath(loc, { scope: 'user' })).attribution).toBeUndefined()
  })

  it('never writes a file that is not valid JSON', () => {
    const user = settingsPath(loc, { scope: 'user' })
    writeFileSync(user, '{ "model": "opus", ')
    expect(() => writeSettings(loc, { scope: 'user' }, { model: 'sonnet' })).toThrow(/could not be read/)
    expect(readFileSync(user, 'utf8')).toBe('{ "model": "opus", ')
    expect(readSettingsView(loc, { scope: 'user' }).error).toMatch(/Not valid JSON/)
  })

  it('validates values and refuses unknown or user-only keys in a project', () => {
    expect(validateSetting('cleanupPeriodDays', 0).ok).toBe(false)
    expect(validateSetting('cleanupPeriodDays', 3650).ok).toBe(true)
    expect(validateSetting('effortLevel', 'turbo').ok).toBe(false)
    expect(validateSetting('effortLevel', 'max').ok).toBe(false) // Claude Code drops it from settings
    expect(validateSetting('permissions.allow', ['Read', ' Read ', '']).ok && validateSetting('permissions.allow', ['Read', ' Read ', '']))
      .toEqual({ ok: true, value: ['Read'] })
    expect(() => writeSettings(loc, { scope: 'user' }, { hooks: {} } as never)).toThrow(/not a setting/)
    expect(() => writeSettings(loc, { scope: 'project', cwd }, { cleanupPeriodDays: 10 })).toThrow(/all projects/)
    // ...but clearing a stray project override is allowed.
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7, model: 'haiku' }))
    writeSettings(loc, { scope: 'project', cwd }, { cleanupPeriodDays: null })
    expect(readJson(join(cwd, '.claude', 'settings.json'))).toEqual({ model: 'haiku' })
  })

  it('effective values follow managed > local > project > user, and lists merge', () => {
    writeFileSync(settingsPath(loc, { scope: 'user' }), JSON.stringify({ model: 'opus', effortLevel: 'high', permissions: { allow: ['Read'] } }))
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', permissions: { allow: ['Bash(npm test)'] } }))
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ model: 'haiku' }))
    writeFileSync(loc.managedFiles[0]!, JSON.stringify({ effortLevel: 'low' }))
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { db: {}, web: {} } }))

    const v = readSettingsView(loc, { scope: 'project', cwd })
    expect(v.own.model).toBe('sonnet')
    expect(v.effective.model).toEqual({ value: 'haiku', source: 'local' })
    expect(v.effective.effortLevel).toEqual({ value: 'low', source: 'managed' })
    expect(v.lists['permissions.allow']).toEqual([{ value: 'Read', source: 'user' }, { value: 'Bash(npm test)', source: 'project' }])
    expect(v.projectMcpServers).toEqual(['db', 'web'])
    expect(readSettingsView(loc, { scope: 'user' }).effective.model).toEqual({ value: 'opus', source: 'user' })
  })

  it('"allow always" lands in the project local file and keeps it out of git', () => {
    mkdirSync(join(cwd, '.git', 'info'), { recursive: true })
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude')
    addAllowRule(loc, cwd, 'Bash(npm test:*)')
    addAllowRule(loc, cwd, 'Bash(npm test:*)')
    addAllowRule(loc, cwd, 'WebFetch(domain:github.com)')
    expect(readJson(join(cwd, '.claude', 'settings.local.json'))).toEqual({ permissions: { allow: ['Bash(npm test:*)', 'WebFetch(domain:github.com)'] } })
    const exclude = readFileSync(join(cwd, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter(l => l === '.claude/settings.local.json')).toHaveLength(1)
  })
})

describe('editing a settings file directly', () => {
  it('reads an empty object when there is no file yet', () => {
    const r = readSettingsText(loc, { scope: 'user' })
    expect(r.path).toBe(settingsPath(loc, { scope: 'user' }))
    expect(JSON.parse(r.text)).toEqual({})
  })

  it('saves exactly what was typed, with a final newline, and backs up the user file first', () => {
    const user = settingsPath(loc, { scope: 'user' })
    writeFileSync(user, '{"model":"opus"}\n')
    writeSettingsText(loc, { scope: 'user' }, '{\n  // kept out\n}'.replace('  // kept out\n', '  "effortLevel": "high"\n'))
    expect(readFileSync(user, 'utf8')).toBe('{\n  "effortLevel": "high"\n}\n')
    expect(readdirSync(join(loc.claudeDir, 'backups', 'delegatto')).length).toBe(1)
  })

  it.each([['{ not json', /valid JSON/], ['[1,2]', /JSON object/], ['null', /JSON object/]])('refuses %s and leaves the file alone', (text, message) => {
    const user = settingsPath(loc, { scope: 'user' })
    writeFileSync(user, '{"model":"opus"}\n')
    expect(() => writeSettingsText(loc, { scope: 'user' }, text)).toThrow(message)
    expect(readFileSync(user, 'utf8')).toBe('{"model":"opus"}\n')
  })
})

describe('chat retention', () => {
  it('reads Claude Code cleanupPeriodDays and project overrides', () => {
    expect(readRetentionStatus(loc, [cwd])).toEqual({ claudeDays: 30, claudeDaysSet: false, overrides: [] })
    writeFileSync(settingsPath(loc, { scope: 'user' }), JSON.stringify({ cleanupPeriodDays: 3650 }))
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ cleanupPeriodDays: 7 }))
    const s = readRetentionStatus(loc, [cwd, cwd.toUpperCase()])
    expect(s.claudeDays).toBe(3650)
    expect(s.claudeDaysSet).toBe(true)
    expect(s.overrides).toEqual([{ cwd, file: join(cwd, '.claude', 'settings.local.json'), days: 7 }])
  })

  it('per-project days override the global setting; null means never', () => {
    const p = { globalDays: 90, projects: { keep: null, short: 7 } }
    expect(daysFor(p, 'other')).toBe(90)
    expect(daysFor(p, 'keep')).toBeNull()
    expect(daysFor(p, 'short')).toBe(7)
    expect(isPolicyActive({ globalDays: null, projects: {} })).toBe(false)
    expect(isPolicyActive({ globalDays: null, projects: { a: null } })).toBe(false)
    expect(isPolicyActive({ globalDays: null, projects: { a: 5 } })).toBe(true)
  })

  it('finds old chats, then sends them to the Recycle Bin and drops them from the catalog', async () => {
    const t = new FakeClaudeTree()
    try {
      const work = t.workDir('proj')
      const dir = encodePath(work)
      const now = Date.now()
      const oldFile = t.addSession(work, '11111111-1111-1111-1111-111111111111')
      const liveFile = t.addSession(work, '22222222-2222-2222-2222-222222222222')
      const newFile = t.addSession(work, '33333333-3333-3333-3333-333333333333')
      const ownedFile = t.addSession(work, '44444444-4444-4444-4444-444444444444')
      mkdirSync(join(t.paths.projectsDir, dir, '11111111-1111-1111-1111-111111111111', 'subagents'), { recursive: true })
      const old = new Date(now - 100 * DAY_MS)
      for (const f of [oldFile, liveFile, ownedFile]) utimesSync(f, old, old)

      const db = openCatalog(':memory:')
      db.prepare('INSERT INTO projects (dir_name, cwd) VALUES (?, ?)').run(dir, work)
      const pid = (db.prepare('SELECT id FROM projects').get() as { id: number }).id
      const ins = db.prepare(`INSERT INTO sessions (project_id, session_id, kind, file_path) VALUES (?, ?, 'main', ?)`)
      for (const f of [oldFile, liveFile, newFile, ownedFile]) ins.run(pid, f.split(/[\\/]/).pop()!.replace('.jsonl', ''), f)

      expect(findCandidates(db, { globalDays: null, projects: {} }, now)).toEqual([])
      expect(findCandidates(db, { globalDays: 90, projects: { [dir]: null } }, now)).toEqual([])
      const cands = findCandidates(db, { globalDays: 90, projects: {} }, now)
      expect(cands.map(c => c.filePath).sort()).toEqual([oldFile, liveFile, ownedFile].sort())
      expect(previewOf(cands).count).toBe(3)

      const trashed: string[] = []
      const remover: FileRemover = {
        ...permanentRemover,
        async removeFile(p) { trashed.push(p); await permanentRemover.removeFile(p) },
        async removeDirectory(p) { trashed.push(p); await permanentRemover.removeDirectory(p) },
        recyclable: () => true
      }
      const r = await runAutoClean(db, cands, {
        paths: t.paths, remover,
        live: () => [{ pid: 1, sessionId: '22222222-2222-2222-2222-222222222222', cwd: work, name: null, startedAt: null, kind: null, entrypoint: null } as never],
        ownedSessionIds: () => ['44444444-4444-4444-4444-444444444444']
      })
      expect(r.removed).toBe(1)
      expect(r.skipped).toBe(2)
      expect(r.errors).toEqual([])
      expect(existsSync(oldFile)).toBe(false)
      expect(existsSync(join(t.paths.projectsDir, dir, '11111111-1111-1111-1111-111111111111'))).toBe(false)
      expect(existsSync(liveFile) && existsSync(newFile) && existsSync(ownedFile)).toBe(true)
      expect(trashed).toContain(oldFile)
      const left = (db.prepare('SELECT file_path AS f FROM sessions').all() as { f: string }[]).map(x => x.f).sort()
      expect(left).toEqual([liveFile, newFile, ownedFile].sort())
    } finally { t.dispose() }
  })

  it('never deletes a chat permanently', async () => {
    const t = new FakeClaudeTree()
    try {
      const work = t.workDir('proj')
      const f = t.addSession(work, '55555555-5555-5555-5555-555555555555')
      const old = new Date(Date.now() - 100 * DAY_MS)
      utimesSync(f, old, old)
      const db = openCatalog(':memory:')
      db.prepare('INSERT INTO projects (dir_name, cwd) VALUES (?, ?)').run(encodePath(work), work)
      db.prepare(`INSERT INTO sessions (project_id, session_id, kind, file_path) VALUES (1, '55555555-5555-5555-5555-555555555555', 'main', ?)`).run(f)
      const cands = findCandidates(db, { globalDays: 30, projects: {} }, Date.now())
      const r = await runAutoClean(db, cands, { paths: t.paths, remover: { ...permanentRemover, recyclable: () => false }, live: () => [], ownedSessionIds: () => [] })
      expect(r).toMatchObject({ removed: 0, skipped: 1 })
      expect(existsSync(f)).toBe(true)
    } finally { t.dispose() }
  })
})
