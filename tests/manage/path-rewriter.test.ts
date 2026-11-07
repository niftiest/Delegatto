import { describe, it, expect } from 'vitest'
import { PathRewriter } from '../../src/main/manage/path-rewriter'

const r = String.raw

describe('PathRewriter', () => {
  const rw = (): PathRewriter => new PathRewriter(r`D:\GIT\Old`, r`D:\GIT\New`)

  it.each([
    [r`{"cwd":"D:\\GIT\\Old"}`, r`{"cwd":"D:\\GIT\\New"}`],
    [r`{"cwd":"D:\\GIT\\Old\\server"}`, r`{"cwd":"D:\\GIT\\New\\server"}`],
    ['cd /d/GIT/Old && ls', 'cd /d/GIT/New && ls'],
    ['see D:/GIT/Old/x', 'see D:/GIT/New/x'],
    [r`"D:\\\\GIT\\\\Old"`, r`"D:\\\\GIT\\\\New"`],
    [r`{"cwd":"D:\\GIT\\Old.com"}`, r`{"cwd":"D:\\GIT\\Old.com"}`]
  ])('rewrites all forms only on a boundary: %s', (input, expected) =>
    expect(rw().rewrite(input)).toBe(expected))

  it.each([
    [r`raw D:\GIT\Old\a`, r`raw D:\GIT\New\a`],
    [r`case d:\git\old\a`, r`case D:\GIT\New\a`],
    ['msys upper /D/GIT/Old/a', 'msys upper /d/GIT/New/a'],
    [r`D:\GIT\OldX D:\GIT\Old_1 D:\GIT\Old-2 /d/GIT/Old.git`, r`D:\GIT\OldX D:\GIT\Old_1 D:\GIT\Old-2 /d/GIT/Old.git`],
    [r`D:\GIT\Old, D:/GIT/Old; "D:\\GIT\\Old"`, r`D:\GIT\New, D:/GIT/New; "D:\\GIT\\New"`]
  ])('rewrites raw, case-insensitive, skips siblings: %s', (input, expected) =>
    expect(rw().rewrite(input)).toBe(expected))

  it('handles spaces and parens', () => {
    const p = new PathRewriter(r`C:\Program Files\X (copy)`, r`C:\Program Files\Y`)
    expect(p.rewrite('cd "/c/Program Files/X (copy)/a"')).toBe('cd "/c/Program Files/Y/a"')
    expect(p.rewrite(r`{"cwd":"C:\\Program Files\\X (copy)\\a"}`)).toBe(r`{"cwd":"C:\\Program Files\\Y\\a"}`)
    expect(p.rewrite(r`C:\Program Files\X (copy)2`)).toBe(r`C:\Program Files\X (copy)2`)
  })

  it('replacement text is literal and not rewritten again', () => {
    const p = new PathRewriter(r`D:\a`, r`D:\a$1\b`)
    expect(p.rewrite(r`D:\a\x`)).toBe(r`D:\a$1\b\x`)
  })

  it('touches reports matches', () => {
    const p = rw()
    expect(p.touches(r`{"cwd":"D:\\GIT\\Old"}`)).toBe(true)
    expect(p.touches('/d/git/old/x')).toBe(true)
    expect(p.touches(r`{"cwd":"D:\\GIT\\Old.com"}`)).toBe(false)
    expect(p.touches('nothing here')).toBe(false)
  })

  it('unchanged text comes back unchanged', () => {
    const s = 'no paths'
    expect(rw().rewrite(s)).toBe(s)
  })

  it.each([r`D:\GIT\Oldé\x`, r`D:\GIT\Old1`, r`"D:\\GIT\\Oldñ"`])('non-ASCII letters continue the name: %s', input =>
    expect(rw().rewrite(input)).toBe(input))

  it('known sibling suffixes are excluded', () => {
    const p = new PathRewriter(r`D:\GIT\Old`, r`D:\GIT\New`, [' Stuff', ' (copy)'])
    expect(p.rewrite(r`{"cwd":"D:\\GIT\\Old Stuff\\x"}`)).toBe(r`{"cwd":"D:\\GIT\\Old Stuff\\x"}`)
    expect(p.rewrite(r`{"cwd":"D:\\GIT\\Old Stuff"}`)).toBe(r`{"cwd":"D:\\GIT\\Old Stuff"}`)
    expect(p.rewrite('cd "/d/GIT/Old (copy)/a"')).toBe('cd "/d/GIT/Old (copy)/a"')
    expect(p.rewrite(r`D:\GIT\old stuff`)).toBe(r`D:\GIT\old stuff`) // case-insensitive
    expect(p.touches('D:/GIT/Old Stuff/x')).toBe(false)
    // the real folder is still rewritten, also when followed by a space that does not start a sibling name
    expect(p.rewrite(r`cd D:\GIT\Old && ls D:\GIT\Old Stuffing`)).toBe(r`cd D:\GIT\New && ls D:\GIT\New Stuffing`)
    expect(p.rewrite(r`{"cwd":"D:\\GIT\\Old"}`)).toBe(r`{"cwd":"D:\\GIT\\New"}`)
    // without the suffix list a space is a boundary
    expect(rw().rewrite(r`D:\GIT\Old Stuff\x`)).toBe(r`D:\GIT\New Stuff\x`)
  })

  it('MSYS form needs a non-alphanumeric before it', () => {
    const p = rw()
    expect(p.rewrite('x/d/GIT/Old/a and 1/d/GIT/Old')).toBe('x/d/GIT/Old/a and 1/d/GIT/Old')
    expect(p.rewrite('"/d/GIT/Old/a" (/d/GIT/Old)')).toBe('"/d/GIT/New/a" (/d/GIT/New)')
  })

  it('touches is stateless across calls (no lastIndex carry-over)', () => {
    const p = rw()
    for (let i = 0; i < 3; i++) expect(p.touches('D:/GIT/Old')).toBe(true)
  })

  it('a UNC new path turns MSYS hits into forward-slash paths', () => {
    const p = new PathRewriter(r`D:\GIT\Old`, r`\\srv\share\New`)
    expect(p.rewrite('cd /d/GIT/Old/x')).toBe('cd //srv/share/New/x')
  })

  it('refuses empty paths', () => {
    expect(() => new PathRewriter('', r`D:\x`)).toThrow()
    expect(() => new PathRewriter(r`D:\x`, '')).toThrow()
  })
})
