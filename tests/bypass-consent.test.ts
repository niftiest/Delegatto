import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BYPASS_ACCEPT_INDEX, BYPASS_QUESTION, bypassAccepted, recordBypassAccepted } from '../src/main/engine/bypass-consent'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cc-bypass-'))
  const claudeDir = join(root, '.claude'), cwd = join(root, 'proj'), managed = join(root, 'managed-settings.json')
  mkdirSync(claudeDir, { recursive: true }); mkdirSync(join(cwd, '.claude'), { recursive: true })
  const loc = { claudeDir, managedFiles: [managed] }
  const write = (path: string, data: object) => writeFileSync(path, JSON.stringify(data))
  return { root, loc, cwd, managed, write, done: () => rmSync(root, { recursive: true, force: true }) }
}

describe("Claude Code's bypass-mode question", () => {
  it('counts as answered from user, local or managed settings, or the older record', () => {
    const t = setup()
    try {
      expect(bypassAccepted(t.loc, t.cwd, null)).toBe(false)
      t.write(join(t.cwd, '.claude', 'settings.local.json'), { skipDangerousModePermissionPrompt: true })
      expect(bypassAccepted(t.loc, t.cwd, null)).toBe(true)
      rmSync(join(t.cwd, '.claude', 'settings.local.json'))
      t.write(t.managed, { skipDangerousModePermissionPrompt: true })
      expect(bypassAccepted(t.loc, t.cwd, null)).toBe(true)
      rmSync(t.managed)
      expect(bypassAccepted(t.loc, t.cwd, JSON.stringify({ bypassPermissionsModeAccepted: true }))).toBe(true)
      expect(bypassAccepted(t.loc, t.cwd, 'not json')).toBe(false)
    } finally { t.done() }
  })

  it("doesn't count the project's own settings file, which the repository controls", () => {
    const t = setup()
    try {
      t.write(join(t.cwd, '.claude', 'settings.json'), { skipDangerousModePermissionPrompt: true })
      expect(bypassAccepted(t.loc, t.cwd, null)).toBe(false)
    } finally { t.done() }
  })

  it('saying yes records what accepting in a terminal does, keeping the rest of the file', () => {
    const t = setup()
    try {
      t.write(join(t.loc.claudeDir, 'settings.json'), { model: 'opus' })
      recordBypassAccepted(t.loc)
      expect(JSON.parse(readFileSync(join(t.loc.claudeDir, 'settings.json'), 'utf8'))).toEqual({ model: 'opus', skipDangerousModePermissionPrompt: true })
      expect(bypassAccepted(t.loc, t.cwd, null)).toBe(true)
    } finally { t.done() }
  })

  it('defaults to no, as the terminal does', () => {
    expect(BYPASS_QUESTION.defaultIndex).not.toBe(BYPASS_ACCEPT_INDEX)
    expect(BYPASS_QUESTION.cancelIndex).not.toBe(BYPASS_ACCEPT_INDEX)
    expect(BYPASS_QUESTION.buttons[BYPASS_ACCEPT_INDEX]?.label).toBe('Yes, I accept')
  })
})
