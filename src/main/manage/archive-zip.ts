import { createWriteStream, existsSync, promises as fsp, type WriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import * as yazl from 'yazl'
import * as yauzl from 'yauzl'

/** Zip and JSON plumbing for archive.ts, shaped after what .NET's ZipArchive and
 *  System.Text.Json do, so zips made by ClaudeMemoryTool and by Delegatto can be
 *  read by either. Electron-free. */

// ------------------------------------------------------------------ writing

/** Streams entries into a zip file. Entries are added one at a time (each
 *  `addStream` resolves once its data has been consumed), so only one source
 *  file is open at once and nothing is buffered whole. */
export class ZipWriter {
  private readonly zip = new yazl.ZipFile()
  private readonly out: WriteStream
  private error: Error | null = null
  private readonly failed: Promise<never>

  constructor(path: string) {
    this.out = createWriteStream(path, { flags: 'wx' })
    this.failed = new Promise<never>((_, reject) => {
      const fail = (e: Error): void => { this.error ??= e; reject(this.error) }
      this.out.on('error', fail)
      this.zip.on('error', fail)
      this.zip.outputStream.on('error', fail)
    })
    this.failed.catch(() => { /* surfaced by the awaits below */ })
    this.zip.outputStream.pipe(this.out)
  }

  private check(): void { if (this.error) throw this.error }

  /** A small in-memory entry (manifest, .claude.json entry, history lines). Its
   *  time is "now", like a .NET CreateEntry without LastWriteTime. */
  addText(name: string, text: string): void {
    this.check()
    this.zip.addBuffer(Buffer.from(text, 'utf8'), name, { compress: true, mtime: new Date() })
  }

  /** Adds `input` as `name` (deflated, stamped `mtime`) and waits until it has been
   *  read to the end. A read error mid-file is fatal for the whole zip. */
  async addStream(name: string, input: Readable, mtime: Date): Promise<void> {
    this.check()
    this.zip.addReadStream(input, name, { compress: true, mtime })
    await Promise.race([finished(input), this.failed])
    this.check()
  }

  async finish(): Promise<void> {
    this.check()
    this.zip.end()
    await Promise.race([finished(this.out), this.failed])
    this.check()
  }

  /** Stops writing and waits for the file handle to close (so it can be deleted). */
  async abort(): Promise<void> {
    if (this.out.closed) return
    const closed = new Promise<void>(r => this.out.once('close', () => r()))
    this.zip.outputStream.unpipe(this.out)
    this.out.destroy()
    await closed
  }
}

/** Builds the zip next to the target and moves it into place, so a failed or
 *  cancelled export leaves no half file (port of ArchiveService.WriteZip). */
export async function writeZipAtomic(zipPath: string, build: (zip: ZipWriter) => Promise<void>): Promise<void> {
  const full = resolve(zipPath)
  const temp = `${full}.${randomBytes(16).toString('hex')}.tmp`
  const zip = new ZipWriter(temp)
  try {
    try {
      await build(zip)
      await zip.finish()
    } catch (e) {
      await zip.abort()
      throw e
    }
    await fsp.rename(temp, full)
  } finally {
    try { if (existsSync(temp)) await fsp.unlink(temp) } catch { /* best effort */ }
  }
}

// ------------------------------------------------------------------ reading

export type ZipEntry = { name: string; raw: yauzl.Entry }

/** A zip opened for random access. Entry names are decoded as UTF-8 (what .NET
 *  does for every entry, flagged or not) and are NOT validated or normalized
 *  here: the caller decides what an odd name (`..`, backslashes) means, exactly
 *  like ArchiveService does with ZipArchiveEntry.FullName. */
export class ZipReader {
  private constructor(private readonly zip: yauzl.ZipFile, readonly entries: ZipEntry[]) {}

  /** @throws InvalidZipError when the file isn't a readable zip. */
  static async open(path: string): Promise<ZipReader> {
    let zip: yauzl.ZipFile
    try {
      zip = await yauzl.openPromise(path, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true })
    } catch (e) {
      if (isFsError(e)) throw e
      throw new InvalidZipError(`Not a readable zip file: ${(e as Error).message}`)
    }
    try {
      const entries: ZipEntry[] = []
      for await (const raw of zip.eachEntry()) {
        const nameBuf = raw.fileName as unknown as Buffer // decodeStrings: false
        entries.push({ name: nameBuf.toString('utf8'), raw })
      }
      return new ZipReader(zip, entries)
    } catch (e) {
      zip.close()
      if (isFsError(e)) throw e
      throw new InvalidZipError(`Not a readable zip file: ${(e as Error).message}`)
    }
  }

  /** The first entry with exactly this name (ordinal), like ZipArchive.GetEntry. */
  get(name: string): ZipEntry | undefined {
    return this.entries.find(e => e.name === name)
  }

  openStream(e: ZipEntry): Promise<Readable> {
    return this.zip.openReadStreamPromise(e.raw)
  }

  async readText(e: ZipEntry): Promise<string> {
    const chunks: Buffer[] = []
    for await (const c of await this.openStream(e)) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '')
  }

  /** The entry's DOS timestamp as a local time (what .NET's LastWriteTime gives). */
  static lastWriteTime(e: ZipEntry): Date {
    return e.raw.getLastModDate({ forceDosFormat: true, timezone: 'local' })
  }

  close(): void { this.zip.close() }
}

