import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseImageDataUrl, resolveWithinDir, saveImage } from '../src/main/save-image'

const PNG = 'data:image/png;base64,aGVsbG8=' // "hello"

describe('parseImageDataUrl', () => {
  it('decodes a base64 image data URL to bytes + media type', () => {
    const p = parseImageDataUrl(PNG)
    expect(p?.mediaType).toBe('image/png')
    expect(p?.bytes.toString('utf8')).toBe('hello')
  })
  it('rejects non-image or non-data URLs', () => {
    expect(parseImageDataUrl('data:text/plain;base64,aGk=')).toBeNull()
    expect(parseImageDataUrl('https://example.com/x.png')).toBeNull()
    expect(parseImageDataUrl('not a url')).toBeNull()
  })
})

describe('resolveWithinDir', () => {
  const base = process.platform === 'win32' ? 'C:\\proj' : '/proj'
  it('resolves a normal relative path inside the base', () => {
    expect(resolveWithinDir(base, 'assets/x.png')).not.toBeNull()
  })
  it('blocks .. escapes and empty paths', () => {
    expect(resolveWithinDir(base, '../evil.png')).toBeNull()
    expect(resolveWithinDir(base, '..')).toBeNull()
    expect(resolveWithinDir(base, '   ')).toBeNull()
  })
  it('blocks an absolute path that lands outside the base', () => {
    const outside = process.platform === 'win32' ? 'C:\\other\\x.png' : '/other/x.png'
    expect(resolveWithinDir(base, outside)).toBeNull()
  })
})

describe('saveImage', () => {
  it('writes the decoded image inside the working dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-img-'))
    try {
      const res = saveImage({ cwd: dir, relPath: 'sub/pic.png', dataUrl: PNG })
      expect(res.ok).toBe(true)
      if (res.ok) { expect(existsSync(res.path)).toBe(true); expect(readFileSync(res.path, 'utf8')).toBe('hello') }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses to escape the working dir, overwrite, or run with no cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-img-'))
    try {
      expect(saveImage({ cwd: dir, relPath: '../escape.png', dataUrl: PNG }).ok).toBe(false)
      expect(saveImage({ cwd: null, relPath: 'x.png', dataUrl: PNG }).ok).toBe(false)
      expect(saveImage({ cwd: dir, relPath: 'a.png', dataUrl: 'not-an-image' }).ok).toBe(false)
      expect(saveImage({ cwd: dir, relPath: 'dup.png', dataUrl: PNG }).ok).toBe(true)
      expect(saveImage({ cwd: dir, relPath: 'dup.png', dataUrl: PNG }).ok).toBe(false) // no overwrite
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
