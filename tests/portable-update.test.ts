import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadPortable, handoffArgs, isDeletablePrevious, pickPortableAsset, previousFromArgv, removePrevious, type PortableAsset } from '../src/main/portable-update'

const NAME = 'Delegatto-Portable-1.0.2.exe'
const bytes = Buffer.from('new version of the app')
const sha = createHash('sha256').update(bytes).digest('hex')
const asset = (over: Partial<PortableAsset> = {}): PortableAsset => ({ name: NAME, url: 'https://x/a.exe', size: bytes.length, sha256: sha, ...over })
const serve = (body: Buffer, status = 200) => async () => new Response(status === 200 ? new Uint8Array(body) : null, { status })

describe('pickPortableAsset', () => {
  it('finds the portable exe among the release files, with its checksum', () => {
    const picked = pickPortableAsset([
      { name: 'Delegatto-Setup-1.0.2.exe', browser_download_url: 'https://x/s', size: 1 },
      { name: 'latest.yml', browser_download_url: 'https://x/l', size: 1 },
      { name: NAME, browser_download_url: 'https://x/p', size: 9, digest: `sha256:${sha}` }
    ])
    expect(picked).toEqual({ name: NAME, url: 'https://x/p', size: 9, sha256: sha })
  })

  it('refuses a name that could leave the folder, and copes with no assets', () => {
    expect(pickPortableAsset([{ name: '..\\Delegatto-Portable-1.exe', browser_download_url: 'https://x', size: 1 }])).toBeNull()
    expect(pickPortableAsset(undefined)).toBeNull()
  })
})

describe('downloadPortable', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-portable-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('saves under the release name and reports progress', async () => {
    const seen: number[] = []
    const path = await downloadPortable(serve(bytes), asset(), dir, p => seen.push(p))
    expect(path).toBe(join(dir, NAME))
    expect(readFileSync(path)).toEqual(bytes)
    expect(seen[seen.length - 1]).toBe(100)
    expect(readdirSync(dir)).toEqual([NAME])
  })

  it('leaves nothing behind when the checksum is wrong', async () => {
    await expect(downloadPortable(serve(bytes), asset({ sha256: 'a'.repeat(64) }), dir, () => {})).rejects.toThrow(/checksum/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves nothing behind when the download stops short', async () => {
    await expect(downloadPortable(serve(bytes), asset({ size: bytes.length + 5, sha256: null }), dir, () => {})).rejects.toThrow(/incomplete/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('reports a server error', async () => {
    await expect(downloadPortable(serve(bytes, 503), asset(), dir, () => {})).rejects.toThrow(/503/)
  })

  it('reuses a finished copy, but replaces a damaged one', async () => {
    writeFileSync(join(dir, NAME), bytes)
    await downloadPortable(async () => { throw new Error('should not download') }, asset(), dir, () => {})
    writeFileSync(join(dir, NAME), 'x'.repeat(bytes.length))
    const path = await downloadPortable(serve(bytes), asset(), dir, () => {})
    expect(readFileSync(path)).toEqual(bytes)
  })
})

describe('the handover', () => {
  const OLD = 'D:\\Apps\\Delegatto-Portable-1.0.1.exe'
  const NEW = 'D:\\Apps\\Delegatto-Portable-1.0.2.exe'

  it('keeps this launch\'s arguments and replaces an earlier handover', () => {
    expect(handoffArgs(['--user-data-dir=x', '--updated-from=D:\\old.exe', '--updated-hidden'], OLD, false)).toEqual(['--user-data-dir=x', `--updated-from=${OLD}`])
    expect(handoffArgs([], OLD, true)).toEqual([`--updated-from=${OLD}`, '--updated-hidden'])
    expect(previousFromArgv(['app', `--updated-from=${OLD}`])).toBe(OLD)
    expect(previousFromArgv(['app'])).toBeNull()
  })

  it('only ever deletes another Delegatto exe in the same folder', () => {
    expect(isDeletablePrevious(OLD, NEW)).toBe(true)
    expect(isDeletablePrevious('d:\\apps\\Delegatto.exe', NEW)).toBe(true)
    expect(isDeletablePrevious(NEW, NEW)).toBe(false)
    expect(isDeletablePrevious('D:\\Other\\Delegatto-Portable-1.0.1.exe', NEW)).toBe(false)
    expect(isDeletablePrevious('D:\\Apps\\notes.txt', NEW)).toBe(false)
    expect(isDeletablePrevious('D:\\Apps\\Windows.exe', NEW)).toBe(false)
    expect(isDeletablePrevious('Delegatto-Portable-1.0.1.exe', NEW)).toBe(false)
  })

  it('deletes the old file, and counts one already gone as done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-portable-'))
    const file = join(dir, 'Delegatto-Portable-1.0.1.exe')
    writeFileSync(file, 'x')
    expect(await removePrevious(file, 100, 10)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(await removePrevious(file, 100, 10)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
