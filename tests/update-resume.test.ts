import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveResume, takeResume, usableBounds, type UpdateResume } from '../src/main/update-resume'

const resume: UpdateResume = {
  at: 1000, bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true, minimized: false, hidden: false, focused: false,
  chat: { sessionPk: 7, projectDir: 'D--work' }
}

describe('what an update puts back', () => {
  let dir: string
  let file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-resume-')); file = join(dir, 'resume.json') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reads back what was saved, once', () => {
    saveResume(file, resume)
    expect(takeResume(file, 2000)).toEqual(resume)
    expect(existsSync(file)).toBe(false)
    expect(takeResume(file, 2000)).toBeNull()
  })

  it('ignores an old record, and still removes it', () => {
    saveResume(file, resume)
    expect(takeResume(file, 1000 + 11 * 60 * 1000)).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('copes with no file, a broken file, and missing pieces', () => {
    expect(takeResume(file, 2000)).toBeNull()
    writeFileSync(file, 'not json')
    expect(takeResume(file, 2000)).toBeNull()
    writeFileSync(file, JSON.stringify({ at: 1000, bounds: { x: 'a' } }))
    expect(takeResume(file, 2000)).toBeNull()
    writeFileSync(file, JSON.stringify({ at: 1000, bounds: resume.bounds, chat: { sessionPk: 'x' } }))
    expect(takeResume(file, 2000)).toMatchObject({ chat: null, maximized: false, hidden: false, focused: true })
  })
})

describe('where the window goes', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1040 }
  const second = { x: 1920, y: 0, width: 2560, height: 1400 }

  it('stays where it was', () => {
    expect(usableBounds({ x: 100, y: 50, width: 1200, height: 800 }, [screen])).toEqual({ x: 100, y: 50, width: 1200, height: 800 })
  })

  it('stays on a second screen while that screen is there', () => {
    expect(usableBounds({ x: 2000, y: 100, width: 1500, height: 900 }, [screen, second])).toEqual({ x: 2000, y: 100, width: 1500, height: 900 })
  })

  it('fits the screen holding most of it, whichever is listed first', () => {
    const small = { x: 0, y: 0, width: 1000, height: 600 }
    const tall = { x: 1000, y: 0, width: 1000, height: 1400 }
    expect(usableBounds({ x: 850, y: 0, width: 900, height: 1200 }, [small, tall])).toEqual({ x: 850, y: 0, width: 900, height: 1200 })
  })

  it('gives up if that screen has gone', () => {
    expect(usableBounds({ x: 2000, y: 100, width: 1500, height: 900 }, [screen])).toBeNull()
  })

  it('keeps a window hanging off the edge, as long as enough is reachable', () => {
    expect(usableBounds({ x: 1700, y: 100, width: 800, height: 600 }, [screen])).not.toBeNull()
    expect(usableBounds({ x: 1880, y: 100, width: 800, height: 600 }, [screen])).toBeNull()
  })

  it('never opens bigger than the screen, or too small to use', () => {
    expect(usableBounds({ x: 0, y: 0, width: 3000, height: 2000 }, [screen])).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
    expect(usableBounds({ x: 0, y: 0, width: 50, height: 50 }, [screen])).toEqual({ x: 0, y: 0, width: 400, height: 300 })
  })
})
