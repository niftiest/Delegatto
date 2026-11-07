import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHooksListing, parsePlugins, parseWorkspaceDiff, pluginArgsAllowed } from '../src/shared/command-panels-types'
import { addHook, removeHook } from '../src/main/claude-settings/hooks-edit'
import { exportFileName, exportText } from '../src/main/export-chat'
import { appCommandOf } from '../src/renderer/lib'
import type { RenderItem } from '../src/shared/types'

describe('parseHooksListing', () => {
  it('reads hooks, where each comes from, and which ones can be changed', () => {
    const l = parseHooksListing({
      hooks: [
        { event: 'PostToolUse', matcher: 'Bash', source: 'userSettings', sourceLabel: 'User settings (~/.claude/settings.json)', type: 'command', commandText: 'echo hi', editable: { matcher: 'Bash', config: { type: 'command', command: 'echo hi' } } },
        { event: 'SessionStart', matcher: 'startup', source: 'pluginHook', sourceLabel: 'Plugin hooks', pluginName: 'superpowers@x', type: 'command', displayText: 'run.cmd' },
        { nonsense: true }
      ],
      eventCatalog: [{ name: 'PreToolUse', summary: 'Before tool execution', supportsMatcher: true }, { name: 'Stop', summary: 'x' }],
      policy: { allDisabled: false }
    })
    expect(l.hooks).toHaveLength(2)
    expect(l.hooks[0]).toMatchObject({ event: 'PostToolUse', matcher: 'Bash', scope: 'user', text: 'echo hi', config: { command: 'echo hi' } })
    expect(l.hooks[1]).toMatchObject({ pluginName: 'superpowers@x', scope: null, config: null, text: 'run.cmd' })
    expect(l.catalog[1]).toEqual({ name: 'Stop', summary: 'x', supportsMatcher: false })
    expect(l.policyNote).toBeNull()
    expect(parseHooksListing({ policy: { allDisabled: true } }).policyNote).toMatch(/disableAllHooks/)
    expect(parseHooksListing(null)).toEqual({ hooks: [], catalog: [], policyNote: null })
  })
})

describe('parseWorkspaceDiff', () => {
  it('puts each file with its hunks and says what it compares with', () => {
    const d = parseWorkspaceDiff({ diff: {
      stats: { filesCount: 2, linesAdded: 3, linesRemoved: 1 },
      perFileStats: [{ path: 'a.ts', added: 3, removed: 1, status: 'modified' }, { path: 'b.png', isBinary: true, status: 'added' }],
      hunks: [{ path: 'a.ts', hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 3, lines: [' x', '-y', '+z', 1] }] }],
      skippedLarge: [{ path: 'big.json' }],
      source: { kind: 'branch', baseBranch: 'main' }
    } })
    expect(d.added).toBe(3)
    expect(d.baseBranch).toBe('main')
    expect(d.files[0]!.hunks[0]!.lines).toEqual([' x', '-y', '+z'])
    expect(d.files[1]).toMatchObject({ binary: true, hunks: [] })
    expect(d.skipped).toEqual(['big.json'])
    expect(parseWorkspaceDiff({ diff: { source: { kind: 'uncommitted' } } }).baseBranch).toBeNull()
  })
})

describe('parsePlugins', () => {
  it('reads installed, available and marketplaces', () => {
    const s = parsePlugins(
      { installed: [{ id: 'context7@official', version: '1', scope: 'user', enabled: true, mcpServers: { context7: {} } }], available: [{ pluginId: 'x@official', name: 'x', description: 'X', installCount: 5 }] },
      [{ name: 'official', source: 'github', repo: 'anthropics/plugins' }]
    )
    expect(s.installed[0]).toMatchObject({ name: 'context7', marketplace: 'official', enabled: true, mcpServers: ['context7'] })
    expect(s.available[0]).toMatchObject({ id: 'x@official', installs: 5 })
    expect(s.marketplaces[0]).toEqual({ name: 'official', source: 'github', where: 'anthropics/plugins' })
    // Without --available, the CLI prints just the list.
    expect(parsePlugins([{ id: 'a@b', enabled: false }], []).installed[0]!.name).toBe('a')
  })
})

describe('pluginArgsAllowed', () => {
  it('lets through the /plugin screen’s commands only, with no flag but --scope', () => {
    expect(pluginArgsAllowed(['install', 'x@y', '--scope', 'project'])).toBe(true)
    expect(pluginArgsAllowed(['marketplace', 'add', 'owner/repo'])).toBe(true)
    expect(pluginArgsAllowed(['marketplace', 'update'])).toBe(true)
    expect(pluginArgsAllowed(['install', 'x@y', '-y'])).toBe(false)
    expect(pluginArgsAllowed(['install', '--scope', 'everywhere', 'x'])).toBe(false)
    expect(pluginArgsAllowed(['install'])).toBe(false)
    expect(pluginArgsAllowed(['eval', 'x'])).toBe(false)
    expect(pluginArgsAllowed(['marketplace', 'list'])).toBe(false)
    expect(pluginArgsAllowed('install x')).toBe(false)
  })
})

