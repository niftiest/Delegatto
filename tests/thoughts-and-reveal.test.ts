import { describe, it, expect } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../src/main/catalog/settings'
import { effectiveThinkingDisplay } from '../src/shared/project-options'
import { centeredScrollTop } from '../src/renderer/lib'
import { THEME_KEYS } from '../src/shared/themes'
import { getProjectSettings, updateProjectSettings } from '../src/main/catalog/project-settings'

describe("Claude's thoughts in chats", () => {
  it('show unless told otherwise', () => {
    expect(DEFAULT_SETTINGS.thinkingDisplay).toBe('show')
    expect(effectiveThinkingDisplay('show', null)).toBe('show')
  })
  it("a project's own choice wins, and one that never chose follows Settings", () => {
    expect(effectiveThinkingDisplay('hidden', { thinkingDisplay: 'show' })).toBe('show')
    expect(effectiveThinkingDisplay('show', { thinkingDisplay: 'hidden' })).toBe('hidden')
    expect(effectiveThinkingDisplay('hidden', {})).toBe('hidden')
    expect(effectiveThinkingDisplay('show', null)).toBe('show')
  })
  it('the setting saves, and refuses nonsense', () => {
    const db = openCatalog(':memory:')
    expect(updateSettings(db, { thinkingDisplay: 'hidden' }).thinkingDisplay).toBe('hidden')
    expect(updateSettings(db, { thinkingDisplay: 'perProject' as never }).thinkingDisplay).toBe('hidden')
    expect(updateSettings(db, { thinkingDisplay: 'off' as never }).thinkingDisplay).toBe('hidden')
    expect(getSettings(db).thinkingDisplay).toBe('hidden')
  })
  it('a project remembers it, shared by its chats, and refuses nonsense', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO projects (id, dir_name) VALUES (1, 'p')").run()
    for (const id of [1, 2]) db.prepare("INSERT INTO sessions (id, project_id, session_id, file_path, kind) VALUES (?, 1, ?, ?, 'main')").run(id, `s${id}`, `f${id}`)
    expect(updateProjectSettings(db, 1, { thinkingDisplay: 'hidden' }).thinkingDisplay).toBe('hidden')
    expect(getProjectSettings(db, 2).thinkingDisplay).toBe('hidden')
    expect(updateProjectSettings(db, 1, { thinkingDisplay: 'nope' }).thinkingDisplay).toBeUndefined()
  })
  it('is part of a theme, as how chats look', () => {
    expect(THEME_KEYS).toContain('thinkingDisplay')
  })
})

describe('centering a project in the list', () => {
  // Rows 60 tall, a window onto 600 of 3000: 50 rows.
  const at = (row: number): number => centeredScrollTop(row * 60, 60, 600, 3000)
  it('puts it in the middle', () => {
    expect(at(25)).toBe(25 * 60 - 270)
    expect(at(25) + 270).toBe(25 * 60) // as much list above it as below it
  })
  it('stops at the top for one near the start', () => {
    expect(at(0)).toBe(0)
    expect(at(2)).toBe(0)
  })
  it('scrolls to the very bottom for the last one', () => {
    expect(at(49)).toBe(2400)
    expect(at(48)).toBe(2400)
  })
  it('does nothing when everything already fits', () => {
    expect(centeredScrollTop(120, 60, 600, 300)).toBe(0)
  })
})
