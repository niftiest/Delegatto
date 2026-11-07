import { createReadStream, readdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Catalog } from '../catalog/db'
import type { ModelPrices, Pricing } from '../../shared/models'

// Claude Code's prices are only in the model catalog built into its executable: the catalog files
// it downloads to its cache list models without prices. That catalog is plain text in the file.
// If prices stop being found, this marker or the patterns below are what to update.
const CATALOG_MARKER = 'schema_version:1,pricing_tiers:{'
const CATALOG_BYTES = 200_000
const CHUNK_BYTES = 8 * 1024 * 1024
const CACHE_KEY = 'modelPricesCache'

const NUMBER = '([\\d.e+-]+)'
const TIER = new RegExp(`(\\w+):\\{input:${NUMBER},output:${NUMBER},cache_write_5m:${NUMBER},cache_write_1h:${NUMBER},cache_read:${NUMBER}`, 'g')
const MODEL = /\{id:"(claude-[^"]+)",family:"([^"]+)",display_name:"[^"]*"/g

/** The prices in the catalog's text, or null if it no longer looks the way this expects. */
export function parseModelPrices(text: string): ModelPrices | null {
  const start = text.indexOf(CATALOG_MARKER)
  if (start === -1) return null
  const tiersStart = start + CATALOG_MARKER.length
  const modelsStart = text.indexOf('models:[', tiersStart)
  if (modelsStart === -1) return null

  const tiers = new Map<string, Pricing>()
  for (const m of text.slice(tiersStart, modelsStart).matchAll(TIER)) {
    // A tier's long_prompt rates have no name of their own, so they never match as a tier.
    tiers.set(m[1]!, { input: Number(m[2]), output: Number(m[3]), cacheWrite: Number(m[5]), cacheRead: Number(m[6]) })
  }

  const body = text.slice(modelsStart)
  const entries = [...body.matchAll(MODEL)]
  const models: Record<string, Pricing> = {}
  const newest: Record<string, Pricing> = {}
  entries.forEach((entry, i) => {
    const end = entries[i + 1]?.index ?? body.length
    const tierName = /pricing:"(\w+)"/.exec(body.slice(entry.index, end))?.[1]
    const pricing = tierName === undefined ? undefined : tiers.get(tierName)
    if (pricing === undefined) return
    models[entry[1]!] = pricing
    // The catalog lists each name oldest first, so the last one seen is the newest.
    newest[entry[2]!] = pricing
  })
  return Object.keys(models).length > 0 ? { models, newest } : null
}

function versionParts(name: string): number[] {
  return name.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0)
}

/** The newest Claude Code installed by its native installer, or null if there's none. */
export function findClaudeExecutable(home: string): string | null {
  const dir = join(home, '.local', 'share', 'claude', 'versions')
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => /^\d+\.\d+\.\d+/.test(n))
  } catch {
    return null
  }
  names.sort((a, b) => {
    const x = versionParts(a), y = versionParts(b)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const diff = (y[i] ?? 0) - (x[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })
  for (const name of names) {
    try {
      if (statSync(join(dir, name)).isFile()) return join(dir, name)
    } catch { /* it went while looking */ }
  }
  return null
}

/** Where the marker is in the file, or -1. The file is hundreds of megabytes, so it's read in chunks. */
async function findMarker(path: string): Promise<number> {
  const marker = Buffer.from(CATALOG_MARKER, 'latin1')
  let offset = 0
  let tail: Buffer = Buffer.alloc(0)
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES }) as AsyncIterable<Buffer>) {
    // The tail lets a marker that straddles two chunks still match.
    const at = Buffer.concat([tail, chunk]).indexOf(marker)
    if (at !== -1) return offset - tail.length + at
    offset += chunk.length
    tail = chunk.subarray(Math.max(0, chunk.length - marker.length + 1))
  }
  return -1
}

export async function readModelPrices(path: string): Promise<ModelPrices | null> {
  const at = await findMarker(path)
  if (at === -1) return null
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(CATALOG_BYTES)
    const { bytesRead } = await file.read(buffer, 0, CATALOG_BYTES, at)
    return parseModelPrices(buffer.toString('latin1', 0, bytesRead))
  } finally {
    await file.close()
  }
}

/** Claude Code's prices, searching its executable only when that file has changed. Null when
 *  they can't be found, which leaves the table in shared/models.ts in charge. */
export async function loadModelPrices(db: Catalog, home: string): Promise<ModelPrices | null> {
  try {
    const exe = findClaudeExecutable(home)
    if (exe === null) return null
    const stat = statSync(exe)
    const key = `${exe}|${stat.size}|${stat.mtimeMs}`
    const row = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(CACHE_KEY) as { value: string } | undefined
    if (row !== undefined) {
      const cached = JSON.parse(row.value) as { key: string; prices: ModelPrices }
      if (cached.key === key) return cached.prices
    }
    const prices = await readModelPrices(exe)
    if (prices !== null) {
      db.prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(CACHE_KEY, JSON.stringify({ key, prices }))
    }
    return prices
  } catch (e) {
    console.warn('[model-prices] could not read prices from Claude Code:', e)
    return null
  }
}