describe('hooks-edit', () => {
  let dir: string | null = null
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null })
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hooks-'))
    const claudeDir = join(dir, 'home'), project = join(dir, 'proj')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(project, { recursive: true })
    return { loc: { claudeDir, managedFiles: [] }, project, user: join(claudeDir, 'settings.json') }
  }

  it('adds a hook beside what the file already has, and removes it again', () => {
    const { loc, user } = setup()
    writeFileSync(user, JSON.stringify({ model: 'opus', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a' }] }] } }))
    addHook(loc, 'user', null, { event: 'PostToolUse', matcher: 'Bash', command: 'echo b' })
    addHook(loc, 'user', null, { event: 'Stop', matcher: null, command: 'notify' })
    let data = JSON.parse(readFileSync(user, 'utf8'))
    expect(data.model).toBe('opus')
    expect(data.hooks.PostToolUse[0].hooks).toEqual([{ type: 'command', command: 'echo a' }, { type: 'command', command: 'echo b' }])
    expect(data.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'notify' }] }])

    expect(removeHook(loc, 'user', null, { event: 'Stop', matcher: null, config: { type: 'command', command: 'notify' } })).toBe(true)
    expect(removeHook(loc, 'user', null, { event: 'PostToolUse', matcher: 'Bash', config: { type: 'command', command: 'echo a' } })).toBe(true)
    expect(removeHook(loc, 'user', null, { event: 'PostToolUse', matcher: 'Bash', config: { type: 'command', command: 'gone' } })).toBe(false)
    data = JSON.parse(readFileSync(user, 'utf8'))
    expect(data.hooks).toEqual({ PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo b' }] }] })
    removeHook(loc, 'user', null, { event: 'PostToolUse', matcher: 'Bash', config: { type: 'command', command: 'echo b' } })
    expect(JSON.parse(readFileSync(user, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('writes a project’s own files, and refuses an unreadable one', () => {
    const { loc, project } = setup()
    addHook(loc, 'local', project, { event: 'PreToolUse', matcher: 'Edit', command: 'lint' })
    expect(JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8')).hooks.PreToolUse[0].matcher).toBe('Edit')
    writeFileSync(join(project, '.claude', 'settings.json'), '{ broken')
    expect(() => addHook(loc, 'project', project, { event: 'Stop', matcher: null, command: 'x' })).toThrow(/could not be read/)
    expect(() => addHook(loc, 'project', null, { event: 'Stop', matcher: null, command: 'x' })).toThrow(/folder is unknown/)
    expect(() => addHook(loc, 'user', null, { event: 'Stop', matcher: null, command: '  ' })).toThrow(/command/)
  })
})

describe('exportText', () => {
  it('writes the chat the way Claude Code’s /export does', () => {
    const items: RenderItem[] = [
      { kind: 'text', uuid: '1', role: 'user', ts: null, model: null, text: 'list files' },
      { kind: 'thinking', uuid: '2', ts: null, text: 'hmm' },
      { kind: 'tool', uuid: '3', toolUseId: 't', name: 'Bash', input: { command: 'ls' }, result: { text: 'a\nb', isError: false }, subagentToolUseId: null },
      { kind: 'text', uuid: '4', role: 'assistant', ts: null, model: null, text: 'Two files:\na and b' }
    ]
    const text = exportText(items, { title: 'My chat', cwd: 'D:/x' })
    expect(text).toBe('# My chat\n\nFolder: D:/x\n\n> list files\n\n⏺ Bash(ls)\n  ⎿  a\n     b\n\n⏺ Two files:\n  a and b\n')
    expect(text).not.toContain('hmm')
  })
  it('names the file as Claude Code does', () => {
    expect(exportFileName(new Date(2026, 10, 6, 9, 5, 3))).toBe('conversation-2026-11-06-090503.txt')
  })
})

describe('appCommandOf: hooks, diff, tasks, export, plugin', () => {
  it('opens Delegatto’s screens', () => {
    expect(appCommandOf('/hooks')).toEqual({ kind: 'hooks' })
    expect(appCommandOf('/diff')).toEqual({ kind: 'diff' })
    expect(appCommandOf('/bashes')).toEqual({ kind: 'tasks' })
    expect(appCommandOf('/export')).toEqual({ kind: 'export', fileName: '' })
    expect(appCommandOf('/export notes.md')).toEqual({ kind: 'export', fileName: 'notes.md' })
    expect(appCommandOf('/plugin')).toEqual({ kind: 'settings', section: 'plugins' })
    expect(appCommandOf('/plugins manage')).toEqual({ kind: 'settings', section: 'plugins' })
    expect(appCommandOf('/marketplace')).toEqual({ kind: 'settings', section: 'plugins' })
  })
  it('runs plugin subcommands at once', () => {
    expect(appCommandOf('/plugin install x@y')).toEqual({ kind: 'pluginAction', args: ['install', 'x@y'] })
    expect(appCommandOf('/plugin rm x')).toEqual({ kind: 'pluginAction', args: ['uninstall', 'x'] })
    expect(appCommandOf('/plugin marketplace add owner/repo')).toEqual({ kind: 'pluginAction', args: ['marketplace', 'add', 'owner/repo'] })
    expect(appCommandOf('/marketplace update')).toEqual({ kind: 'pluginAction', args: ['marketplace', 'update'] })
    expect(appCommandOf('/plugin install')).toEqual({ kind: 'settings', section: 'plugins' })
  })
})
