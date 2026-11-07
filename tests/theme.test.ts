import { describe, it, expect } from 'vitest'
import { chatPaneTheme, localThemeStyle, rootTheme } from '../src/renderer/theme'
import { DEFAULT_SETTINGS, coerce, setLocalThemeCheck } from '../src/main/catalog/settings'
import { validThemeId } from '../src/shared/themes'
import { cleanThemeColors, contrast, parseColor, themeColorVars } from '../src/shared/theme-colors'
import { listLocalThemes, localThemeName } from '../src/main/local-themes'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('themes', () => {
  it('every theme but Terminal colours the whole window, whatever the scope', () => {
    for (const theme of ['paper', 'slate', 'ember', 'plum', 'forest', 'local:Mine'] as const) {
      for (const scope of ['chat', 'app'] as const) {
        expect(rootTheme({ theme, scope })).toBe(theme)
        expect(chatPaneTheme({ theme, scope })).toBeUndefined()
      }
    }
  })

  it('Terminal still honours its scope, with the default around it', () => {
    expect(rootTheme({ theme: 'terminal', scope: 'chat' })).toBe('paper')
    expect(chatPaneTheme({ theme: 'terminal', scope: 'chat' })).toBe('terminal')
    expect(rootTheme({ theme: 'terminal', scope: 'app' })).toBe('terminal')
  })

  it('Paper is the default', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('paper')
  })

  it('takes a built-in, or a theme file only while it is there', () => {
    const has = (name: string) => name === 'Mine'
    expect(validThemeId('ember', has)).toBe('ember')
    expect(validThemeId('local:Mine', has)).toBe('local:Mine')
    expect(validThemeId('local:Gone', has)).toBeNull()
    expect(validThemeId('neon', has)).toBeNull()
  })

  it('settings keep a local theme only while its file is there', () => {
    setLocalThemeCheck(name => name === 'Mine')
    try {
      expect(coerce('theme', 'local:Mine')).toBe('local:Mine')
      expect(coerce('theme', 'local:Other')).toBeUndefined()
    } finally { setLocalThemeCheck(() => false) }
    expect(coerce('theme', 'local:Mine')).toBeUndefined()
  })
})

describe('theme files on this PC', () => {
  it('lists .css files by name and leaves the rest out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-themes-'))
    try {
      writeFileSync(join(dir, 'Mine.css'), '--bg:#000;')
      writeFileSync(join(dir, 'notes.txt'), 'x')
      writeFileSync(join(dir, 'Big.css'), 'x'.repeat(300 * 1024))
      mkdirSync(join(dir, 'folder.css'))
      expect(listLocalThemes(dir)).toEqual([{ id: 'local:Mine', name: 'Mine', css: '--bg:#000;' }])
      expect(listLocalThemes(join(dir, 'missing'))).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('takes a name only from a usable file name', () => {
    expect(localThemeName('My Theme.CSS')).toBe('My Theme')
    expect(localThemeName('.css')).toBeNull()
    expect(localThemeName('a"b.css')).toBeNull()
    expect(localThemeName('theme.json')).toBeNull()
  })

  it('nests a file inside its own theme, so it styles nothing else', () => {
    expect(localThemeStyle({ id: 'local:Mine', name: 'Mine', css: '--bg:#000;' }))
      .toBe('[data-theme="local:Mine"] {\n--bg:#000;\n}')
  })
})

describe('your own colours', () => {
  const paper = { rail: '#e9e7e2', s1: '#f3f1ec', bg: '#fbfaf7', accent: '#2350d0', tx: '#1b1a17', txt: '#2d2b27', mu: '#6b675f', dim: '#8a857b' }

  it('changes nothing until a colour is picked', () => {
    expect(themeColorVars(paper, {})).toEqual({ vars: {}, css: '', readable: true })
  })

  it('keeps the theme text while it still reads well', () => {
    const r = themeColorVars(paper, { bg: '#ffffff' })
    expect(r.vars['--bg']).toBe('#ffffff')
    expect(r.vars['--tx']).toBeUndefined()
    expect(r.readable).toBe(true)
  })

  it('switches to light text when everything goes dark', () => {
    const r = themeColorVars(paper, { rail: '#000000', s1: '#101010', bg: '#050505' })
    expect(r.vars['--tx']).toBe('#f4f4f5')
    expect(r.readable).toBe(true)
  })

  it('gives each colour its own text, so a dark strip beside light sidebars reads well', () => {
    const r = themeColorVars(paper, { rail: '#000000', s1: '#ffffff', bg: '#ffffff' }, { rail: '.iconrail, .field-input', s1: '.nav, .blade' })
    expect(r.readable).toBe(true)
    expect(r.vars['--tx']).toBeUndefined()
    const [rail, s1] = r.css.split('\n')
    expect(rail).toMatch(/^:is\(\.iconrail,/)
    expect(rail).toContain('--tx:#f4f4f5;')
    expect(s1).toMatch(/^:is\(\.nav,/)
    expect(s1).toContain('--tx:#1b1a17;')
  })

  it('warns about a colour no text reads well on', () => {
    expect(themeColorVars(paper, { bg: '#777777' }).readable).toBe(false)
    expect(themeColorVars(paper, { bg: '#0b1f3c' }).readable).toBe(true)
  })

  it('puts dark text on a light accent', () => {
    expect(themeColorVars(paper, { accent: '#ffe066' }).vars['--on-accent']).toBe('#111')
    expect(themeColorVars(paper, { accent: '#1b40a8' }).vars['--on-accent']).toBe('#fff')
  })

  it('keeps only known colours from settings or a file', () => {
    expect(cleanThemeColors({ bg: '#ABCDEF', accent: 'red', nope: '#000000' })).toEqual({ bg: '#abcdef' })
    expect(cleanThemeColors('x')).toBeNull()
    expect(coerce('themeColors', { s1: '#123456' })).toEqual({ s1: '#123456' })
  })

  it('reads the ways a theme may write a colour', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor(' #2350D0 ')).toEqual([35, 80, 208])
    expect(parseColor('rgba(10, 20, 30, .5)')).toEqual([10, 20, 30])
    expect(parseColor('var(--x)')).toBeNull()
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21)
  })
})
