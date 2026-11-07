import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog } from '../src/main/catalog/db'
import { getSettings } from '../src/main/catalog/settings'
import { findClaudeExecutable, loadModelPrices, parseModelPrices, readModelPrices } from '../src/main/engine/model-prices'
import { resolveModelPricing, setModelPrices } from '../src/shared/models'

const CATALOG = 'note:"x",schema_version:1,pricing_tiers:{tier_a:{input:2,output:10,cache_write_5m:2.5,cache_write_1h:4,cache_read:0.2,web_search:0.01},' +
  'tier_b:{input:0.1,output:0.5,cache_write_5m:0.125,cache_write_1h:0.2,cache_read:0.01,web_search:0.01,long_prompt:{above_prompt_tokens:1e5,input:0.5,output:2.5,cache_write_5m:0.625,cache_write_1h:1,cache_read:0.05}}},' +
  'models:[{id:"claude-sonnet-5",family:"sonnet",display_name:"Sonnet 5",pricing:"tier_a",capabilities:[]},' +
  '{id:"claude-sonnet-6",family:"sonnet",display_name:"Sonnet 6",context:{window:1e6},pricing:"tier_b",capabilities:[]},' +
  '{id:"claude-odd",family:"odd",display_name:"No such tier",pricing:"tier_z"}]'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-prices-')) })
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  setModelPrices(null)
})

function install(version: string, contents: string | Buffer): string {
  const dir = join(home, '.local', 'share', 'claude', 'versions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, version)
  writeFileSync(file, contents)
  return file
}

describe('parseModelPrices', () => {
  it('gives each model its tier, using the one-hour cache-write rate', () => {
    const prices = parseModelPrices(CATALOG)!
    expect(prices.models['claude-sonnet-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 })
    expect(prices.models['claude-sonnet-6']).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 })
  })

  it('takes the last of each name as its newest', () => {
    expect(parseModelPrices(CATALOG)!.newest.sonnet).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 })
  })

  it('leaves out a model whose tier is missing', () => {
    expect(parseModelPrices(CATALOG)!.models['claude-odd']).toBeUndefined()
  })

  it('gives nothing when the catalog no longer looks as expected', () => {
    expect(parseModelPrices('nothing here')).toBeNull()
    expect(parseModelPrices('schema_version:1,pricing_tiers:{no models')).toBeNull()
    expect(parseModelPrices('schema_version:1,pricing_tiers:{},models:[]')).toBeNull()
  })
})

describe('finding the prices in the executable', () => {
  it('picks the newest version by number, not by name', () => {
    install('2.1.99', 'a')
    const newest = install('2.1.318', 'b')
    expect(findClaudeExecutable(home)).toBe(newest)
  })

  it('finds nothing without a native install', () => {
    expect(findClaudeExecutable(home)).toBeNull()
  })

  it('finds the catalog deep in a big file, even across a read boundary', async () => {
    // Puts the marker over the 8 MB boundary between two chunks.
    const padding = Buffer.alloc(8 * 1024 * 1024 - 20 - 'note:"x",'.length, 0x20)
    const prices = await readModelPrices(install('2.1.1', Buffer.concat([padding, Buffer.from(CATALOG, 'latin1'), Buffer.alloc(1000)])))
    expect(prices?.models['claude-sonnet-5']?.input).toBe(2)
  })

  it('searches once per file, and again when the file changes', async () => {
    const db = openCatalog(':memory:')
    const file = install('2.1.1', CATALOG)
    expect((await loadModelPrices(db, home))?.models['claude-sonnet-5']?.input).toBe(2)

    const stamp = new Date('2026-01-01T00:00:00Z')
    utimesSync(file, stamp, stamp)
    await loadModelPrices(db, home)
    // Same size and time: what was kept is used, and the new contents aren't read.
    writeFileSync(file, CATALOG.replace('input:2,', 'input:3,'))
    utimesSync(file, stamp, stamp)
    expect((await loadModelPrices(db, home))?.models['claude-sonnet-5']?.input).toBe(2)
    // A new time means a new file: it's searched again.
    const later = new Date('2026-02-01T00:00:00Z')
    utimesSync(file, later, later)
    expect((await loadModelPrices(db, home))?.models['claude-sonnet-5']?.input).toBe(3)
    expect(getSettings(db)).not.toHaveProperty('modelPricesCache')
  })

  it('gives nothing when the executable has no catalog', async () => {
    install('2.1.1', 'no catalog in this file')
    expect(await loadModelPrices(openCatalog(':memory:'), home)).toBeNull()
  })
})

describe('resolveModelPricing with prices from Claude Code', () => {
  it('uses them over the built-in table, longest id first', () => {
    expect(resolveModelPricing('claude-sonnet-5').input).toBe(2)
    setModelPrices({ models: { 'claude-sonnet-5': { input: 7, output: 7, cacheRead: 7, cacheWrite: 7 }, 'claude-sonnet-5-9': { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }, newest: { sonnet: { input: 8, output: 8, cacheRead: 8, cacheWrite: 8 } } })
    expect(resolveModelPricing('claude-sonnet-5-20260101').input).toBe(7)
    expect(resolveModelPricing('claude-sonnet-5-9').input).toBe(9)
    expect(resolveModelPricing('sonnet').input).toBe(8)
    expect(resolveModelPricing('claude-sonnet-99').input).toBe(8)
  })

  it('prices a brand new name through its own family, once Claude Code knows it', () => {
    const rate = { input: 42, output: 42, cacheRead: 42, cacheWrite: 42 }
    setModelPrices({ models: { 'claude-newname-1': rate }, newest: { newname: rate } })
    expect(resolveModelPricing('claude-newname-1').input).toBe(42)
    expect(resolveModelPricing('claude-newname-2').input).toBe(42)
  })

  it('goes back to the built-in table without them', () => {
    setModelPrices({ models: {}, newest: {} })
    setModelPrices(null)
    expect(resolveModelPricing('claude-opus-5-5').input).toBe(4)
  })
})
