import { describe, it, expect } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../src/main/catalog/settings'
import { applyTheme, cleanThemeValues, deleteTheme, hasTheme, listThemes, parseThemeFile, saveTheme, themeFileText } from '../src/main/catalog/themes'
import { THEME_KEYS, activeCustomTheme, cleanThemeName, isBuiltInThemeName, sameThemeName, themeFileName, themeIsModified, themeNameFromPath, themeValuesOf } from '../src/shared/themes'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('theme names', () => {
  it('tidies a name, and refuses an empty or long one', () => {
    expect(cleanThemeName('  My   theme ')).toBe('My theme')
    expect(cleanThemeName('a\nb')).toBe('a b')
    expect(cleanThemeName('   ')).toBeNull()
    expect(cleanThemeName('x'.repeat(61))).toBeNull()
    expect(cleanThemeName('x'.repeat(60))).toHaveLength(60)
    expect(cleanThemeName(5)).toBeNull()
  })
  it('knows the built-ins, whichever way they are written', () => {
    for (const name of ['Paper', 'paper', 'SLATE', 'Terminal', 'Paper (light, default)', 'slate & teal', 'Terminal (Claude Code)']) expect(isBuiltInThemeName(name)).toBe(true)
    expect(isBuiltInThemeName('Slate 2')).toBe(false)
  })
  it('treats case as the same name', () => {
    expect(sameThemeName('Mine', 'MINE')).toBe(true)
    expect(sameThemeName('Mine', 'Mine 2')).toBe(false)
  })
  it('makes a file name Windows accepts, and reads one back', () => {
    expect(themeFileName('a/b:c?')).toBe('a_b_c_.delegatto-theme')
    expect(themeFileName('...')).toBe('theme.delegatto-theme')
    expect(themeNameFromPath('D:\\x\\My theme.delegatto-theme')).toBe('My theme')
    expect(themeNameFromPath('/x/Other.JSON')).toBe('Other')
  })
})

