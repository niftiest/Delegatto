import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ClaudePaths } from './paths'

/** Port of ClaudeMemoryTool's SafeFileWriter: backups, atomic writes, and
 *  byte-preserving line rewrites for `.claude.json` / `history.jsonl` /
 *  transcripts. Node opens files with full share flags on Windows, so reading
 *  a file a running `claude` holds open is fine. */

function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** A fresh `yyyyMMdd-HHmmss[-n]` path under `parent` that doesn't exist yet. */
export function uniqueStampedPath(parent: string, suffix = ''): string {
  const s = stamp()
  let p = join(parent, s + suffix)
  for (let n = 2; existsSync(p); n++) p = join(parent, `${s}-${n}${suffix}`)
  return p
}

/** Copies `.claude.json` and `history.jsonl` (whichever exist) into a new
 *  backups/memory-tool/<stamp> folder and returns it. Never overwrites an older backup. */
export function backupClaudeState(p: ClaudePaths): string {
  mkdirSync(p.backupsDir, { recursive: true })
  const dir = uniqueStampedPath(p.backupsDir)
  mkdirSync(dir)
  for (const src of [p.claudeJson, p.historyFile]) {
    if (!existsSync(src)) continue
    const dest = join(dir, basename(src))
    copyFileSync(src, dest)
    const st = statSync(src)
    utimesSync(dest, st.atime, st.mtime)
  }
  return dir
}

/** Writes via a temp file in the same directory, fsync, then rename over the target. */
export function atomicWriteBytes(path: string, bytes: Uint8Array): void {
  const full = resolve(path)
  const temp = join(dirname(full), `.${basename(full)}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    const fd = openSync(temp, 'wx')
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, full)
  } finally {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* best effort */ }
  }
}

export function atomicWriteText(path: string, text: string): void {
  atomicWriteBytes(path, Buffer.from(text, 'utf8'))
}

const NL = 0x0a

/** Rewrites a '\n'-separated file line by line. `map` returns null to drop a
 *  line; a line returned unchanged is written back byte-for-byte. Output has no
 *  BOM. Writes only when something changed, and returns whether it did.
 *
 *  Compare-and-swap: if the file changed between our read and our write (e.g.
 *  a Claude process appended to history.jsonl), the pass is redone on the new
 *  content (up to 5 tries) instead of clobbering the append. */
export function rewriteLines(path: string, map: (line: string) => string | null, preserveMtime: boolean): boolean {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = statSync(path)
    const data = readFileSync(path)
    const out = mapLines(data, map)
    if (out === null) return false
    const now = statSync(path)
    if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) continue
    atomicWriteBytes(path, out)
    if (preserveMtime) utimesSync(path, before.atime, before.mtime)
    return true
  }
  throw new Error(`${basename(path)} kept changing while being rewritten; left unchanged. Close Claude Code and try again.`)
}

/** The rewritten bytes, or null when nothing changed. */
export function mapLines(data: Buffer, map: (line: string) => string | null): Buffer | null {
  let start = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0
  let changed = start !== 0
  const parts: Buffer[] = []
  while (start < data.length) {
    const nl = data.indexOf(NL, start)
    const hasNl = nl >= 0
    const end = hasNl ? nl : data.length
    const original = data.subarray(start, end)
    const line = original.toString('utf8')
    const mapped = map(line)
    if (mapped === null) {
      changed = true
    } else {
      if (mapped === line) parts.push(original)
      else { parts.push(Buffer.from(mapped, 'utf8')); changed = true }
      if (hasNl) parts.push(Buffer.from([NL]))
    }
    start = end + 1
  }
  return changed ? Buffer.concat(parts) : null
}

/** Appends '\n'-terminated lines through an atomic rewrite; creates the file if missing. */
export function appendLines(path: string, lines: string[]): void {
  if (lines.length === 0) return
  const data = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  const parts: Buffer[] = [data]
  if (data.length > 0 && data[data.length - 1] !== NL) parts.push(Buffer.from([NL]))
  for (const l of lines) parts.push(Buffer.from(l + '\n', 'utf8'))
  atomicWriteBytes(path, Buffer.concat(parts))
}
