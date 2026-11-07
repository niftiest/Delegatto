import { createReadStream, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { ProjectInfo } from './types'
import { isDir } from './fs-util'

/** Port of ClaudeMemoryTool's SearchService: path match (instant) plus memory
 *  and chat content match (case-insensitive substring, cancellable), reporting
 *  where each project matched. */

/** Bit flags, combinable: `MatchSource.Memory | MatchSource.Chat`. */
export const MatchSource = { None: 0, Path: 1, Memory: 2, Chat: 4 } as const
export type MatchSource = number

export type MatchPlace = 'path' | 'memory' | 'chat'

/** The places a MatchSource names, in display order. */
export function matchPlaces(src: MatchSource): MatchPlace[] {
  const r: MatchPlace[] = []
  if (src & MatchSource.Path) r.push('path')
  if (src & MatchSource.Memory) r.push('memory')
  if (src & MatchSource.Chat) r.push('chat')
  return r
}

const PARALLELISM = 4

/** Instant: the working dir or encoded folder name contains `q` (case-insensitive). */
export function matchPath(p: ProjectInfo, q: string): MatchSource {
  if (!q) return MatchSource.None
  return contains(p.workingDir, q) || contains(p.encodedName, q) ? MatchSource.Path : MatchSource.None
}

/** Searches each project's memory folder (all files, recursive) and its chat
 *  logs (top-level *.jsonl) for `q`. Projects without a projects folder are
 *  skipped. `onMatch` is called as each matching project is found. Unreadable
 *  files are skipped. Rejects with the signal's reason (an AbortError) once
 *  `signal` is aborted; projects not yet searched are not searched. */
export async function searchContent(
  projects: readonly ProjectInfo[], q: string,
  onMatch?: (workingDir: string, src: MatchSource) => void, signal?: AbortSignal
): Promise<Map<string, MatchSource>> {
  const result = new Map<string, MatchSource>()
  signal?.throwIfAborted()
  if (!q) return result
  const ql = q.toLowerCase()
  await forEachParallel(projects, PARALLELISM, signal, async p => {
    if (p.projectDir === null || !await isDir(p.projectDir)) return
    let src: MatchSource = MatchSource.None
    if (await memoryHit(join(p.projectDir, 'memory'), ql, signal)) src |= MatchSource.Memory
    if (await chatHit(p.projectDir, ql, signal)) src |= MatchSource.Chat
    if (src !== MatchSource.None) {
      result.set(p.workingDir, src)
      onMatch?.(p.workingDir, src)
    }
  })
  return result
}

function contains(s: string, q: string): boolean {
  return s.toLowerCase().includes(q.toLowerCase())
}

/** Runs `fn` over `items` with at most `n` in flight; stops taking new items
 *  once `signal` aborts and rejects with its reason. The first error wins. */
export async function forEachParallel<T>(items: readonly T[], n: number, signal: AbortSignal | undefined,
  fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      signal?.throwIfAborted()
      const item = items[next++]!
      await fn(item)
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(n, items.length); i++) workers.push(worker())
  const settled = await Promise.allSettled(workers)
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (failed) throw failed.reason
  signal?.throwIfAborted()
}

/** True if some line of `file` contains `ql` (already lower-cased). Unreadable files count as no hit. */
async function fileHit(file: string, ql: string, signal?: AbortSignal): Promise<boolean> {
  let hit = false
  try {
    await forEachLine(file, line => {
      if (line.toLowerCase().includes(ql)) { hit = true; return false }
      return undefined
    }, signal)
  } catch (e) {
    if (signal?.aborted) throw e
    return false
  }
  return hit
}

async function memoryHit(dir: string, ql: string, signal?: AbortSignal): Promise<boolean> {
  if (!await isDir(dir)) return false
  for (const f of await filesUnder(dir)) {
    signal?.throwIfAborted()
    if (await fileHit(f, ql, signal)) return true
  }
  return false
}

async function chatHit(dir: string, ql: string, signal?: AbortSignal): Promise<boolean> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.jsonl')) continue
    signal?.throwIfAborted()
    if (await fileHit(join(dir, e.name), ql, signal)) return true
  }
  return false
}

/** Every file under `dir`, recursive; inaccessible folders are skipped; links are not followed. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    let entries
    try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  await walk(dir)
  return out
}

/** Streams a UTF-8 file line by line (split on \n, a trailing \r dropped, a
 *  leading BOM dropped). `cb` returning false stops early. Checks `signal`
 *  between chunks. Read errors propagate. */
export async function forEachLine(file: string, cb: (line: string) => boolean | void, signal?: AbortSignal): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 16 })
  let pending: string[] = []
  let first = true
  const emit = (line: string): boolean | void => cb(line.endsWith('\r') ? line.slice(0, -1) : line)
  try {
    for await (const raw of stream as AsyncIterable<string>) {
      signal?.throwIfAborted()
      let chunk = raw
      if (first) { if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); first = false }
      let start = 0
      for (;;) {
        const nl = chunk.indexOf('\n', start)
        if (nl < 0) break
        const piece = chunk.slice(start, nl)
        const line = pending.length > 0 ? pending.join('') + piece : piece
        pending = []
        if (emit(line) === false) return
        start = nl + 1
      }
      if (start < chunk.length) pending.push(chunk.slice(start))
    }
    if (pending.length > 0) emit(pending.join(''))
  } finally {
    // Wait for the handle to really close: on Windows an open handle makes a
    // later atomic replace of the same file fail with EPERM.
    if (!stream.closed) {
      await new Promise<void>(res => { stream.once('close', () => res()); stream.destroy() })
    }
  }
}
