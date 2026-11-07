import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionWatcher } from '../src/main/engine/watcher'
import { streamRange, type StreamedRow } from '../src/main/jsonl/stream'

const line = (uuid: string) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: null, message: { role: 'user', content: uuid } })

/** Polls `check` until it returns true or `timeoutMs` elapses, instead of a
 *  fixed sleep -- chokidar's fs-watch latency varies by platform. Fails
 *  loudly (rather than hanging) once the timeout is exceeded. */
async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

// chokidar's native watch handle for a path isn't armed the instant watch()
// returns -- there's a real (if usually sub-10ms) async gap before it's
// actually observing the filesystem. A write that lands inside that gap can
// be missed entirely (not queued, just never seen) rather than merely
// delayed. That's fine in production -- offset tracking means the next
// change event picks up anything missed on the read that follows -- but a
// test that writes synchronously right after watch() can flake on exactly
// this race. Settle past it before the first write each test cares about.
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 250))
}

let dir: string
const watchers: SessionWatcher[] = []

afterEach(() => {
  for (const w of watchers) w.stop()
  watchers.length = 0
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function makeWatcher(opts?: { debounceMs?: number }): SessionWatcher {
  const w = new SessionWatcher(opts)
  watchers.push(w)
  return w
}

describe('SessionWatcher', () => {
  it('emits newly appended complete rows with an advancing endOffset', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f = join(dir, 'session.jsonl')
    writeFileSync(f, '')

    const batches: Array<{ rows: StreamedRow[]; endOffset: number }> = []
    const w = makeWatcher()
    w.watch(f, 0, (rows, endOffset) => batches.push({ rows, endOffset }))
    await settle()

    const content = `${line('u1')}\n${line('u2')}\n`
    appendFileSync(f, content)

    await waitUntil(() => batches.length > 0)

    expect(batches).toHaveLength(1)
    expect(batches[0]!.rows.map((r) => (r.row as { uuid: string }).uuid)).toEqual(['u1', 'u2'])
    expect(batches[0]!.endOffset).toBe(Buffer.byteLength(content))
  })

  it('does not emit a partial line until its newline arrives, and does not duplicate it once complete', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f = join(dir, 'session.jsonl')
    writeFileSync(f, '')

    const batches: Array<{ rows: StreamedRow[]; endOffset: number }> = []
    const w = makeWatcher({ debounceMs: 20 })
    w.watch(f, 0, (rows, endOffset) => batches.push({ rows, endOffset }))
    await settle()

    // Append a partial line (no trailing newline) and give the watcher ample
    // opportunity to (wrongly) fire on it.
    const partial = '{"type":"user","uuid":"hal'
    appendFileSync(f, partial)
    await new Promise((r) => setTimeout(r, 300))
    expect(batches).toHaveLength(0)

    // Complete the line -- it must emit now, exactly once, not duplicated.
    const rest = '9000","parentUuid":null,"message":{"role":"user","content":"hi"}}\n'
    appendFileSync(f, rest)
    await waitUntil(() => batches.length > 0)

    // Give any stray duplicate emission a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 200))

    expect(batches).toHaveLength(1)
    expect(batches[0]!.rows).toHaveLength(1)
    expect((batches[0]!.rows[0]!.row as { uuid: string }).uuid).toBe('hal9000')
    expect(batches[0]!.endOffset).toBe(Buffer.byteLength(partial + rest))
  })

  it('coalesces multiple rapid appends within the debounce window into one callback', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f = join(dir, 'session.jsonl')
    writeFileSync(f, '')

    const batches: Array<{ rows: StreamedRow[]; endOffset: number }> = []
    const w = makeWatcher({ debounceMs: 150 })
    w.watch(f, 0, (rows, endOffset) => batches.push({ rows, endOffset }))
    await settle()

    appendFileSync(f, line('u1') + '\n')
    await new Promise((r) => setTimeout(r, 30))
    appendFileSync(f, line('u2') + '\n')
    await new Promise((r) => setTimeout(r, 30))
    appendFileSync(f, line('u3') + '\n')

    await waitUntil(() => batches.length > 0, 4000)
    // Allow the debounce window to fully settle before asserting no further batches land.
    await new Promise((r) => setTimeout(r, 300))

    expect(batches).toHaveLength(1)
    expect(batches[0]!.rows.map((r) => (r.row as { uuid: string }).uuid)).toEqual(['u1', 'u2', 'u3'])
  })

  it('stop() prevents any further callback', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f = join(dir, 'session.jsonl')
    writeFileSync(f, '')

    let calls = 0
    const w = makeWatcher({ debounceMs: 20 })
    w.watch(f, 0, () => { calls++ })
    await settle()

    appendFileSync(f, line('u1') + '\n')
    await waitUntil(() => calls > 0)
    expect(calls).toBe(1)

    w.stop()
    appendFileSync(f, line('u2') + '\n')
    await new Promise((r) => setTimeout(r, 400))
    expect(calls).toBe(1)
  })

  it('re-reads from 0 when the file is shrunk/rewritten', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f = join(dir, 'session.jsonl')
    const initial = `${line('u1')}\n${line('u2')}\n${line('u3')}\n`
    writeFileSync(f, initial)

    const batches: Array<{ rows: StreamedRow[]; endOffset: number }> = []
    const w = makeWatcher({ debounceMs: 20 })
    // Start watching as if we'd already indexed the whole initial file.
    w.watch(f, Buffer.byteLength(initial), (rows, endOffset) => batches.push({ rows, endOffset }))
    await settle()

    const rewritten = `${line('r1')}\n`
    writeFileSync(f, rewritten) // shrinks the file -- simulates compaction/rewrite

    await waitUntil(() => batches.length > 0)

    expect(batches[0]!.rows.map((r) => (r.row as { uuid: string }).uuid)).toEqual(['r1'])
    expect(batches[0]!.endOffset).toBe(Buffer.byteLength(rewritten))
  })

  it('picks up a brand-new session\'s very first write, even when neither the file nor its containing directory exist yet at watch() time (Plan 2 Task 10 e2e regression)', async () => {
    // Mirrors a real brand-new chat: the coordinator starts watching the
    // predicted file path (Task 8's startNewChat) before the CLI has ever
    // run, so at watch()-time NEITHER the session file NOR its containing
    // "projects/<slug>/" directory exists on disk yet. A file's first-ever
    // appearance is chokidar's 'add' event, not 'change' -- and chokidar
    // can't even detect that without the containing directory already
    // existing to attach a watch to (verified against a real chokidar probe:
    // watching a path whose parent directory is also missing yields zero
    // events, ever, even after both are created).
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-new-'))
    const nestedDir = join(dir, 'projects', 'brand-new-slug')
    const f = join(nestedDir, 'session.jsonl')
    // Deliberately do NOT create nestedDir or f before watch().

    const batches: Array<{ rows: StreamedRow[]; endOffset: number }> = []
    const w = makeWatcher({ debounceMs: 20 })
    w.watch(f, 0, (rows, endOffset) => batches.push({ rows, endOffset }))
    await settle()

    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(f, line('u1') + '\n')

    await waitUntil(() => batches.length > 0)
    expect(batches[0]!.rows.map((r) => (r.row as { uuid: string }).uuid)).toEqual(['u1'])

    // A subsequent append (an ordinary 'change') must still work too.
    appendFileSync(f, line('u2') + '\n')
    await waitUntil(() => batches.length > 1)
    expect(batches[1]!.rows.map((r) => (r.row as { uuid: string }).uuid)).toEqual(['u2'])
  })

  it('a change event for a deleted file does not crash', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f = join(dir, 'session.jsonl')
    writeFileSync(f, line('u1') + '\n')

    const w = makeWatcher({ debounceMs: 20 })
    let calls = 0
    w.watch(f, Buffer.byteLength(line('u1') + '\n'), () => { calls++ })
    await settle()

    rmSync(f, { force: true })
    // Give the watcher a chance to react to the unlink/change without throwing.
    await new Promise((r) => setTimeout(r, 300))
    expect(calls).toBe(0)
  })

  it('single-flights overlapping reads: no duplicate rows and a monotonic, non-regressing offset', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f = join(dir, 'session.jsonl')
    writeFileSync(f, '')

    const batches: Array<{ rows: StreamedRow[]; endOffset: number }> = []

    // Gate the FIRST streamRange call so it stays suspended until the test
    // explicitly releases it -- this lets us deterministically force a
    // second `change` event (and confirm it does NOT start a second,
    // overlapping read) while the first is still in flight. Later calls
    // pass straight through to the real streamRange.
    // A plain `let` reassigned only inside the executor closure gets
    // over-narrowed by TS's control-flow analysis to `null` at the call
    // site below (a known TS CFA limitation); holding it in an object
    // field sidesteps that.
    const gate: { release: (() => void) | null } = { release: null }
    const firstReadGate = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    let readCalls = 0
    const readCallOffsets: number[] = []
    const slowReadRange: typeof streamRange = async (filePath, fromOffset, toOffset, seqStart, maxLineBytes) => {
      readCalls++
      readCallOffsets.push(fromOffset)
      if (readCalls === 1) await firstReadGate
      return streamRange(filePath, fromOffset, toOffset, seqStart, maxLineBytes)
    }

    const w = new SessionWatcher({ debounceMs: 20, readRange: slowReadRange })
    watchers.push(w)
    w.watch(f, 0, (rows, endOffset) => batches.push({ rows, endOffset }))
    await settle()

    const firstChunk = `${line('u1')}\n${line('u2')}\n`
    appendFileSync(f, firstChunk)

    // Wait for the first (gated) streamRange call to actually start.
    await waitUntil(() => readCalls >= 1)

    // While the first read is suspended mid-flight, append more content.
    // Its `change` event's debounce timer must fire and request a rerun
    // rather than starting a second, overlapping streamRange call. The
    // gap before this second write matters: two writes issued in quick
    // succession can be coalesced into a single native fs notification
    // (observed on Windows) rather than surfacing as two separate `change`
    // events, which would make this test pass vacuously against unfixed
    // code (the "second request" would never actually happen). A ~1.5s gap
    // reliably yields a genuine second `change` event; the first read
    // stays gated for as long as it takes since it only resumes when this
    // test releases it below.
    await new Promise((r) => setTimeout(r, 1500))
    const secondChunk = `${line('u3')}\n`
    appendFileSync(f, secondChunk)
    await new Promise((r) => setTimeout(r, 500))
    expect(readCalls).toBe(1) // no overlapping second call while the first is in flight

    // Let the first read finish -- the single-flight guard's rerun should
    // pick up the second chunk automatically.
    gate.release?.()

    const total = Buffer.byteLength(firstChunk + secondChunk)
    await waitUntil(() => batches.reduce((n, b) => n + b.rows.length, 0) >= 3, 4000)
    // Let any stray duplicate emission land before asserting.
    await new Promise((r) => setTimeout(r, 300))

    const allRows = batches.flatMap((b) => b.rows)
    const uuids = allRows.map((r) => (r.row as { uuid: string }).uuid)
    expect(uuids).toEqual(['u1', 'u2', 'u3']) // each row emitted exactly once, no duplicates

    const offsets = batches.map((b) => b.endOffset)
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!) // never regresses
    }
    expect(offsets.at(-1)).toBe(total)
    expect(readCallOffsets[0]).toBe(0)
  })

  it('watch() called twice without stop() replaces the previous watch', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-watcher-'))
    const f1 = join(dir, 'a.jsonl')
    const f2 = join(dir, 'b.jsonl')
    writeFileSync(f1, '')
    writeFileSync(f2, '')

    const batchesF1: Array<{ rows: StreamedRow[]; endOffset: number }> = []
    const batchesF2: Array<{ rows: StreamedRow[]; endOffset: number }> = []
    const w = makeWatcher({ debounceMs: 20 })
    w.watch(f1, 0, (rows, endOffset) => batchesF1.push({ rows, endOffset }))
    w.watch(f2, 0, (rows, endOffset) => batchesF2.push({ rows, endOffset }))
    await settle()

    appendFileSync(f1, line('u1') + '\n')
    appendFileSync(f2, line('u2') + '\n')

    await waitUntil(() => batchesF2.length > 0)
    await new Promise((r) => setTimeout(r, 300))

    expect(batchesF2).toHaveLength(1)
    expect(batchesF1).toHaveLength(0)
  })
})