describe('what a theme holds', () => {
  it('is how the app looks: not text sizes, and nothing that spends money or runs anything', () => {
    for (const key of ['chatFontScale', 'sidebarFontScale', 'promptSuggestions', 'openRouterKey', 'extraFlags', 'claudeBin', 'defaultSkipPermissions', 'startWithAdmin', 'trustedFolders', 'activeTheme']) {
      expect(THEME_KEYS).not.toContain(key)
    }
  })
  it('keeps only theme settings from a file, and only valid ones', () => {
    expect(cleanThemeValues({
      theme: 'slate', chatFontScale: 130, appFont: 'Verdana',
      extraFlags: ['--dangerously-skip-permissions'], openRouterKey: 'x', promptSuggestions: 'on', defaultSkipPermissions: true, startWithAdmin: true
    })).toEqual({ theme: 'slate', appFont: 'Verdana' })
    expect(cleanThemeValues({ theme: 'neon', density: 'huge', showBlade: 'yes' })).toEqual({})
    expect(cleanThemeValues(null)).toEqual({})
    expect(cleanThemeValues(['theme'])).toEqual({})
  })
  it('leaves text sizes out', () => {
    expect(cleanThemeValues({ chatFontScale: 150, sidebarFontScale: 150 })).toEqual({})
  })
  it('refuses a font that could break out of the CSS', () => {
    expect(cleanThemeValues({ appFont: 'x"; } body { display:none' })).toEqual({})
  })
  it('refuses an avatar or color that would fetch from the internet', () => {
    expect(cleanThemeValues({ claudeIcon: { kind: 'image', dataUrl: 'https://evil.example/x.png' } })).toEqual({})
    expect(cleanThemeValues({ claudeIcon: { kind: 'image', dataUrl: 'data:image/svg+xml;base64,AAAA' } })).toEqual({})
    expect(cleanThemeValues({ claudeIcon: { kind: 'color', color: 'url(https://evil.example/x)' } })).toEqual({})
    expect(cleanThemeValues({ claudeIcon: { kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(400 * 1024)}` } })).toEqual({})
  })
  it('keeps an ordinary avatar', () => {
    expect(cleanThemeValues({ claudeIcon: { kind: 'image', dataUrl: PNG } })).toEqual({ claudeIcon: { kind: 'image', dataUrl: PNG } })
    expect(cleanThemeValues({ claudeIcon: { kind: 'color', color: '#5865F2' } })).toEqual({ claudeIcon: { kind: 'color', color: '#5865F2' } })
    expect(cleanThemeValues({ claudeIcon: { kind: 'emoji', emoji: '🦊' } })).toEqual({ claudeIcon: { kind: 'emoji', emoji: '🦊' } })
    expect(cleanThemeValues({ claudeIcon: { kind: 'initials' } })).toEqual({ claudeIcon: { kind: 'initials' } })
  })
  it('ignores an inherited property', () => {
    expect(cleanThemeValues(Object.create({ theme: 'slate' }))).toEqual({})
  })
})

describe('saving and choosing themes', () => {
  it('starts with none', () => {
    const db = openCatalog(':memory:')
    expect(listThemes(db)).toEqual([])
    expect(getSettings(db).activeTheme).toBeNull()
    expect(DEFAULT_SETTINGS.activeTheme).toBeNull()
  })

  it('saves the current look and selects it', () => {
    const db = openCatalog(':memory:')
    updateSettings(db, { theme: 'slate', chatFontScale: 130, appFont: 'Verdana', navDensity: 'compact' })
    const r = saveTheme(db, 'Mine', null)
    expect(r.settings.activeTheme).toBe('Mine')
    expect(r.themes).toHaveLength(1)
    expect(r.themes[0]!.values).toMatchObject({ theme: 'slate', appFont: 'Verdana', navDensity: 'compact' })
    expect(r.themes[0]!.values).not.toHaveProperty('chatFontScale')
  })

  it('choosing one sets everything it holds, and leaves other settings and text sizes alone', () => {
    const db = openCatalog(':memory:')
    updateSettings(db, { theme: 'slate', appFont: 'Verdana', chatFontScale: 130, defaultSkipPermissions: false, promptSuggestions: 'on' })
    saveTheme(db, 'Mine', null)
    updateSettings(db, { theme: 'paper', appFont: '', chatFontScale: 150, activeTheme: null })
    const after = applyTheme(db, 'mine')!
    expect(after).toMatchObject({ theme: 'slate', appFont: 'Verdana', chatFontScale: 150, activeTheme: 'Mine', defaultSkipPermissions: false, promptSuggestions: 'on' })
  })

  it('a theme that is gone changes nothing', () => {
    const db = openCatalog(':memory:')
    expect(applyTheme(db, 'nope')).toBeNull()
  })

  it('saving under an existing name replaces it, with no duplicate', () => {
    const db = openCatalog(':memory:')
    updateSettings(db, { appFont: 'Arial' })
    saveTheme(db, 'Mine', null)
    updateSettings(db, { appFont: 'Verdana' })
    const r = saveTheme(db, 'MINE', null)
    expect(r.themes).toHaveLength(1)
    expect(r.themes[0]).toMatchObject({ name: 'MINE', values: { appFont: 'Verdana' } })
    expect(hasTheme(db, 'mine')).toBe(true)
  })

  it('never lets a built-in be saved over, even called directly', () => {
    const db = openCatalog(':memory:')
    expect(() => saveTheme(db, 'Ember', null)).toThrow(/built-in/)
    expect(() => saveTheme(db, 'paper (light, default)', null)).toThrow(/built-in/)
    expect(() => saveTheme(db, '   ', null)).toThrow()
    expect(listThemes(db)).toEqual([])
  })

  it('lists them by name', () => {
    const db = openCatalog(':memory:')
    for (const n of ['b', 'C', 'a']) saveTheme(db, n, null)
    expect(listThemes(db).map(t => t.name)).toEqual(['a', 'b', 'C'])
  })

  it('deleting leaves the look as it is', () => {
    const db = openCatalog(':memory:')
    updateSettings(db, { appFont: 'Verdana' })
    saveTheme(db, 'Mine', null)
    const r = deleteTheme(db, 'Mine')
    expect(r.themes).toEqual([])
    expect(r.settings).toMatchObject({ appFont: 'Verdana', activeTheme: null })
  })

  it('deleting another theme keeps the one in use', () => {
    const db = openCatalog(':memory:')
    saveTheme(db, 'Other', null)
    saveTheme(db, 'Mine', null)
    expect(deleteTheme(db, 'Other').settings.activeTheme).toBe('Mine')
  })

  it('a broken store reads as none, and a setting patch cannot reach it', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('customThemes', 'not json')").run()
    expect(listThemes(db)).toEqual([])
    expect(getSettings(db)).toEqual(DEFAULT_SETTINGS)
    updateSettings(db, { customThemes: [{ name: 'x', values: {} }] } as never)
    expect(listThemes(db)).toEqual([])
  })

  it('stored junk is checked again on the way out', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO settings_kv (key, value) VALUES ('customThemes', ?)").run(JSON.stringify([
      { name: 'ok', values: { theme: 'slate', extraFlags: ['--x'] } }, { name: '' }, null, 5
    ]))
    expect(listThemes(db)).toEqual([{ name: 'ok', values: { theme: 'slate' } }])
  })
})

describe('telling when a theme has been changed', () => {
  it('notices a change to what it holds, and only that', () => {
    const db = openCatalog(':memory:')
    const { themes, settings } = saveTheme(db, 'Mine', null)
    const theme = themes[0]!
    expect(activeCustomTheme(settings, themes)).toEqual(theme)
    expect(themeIsModified(settings, theme)).toBe(false)
    expect(themeIsModified({ ...settings, appFont: 'Verdana' }, theme)).toBe(true)
    expect(themeIsModified({ ...settings, chatFontScale: 150, sidebarFontScale: 150 }, theme)).toBe(false)
    expect(themeIsModified({ ...settings, claudeIcon: { kind: 'emoji', emoji: '🦊' } }, theme)).toBe(true)
    expect(themeIsModified({ ...settings, idleReapMin: 99, promptSuggestions: 'on' }, theme)).toBe(false)
  })
  it('a file that holds only some settings ignores the rest', () => {
    const settings = { ...DEFAULT_SETTINGS, density: 'compact' as const }
    expect(themeIsModified(settings, { name: 'x', values: { theme: 'paper' } })).toBe(false)
  })
  it('has no active theme when the named one has gone', () => {
    expect(activeCustomTheme({ ...DEFAULT_SETTINGS, activeTheme: 'gone' }, [])).toBeNull()
    expect(activeCustomTheme(DEFAULT_SETTINGS, [{ name: 'x', values: {} }])).toBeNull()
  })
  it('holds every theme setting', () => {
    expect(Object.keys(themeValuesOf(DEFAULT_SETTINGS)).sort()).toEqual([...THEME_KEYS].sort())
  })
})

describe('theme files', () => {
  it('round trips', () => {
    const values = cleanThemeValues({ theme: 'slate', appFont: 'Verdana', claudeIcon: { kind: 'image', dataUrl: PNG } })
    expect(parseThemeFile(themeFileText('Mine', values))).toEqual({ name: 'Mine', values })
  })
  it('refuses what is not a theme', () => {
    expect(parseThemeFile('not json')).toBeNull()
    expect(parseThemeFile('null')).toBeNull()
    expect(parseThemeFile('{"name":"x","values":{"theme":"slate"}}')).toBeNull()
    expect(parseThemeFile('{"delegattoTheme":1,"name":"x","values":{}}')).toBeNull()
    expect(parseThemeFile('{"delegattoTheme":1,"name":"x","values":{"extraFlags":["--x"]}}')).toBeNull()
  })
  it('keeps a font this PC may not have, so the file still carries it', () => {
    const values = cleanThemeValues({ appFont: 'Some Font Nobody Has' })
    expect(parseThemeFile(themeFileText('Mine', values))?.values.appFont).toBe('Some Font Nobody Has')
  })
  it('reads an older file that has text sizes, and ignores them', () => {
    expect(parseThemeFile('{"delegattoTheme":1,"name":"x","values":{"theme":"slate","chatFontScale":150}}')).toEqual({ name: 'x', values: { theme: 'slate' } })
  })
  it('reads a newer file for what it understands', () => {
    expect(parseThemeFile('{"delegattoTheme":9,"name":"x","values":{"theme":"slate","future":1}}')).toEqual({ name: 'x', values: { theme: 'slate' } })
  })
  it('copes with a bad name', () => {
    expect(parseThemeFile('{"delegattoTheme":1,"name":"   ","values":{"theme":"slate"}}')).toEqual({ name: null, values: { theme: 'slate' } })
  })
})
