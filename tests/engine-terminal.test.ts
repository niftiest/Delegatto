import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromeEnabledFor, claudeChromeDefault, terminalCommand } from '../src/main/engine/terminal'
import { buildArgs } from '../src/main/engine/transport'

const SID = '61212a6c-6326-4c06-acd1-fd6d3c3b3003'
const DIR = String.raw`D:\GIT\My App`
const WT = String.raw`C:\wt.exe`

describe('Claude in Chrome', () => {
  it('reads the user default from .claude.json, failing closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-chrome-'))
    try {
      const f = join(dir, '.claude.json')
      writeFileSync(f, JSON.stringify({ claudeInChromeDefaultEnabled: true }))
      expect(claudeChromeDefault(f)).toBe(true)
      writeFileSync(f, JSON.stringify({ claudeInChromeDefaultEnabled: false }))
      expect(claudeChromeDefault(f)).toBe(false)
      writeFileSync(f, '{not json')
      expect(claudeChromeDefault(f)).toBe(false)
      expect(claudeChromeDefault(join(dir, 'missing.json'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('auto follows the user default; on/off override it', () => {
    expect(chromeEnabledFor('auto', () => true)).toBe(true)
    expect(chromeEnabledFor('auto', () => false)).toBe(false)
    expect(chromeEnabledFor('on', () => false)).toBe(true)
    expect(chromeEnabledFor('off', () => true)).toBe(false)
  })

  it('passes --chrome to the headless run only when enabled', () => {
    expect(buildArgs({ cwd: DIR, skipPermissions: true, chrome: true })).toContain('--chrome')
    expect(buildArgs({ cwd: DIR, skipPermissions: true })).not.toContain('--chrome')
  })
})

describe('terminalCommand', () => {
  it('uses Windows Terminal when available', () => {
    expect(terminalCommand(DIR, SID, 'claude', WT)).toEqual({
      file: WT, args: ['-d', DIR, 'claude', '--resume', SID], verbatim: false
    })
  })

  it('falls back to a console window with quoted paths', () => {
    const c = terminalCommand(DIR, SID, 'claude', null)
    expect(c.file).toBe('cmd.exe')
    expect(c.verbatim).toBe(true)
    expect(c.args[0]).toBe(`/d /c start "Claude Code" /D "${DIR}" cmd /k "claude" --resume ${SID}`)
  })

  it('refuses values that could break out of the command line', () => {
    expect(() => terminalCommand(`${DIR}" & calc`, SID, 'claude', null)).toThrow()
    expect(() => terminalCommand(DIR, 'abc; calc', 'claude', null)).toThrow()
    expect(() => terminalCommand(DIR, SID, 'claude & calc', null)).toThrow()
  })
})