export class InvalidZipError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidZipError' }
}

function isFsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code)
}

/** Writes an entry to a new file (never replacing one), creating its folder; a
 *  failed write leaves no half file (port of ArchiveService.Extract). */
export async function extractEntry(zip: ZipReader, e: ZipEntry, target: string): Promise<void> {
  await fsp.mkdir(resolve(target, '..'), { recursive: true })
  const out = createWriteStream(target, { flags: 'wx' })
  try {
    await pipeline(await zip.openStream(e), out)
  } catch (err) {
    if (!out.closed) { out.destroy(); await new Promise<void>(r => out.once('close', () => r())) }
    // Only remove what we created: 'wx' failing with EEXIST means it was someone else's file.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      try { await fsp.unlink(target) } catch { /* best effort */ }
    }
    throw err
  }
}

/** Sets only the last-write time (keeps the access time), like File.SetLastWriteTime. */
export async function setMtime(path: string, mtime: Date): Promise<void> {
  const st = await fsp.stat(path)
  await fsp.utimes(path, st.atime, mtime)
}

// ------------------------------------------------------------------ System.Text.Json look-alike

/** JSON text as System.Text.Json writes it with WriteIndented and the default
 *  encoder: 2-space indent, CRLF line breaks (Environment.NewLine on Windows),
 *  and inside strings every non-ASCII char, `"`, `<`, `>`, `&`, `'`, `+` and
 *  backtick escaped as an uppercase \uXXXX. */
export function dotnetJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (!inString) {
      if (c === '"') inString = true
      out += c === '\n' ? '\r\n' : c
      continue
    }
    if (c === '\\') {
      const n = text[i + 1]!
      if (n === '"') out += '\\u0022'
      else if (n === 'u') out += '\\u' + text.slice(i + 2, i + 6).toUpperCase()
      else out += c + n
      i += n === 'u' ? 5 : 1
    } else if (c === '"') {
      inString = false
      out += c
    } else if (c.charCodeAt(0) > 0x7e || '<>&\'+`'.includes(c)) {
      out += '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
    } else {
      out += c
    }
  }
  return out
}

/** A UTC DateTime as System.Text.Json writes it: ISO 8601 with the fraction
 *  trimmed of trailing zeros (none at all when whole seconds) and a `Z`. */
export function dotnetUtc(d: Date): string {
  const iso = d.toISOString() // yyyy-mm-ddThh:mm:ss.fffZ
  const frac = iso.slice(20, 23).replace(/0+$/, '')
  return iso.slice(0, 19) + (frac ? '.' + frac : '') + 'Z'
}

/** Parses a System.Text.Json DateTime. No offset means "unspecified", which .NET's
 *  ToLocalTime / SetLastWriteTimeUtc treat as UTC, so it is read as UTC too.
 *  Returns null when the text isn't a date. */
export function parseDotnetDate(s: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(s)
  if (!m) return null
  const time = m[2] ? `T${m[2]}:${m[3] ?? '00'}.${(m[4] ?? '0').padEnd(3, '0').slice(0, 3)}` : 'T00:00:00.000'
  const ms = Date.parse(m[1] + time + (m[5] ?? 'Z'))
  return Number.isNaN(ms) ? null : new Date(ms)
}
