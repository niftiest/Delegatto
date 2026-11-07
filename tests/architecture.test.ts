import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// src/shared is imported by the renderer (and by main) and must stay
// electron-free just like the other pure node layers -- it is not itself
// a "main" layer, but any electron import here would leak into the renderer
// bundle.
//
// src/main/engine is the engine core (events.ts, transport.ts, and future
// pool.ts/watcher.ts/permission-bridge.ts) -- it must also stay electron-free
// so it can run standalone / be unit-tested without electron. The sole
// sanctioned exception is engine-ipc.ts, the IPC boundary that wires the
// engine to the main process; it is excluded below by filename, not by
// directory, so every other file under src/main/engine is still enforced.
const PURE_DIRS = ['src/main/jsonl', 'src/main/catalog', 'src/main/indexer', 'src/shared', 'src/main/engine', 'src/main/manage', 'src/main/claude-settings']

function filesUnder(dir: string): string[] {
  let out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out = out.concat(filesUnder(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

// Catches every way electron can be pulled into a pure layer:
//   import x from 'electron'            import x from 'electron/main'
//   import('electron')                  import('electron/main')
//   require('electron')                 require('electron/renderer')
// A single alternation: an import/require "opener" (`from`, `import(`, or
// `require(`), then a quoted module specifier that is exactly `electron` or
// starts with `electron/`.
const ELECTRON_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]electron(?:\/[^'"]*)?['"]/

describe('layering', () => {
  it('pure node layers never import electron', () => {
    const offenders: string[] = []
    for (const dir of PURE_DIRS) {
      for (const file of filesUnder(dir)) {
        // engine-ipc.ts (per Plan 2's Global Constraints) is the one engine
        // file permitted to import electron -- it *is* the electron
        // boundary the rest of the engine core is kept free of.
        if (file.endsWith('-ipc.ts')) continue
        if (ELECTRON_IMPORT.test(readFileSync(file, 'utf8'))) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
