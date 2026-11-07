import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { statSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { streamRange, type StreamedRow } from '../jsonl/stream'

const DEFAULT_DEBOUNCE_MS = 50

/** Tails a single growing session `.jsonl` file and hands the caller only
 *  the newly-appended, complete rows since the last read -- the file-system
 *  half of the read path's "durable rows the moment they land" guarantee
 *  (Plan 2 Task 3). Node-only (chokidar + fs) -- must never import electron;
 *  see tests/architecture.test.ts, which enforces this for every file under
 *  src/main/engine except *-ipc.ts. */
export class SessionWatcher {
  private readonly debounceMs: number

  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null

  private filePath: string | null = null
  private lastOffset = 0
  private lastSeq = 0
  private onRows: ((rows: StreamedRow[], endOffset: number) => void) | null = null

  // Bumped by every stop() (including the implicit one at the top of
  // watch()). Any in-flight debounce timer or streamRange() read captures
  // the epoch it was scheduled under and checks it again before touching
  // state or firing the callback -- this is what keeps a debounced read
  // that resolves *after* stop() (or after a later watch() call replaces
  // this session) from ever calling a stale/foreign onRows.
  private epoch = 0

  // Guards against overlapping readNew() executions: scheduleRead's fired
  // timer only ever starts a read when none is already in flight. If a
  // change event lands while a read is running, it sets `rerun` instead of
  // starting a second concurrent read (which would race on `lastOffset` --
  // two reads capturing the same starting offset both emit overlapping
  // rows, and whichever resolves last wins the offset assignment, which can
  // regress it). Once the in-flight read finishes, its `finally` reruns
  // exactly once if `rerun` was set, picking up whatever landed meanwhile.
  private reading = false
  private rerun = false

  // Injectable so tests can force a slow/controllable read without faking
  // timers or racing real fs latency; defaults to the real streamRange used
  // in production.
  private readonly readRange: typeof streamRange

  constructor(opts?: { debounceMs?: number; readRange?: typeof streamRange }) {
    this.debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.readRange = opts?.readRange ?? streamRange
  }

  /** Starts tailing `filePath` from `fromOffset` (the byte offset the caller
   *  has already indexed). Only reacts to *future* appends -- the initial
   *  state of the file at watch-time is never re-emitted.
   *
   *  Calling `watch()` again without an intervening `stop()` is not an
   *  error: it tears down the previous watch (per the same rules as
   *  `stop()`) and replaces it with the new one, so a caller re-pointing the
   *  watcher at a different session doesn't need to remember to stop() the
   *  old one first. */
  watch(filePath: string, fromOffset: number, onRows: (rows: StreamedRow[], endOffset: number) => void): void {
    this.stop()

    const epoch = this.epoch
    this.filePath = filePath
    this.lastOffset = fromOffset
    this.lastSeq = 0
    this.onRows = onRows

    // A brand-new chat (Task 8's startNewChat) watches its predicted file
    // path BEFORE the CLI has ever run against it -- at this point neither
    // the file NOR its containing "projects/<slug>/" directory necessarily
    // exists yet. Verified against a real chokidar probe: watching a path
    // whose *containing directory* doesn't exist at watch()-time never
    // detects that path's later creation, even after both the directory and
    // file are created -- not "delayed", genuinely never. Pre-creating the
    // (possibly multi-level) containing directory here means chokidar always
    // has something real to attach a watch to, so the file's future creation
    // is reliably observed via the 'add' event below. Idempotent and safe:
    // this creates an empty directory, never the file itself, and does
    // nothing if the directory already exists (the ordinary case for an
    // established session). Swallow any failure (e.g. a read-only parent) --
    // a watch that can't pre-create its directory should degrade to
    // "whatever chokidar can detect on its own" rather than throw out of
    // watch() and prevent the caller from proceeding with the rest of the
    // send.
    try {
      mkdirSync(dirname(filePath), { recursive: true })
    } catch (err) {
      console.warn('[watcher] failed to pre-create containing directory', err)
    }

    const watcher = chokidarWatch(filePath, { ignoreInitial: true })
    this.watcher = watcher

    const scheduleRead = (): void => {
      if (epoch !== this.epoch) return
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        if (epoch !== this.epoch) return
        // A read is already running -- don't start a second, overlapping
        // one (see the `reading`/`rerun` comment above). Flag it instead so
        // the current read reruns once it finishes.
        if (this.reading) {
          this.rerun = true
        } else {
          void this.readNew(epoch)
        }
      }, this.debounceMs)
    }

    // A file's very FIRST appearance is chokidar's 'add' event, not
    // 'change' -- 'change' only fires for a modification to a path chokidar
    // already knew existed. Watching only 'change' (the original
    // implementation) silently misses every brand-new session's first-ever
    // write, since that write is exactly what creates the file. Both events
    // drive the same scheduleRead/readNew path -- doRead's own byte-offset
    // math (reading from `this.lastOffset`, starting at 0 for a new file)
    // is what actually determines what's "new" either way.
    watcher.on('add', scheduleRead)
    watcher.on('change', scheduleRead)
    // A deleted file surfaces as 'unlink' (and/or a trailing 'change' from
    // some platforms/editors); readNew()'s statSync try/catch is what
    // actually protects against crashing on either, so no special handling
    // is needed here beyond not letting chokidar's default 'error' behavior
    // (an unhandled 'error' event throws) escape. Still worth surfacing for
    // diagnosis -- this is engine-core, so console (not electron's logger)
    // is the right sink.
    watcher.on('error', (err) => {
      console.warn('[watcher] error', err)
    })
  }

  /** Single-flight entry point for a read: only one `doRead` runs at a time.
   *  If called while one is already in flight (e.g. a rerun requested by a
   *  later readNew() call sharing this same epoch), it marks `rerun` and
   *  returns rather than overlapping. When the in-flight read completes, its
   *  `finally` reruns exactly once if `rerun` was set in the meantime, so
   *  bytes that landed mid-read are never missed. */
  private async readNew(epoch: number): Promise<void> {
    if (epoch !== this.epoch) return
    if (this.reading) {
      this.rerun = true
      return
    }
    this.reading = true
    try {
      await this.doRead(epoch)
    } finally {
      // Only this epoch's own read is allowed to clear the flags: if stop()
      // ran while this read was in flight, it already reset `reading`/
      // `rerun` for the new epoch, and this stale call must not stomp on
      // whatever the new epoch is doing.
      if (epoch === this.epoch) {
        this.reading = false
        if (this.rerun) {
          this.rerun = false
          void this.readNew(epoch)
        }
      }
    }
  }

  private async doRead(epoch: number): Promise<void> {
    if (epoch !== this.epoch) return
    const filePath = this.filePath
    if (filePath === null) return

    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      // File deleted (or otherwise unreadable) between the change event and
      // now -- nothing to read, and definitely not a crash.
      return
    }
    if (epoch !== this.epoch) return

    // Mirrors the read path's rewritten-file handling (src/main/indexer/
    // index-file.ts): a stale offset past the current end of file means the
    // transcript was rewritten (e.g. compaction) rather than appended to.
    // Trusting the old offset would seek past real content and silently
    // miss rows, so reset and re-read from the start.
    //
    // Blind spot: a rewrite that happens to produce a file the exact same
    // byte length as before (size === lastOffset, not <) is indistinguishable
    // from "nothing new" by this check alone and falls through to the
    // no-op return just below. Not handled here -- flagging for whoever
    // next touches this so it isn't mistaken for an oversight.
    if (size < this.lastOffset) {
      this.lastOffset = 0
      this.lastSeq = 0
    }

    // Nothing new since the last read. This is also the no-op path for a
    // Windows chokidar 'change' event fired without an actual size delta --
    // the offset check below naturally absorbs it.
    if (size === this.lastOffset) return

    let result: { rows: StreamedRow[]; endOffset: number; seqEnd: number }
    try {
      result = await this.readRange(filePath, this.lastOffset, undefined, this.lastSeq)
    } catch {
      // The file vanished (or otherwise failed mid-read) between the
      // statSync above and the actual read starting -- same "don't crash on
      // a deleted file" contract as the statSync try/catch, just covering
      // the narrower window after the size check passed.
      return
    }
    if (epoch !== this.epoch) return

    // streamRange never returns a trailing partial line -- if the append
    // was only a partial line (no newline yet), result.endOffset equals
    // this.lastOffset and rows is empty. Advancing lastOffset/lastSeq here
    // is a no-op in that case (same values back), so the next change event
    // re-reads from the same offset and picks up the now-complete line
    // exactly once when it arrives.
    this.lastOffset = result.endOffset
    this.lastSeq = result.seqEnd

    if (result.rows.length > 0 && this.onRows !== null) {
      this.onRows(result.rows, result.endOffset)
    }
  }

  /** Stops watching and guarantees no further `onRows` callback fires, even
   *  for a debounced read already in flight. Safe to call when not
   *  currently watching. */
  stop(): void {
    this.epoch++
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher !== null) {
      const watcher = this.watcher
      this.watcher = null
      void watcher.close().catch(() => {})
    }
    this.filePath = null
    this.onRows = null
    // Reset the single-flight guard for the epoch this stop() just started:
    // any read still in flight under the old epoch already checks epoch on
    // every continuation, so it won't touch state or fire callbacks -- but
    // it also must not leave `reading`/`rerun` stuck for the epoch that
    // follows (this stop(), or a watch() that calls it).
    this.reading = false
    this.rerun = false
  }
}
