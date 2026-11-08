import { describe, it, expect } from 'vitest'
import { delimiter, join } from 'node:path'
import { findClaude } from '../src/main/engine/find-claude'
import { spawnErrorNotice } from '../src/renderer/lib'

const home = join('C:', 'Users', 'me')
const installed = join(home, '.local', 'bin', 'claude.exe')
const onPathDir = join('C:', 'tools')
const has = (...files: string[]) => (file: string): boolean => files.includes(file)

describe('finding Claude Code', () => {
  it('uses PATH when it is there', () => {
    expect(findClaude('claude', { path: onPathDir, home, exists: has(join(onPathDir, 'claude.exe'), installed) })).toEqual({ bin: 'claude', found: true })
  })

  it("falls back to where Windows' installer puts it", () => {
    expect(findClaude('claude', { path: onPathDir, home, exists: has(installed) })).toEqual({ bin: installed, found: true })
  })

  it('says so when it is nowhere', () => {
    expect(findClaude('claude', { path: onPathDir, home, exists: has() })).toEqual({ bin: 'claude', found: false })
  })

  it('looks through every folder on PATH, and copes with an empty one', () => {
    const path = ['', onPathDir, join('C:', 'other')].join(delimiter)
    expect(findClaude('claude', { path, home, exists: has(join('C:', 'other', 'claude.exe')) }).found).toBe(true)
  })

  it('does not count a .cmd, which starting a program directly cannot run', () => {
    expect(findClaude('claude', { path: onPathDir, home, exists: has(join(onPathDir, 'claude.cmd')) }).found).toBe(false)
  })

  it("leaves a path the user chose alone, and reports if it's missing", () => {
    const mine = join('D:', 'mine', 'claude.exe')
    expect(findClaude(mine, { path: '', home, exists: has(mine) })).toEqual({ bin: mine, found: true })
    expect(findClaude(mine, { path: '', home, exists: has(installed) })).toEqual({ bin: mine, found: false })
  })

  it('does not fall back from a different name the user chose', () => {
    expect(findClaude('claude-beta', { path: onPathDir, home, exists: has(installed) })).toEqual({ bin: 'claude-beta', found: false })
  })
})

describe('when Claude Code will not start', () => {
  it('says what to do if it cannot be found', () => {
    const notice = spawnErrorNotice('spawn claude ENOENT')
    expect(notice).toContain("Claude Code isn't installed, or Delegatto can't find it")
    expect(notice).toContain('https://code.claude.com/docs/en/setup')
    expect(notice).not.toContain('ENOENT')
  })

  it('passes on any other reason', () => {
    expect(spawnErrorNotice('spawn EPERM')).toBe("Claude couldn't start: spawn EPERM")
  })
})

describe('when the chat folder is gone', () => {
  it('names the folder instead of blaming Claude Code', () => {
    const notice = spawnErrorNotice('folder-missing D:\GIT\HotspotProxy')
    expect(notice).toContain('D:\GIT\HotspotProxy')
    expect(notice).not.toContain("isn't installed")
  })
})
