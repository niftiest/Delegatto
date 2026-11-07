import type { Catalog } from '../catalog/db'
import type { IndexProgress } from '../../shared/types'
import { discover, claudeHome, type DiscoveredFile } from './discover'
import { indexFile } from './index-file'

export type IndexResult = { files: number; added: number; skipped: number; failed: number }

// Main transcripts must sort before every subagent transcript, not merely
// "not necessarily after". A plain `a.kind === 'main' ? -1 : 1` comparator
// is stable under Array#sort's guarantee (equal elements keep discover()'s
// filesystem order), so ties within a kind are left exactly as discovered
// -- only the main/subagent partition is reordered.
function byMainFirst(a: DiscoveredFile, b: DiscoveredFile): number {
  if (a.kind === b.kind) return 0
  return a.kind === 'main' ? -1 : 1
}

// Tracks the full-archive walk so the periodic external-change sweep
// (engine/external-sync.ts) can stay out of its way: until the first full
// index finishes, every not-yet-indexed file looks "changed", and a sweep
// would just duplicate runIndex's work concurrently.
let activeRuns = 0
let completedRuns = 0
/** True once at least one full index has finished and none is running. */
export function isCatalogSettled(): boolean {
  return completedRuns > 0 && activeRuns === 0
}

export async function runIndex(
  db: Catalog,
  opts: { home?: string; onProgress?: (p: IndexProgress) => void } = {}
): Promise<IndexResult> {
  activeRuns++
  try {
    return await runIndexInner(db, opts)
  } finally {
    activeRuns--
    completedRuns++
  }
}

async function runIndexInner(
  db: Catalog,
  opts: { home?: string; onProgress?: (p: IndexProgress) => void }
): Promise<IndexResult> {
  const files = discover(opts.home ?? claudeHome())
  // Main transcripts first so a subagent's toolUseId resolves against a present parent.
  files.sort(byMainFirst)

  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0)
  let bytesDone = 0, added = 0, skipped = 0, failed = 0, done = 0

  for (const file of files) {
    try {
      const result = await indexFile(db, file)
      added += result.added
      if (result.skipped) skipped++
    } catch (err) {
      // One unreadable/corrupt transcript (deleted mid-scan, permission
      // error, a line past streamRows' max size) must not abort indexing
      // of the rest of the archive -- especially since main transcripts
      // are indexed first and a thrown error here would silently skip
      // every subagent that follows, even ones unrelated to the failure.
      // The file is neither added-to nor counted as skipped, but it IS
      // counted as failed so a caller can tell a partially-failed index
      // apart from a clean one (added-bearing + skipped + failed === files).
      // It will be retried on the next run since its session offset was not
      // advanced.
      console.error(`[indexer] failed to index ${file.filePath}:`, err)
      failed++
    }
    bytesDone += file.size
    done++
    opts.onProgress?.({ done, total: files.length, bytesDone, bytesTotal, current: file.filePath })
  }

  return { files: files.length, added, skipped, failed }
}
