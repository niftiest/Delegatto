import { describe, it, expect } from 'vitest'
import { clampFontScale, fontStack, stepFontScale, validFontName, FONT_SCALE_MAX, FONT_SCALE_MIN } from '../src/shared/font-settings'

describe('text size', () => {
  it('moves in steps and stops at each end', () => {
    expect(stepFontScale(100, 'up')).toBe(110)
    expect(stepFontScale(100, 'down')).toBe(90)
    expect(stepFontScale(FONT_SCALE_MAX, 'up')).toBe(FONT_SCALE_MAX)
    expect(stepFontScale(FONT_SCALE_MIN, 'down')).toBe(FONT_SCALE_MIN)
  })

  it('keeps a stored value in range and on a step', () => {
    expect(clampFontScale(5000)).toBe(FONT_SCALE_MAX)
    expect(clampFontScale(1)).toBe(FONT_SCALE_MIN)
    expect(clampFontScale(113)).toBe(110)
  })
})

describe('font name', () => {
  it('takes real names, including blank for the default', () => {
    expect(validFontName('Segoe UI Variable Text')).toBe('Segoe UI Variable Text')
    expect(validFontName('')).toBe('')
    expect(validFontName("Comic Sans MS")).toBe('Comic Sans MS')
  })

  it('refuses what could break out of the CSS, or isn\'t a name', () => {
    expect(validFontName('x"; } body { display:none')).toBeNull()
    expect(validFontName('a'.repeat(101))).toBeNull()
    expect(validFontName(5)).toBeNull()
  })

  it('names only the chosen font, leaving the fallback to the stylesheet', () => {
    expect(fontStack('Consolas')).toBe('"Consolas"')
  })
})
