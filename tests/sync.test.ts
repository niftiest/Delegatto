import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePath } from '../src/main/manage/paths'
import { realRunner, type Runner } from '../src/main/engine/github'
import { syncOffer, type EnableProgress, type SyncIncoming } from '../src/shared/sync-types'
import { pushProgressReader } from '../src/main/sync/git'
import { SyncService, type KeyStore, type SyncHub } from '../src/main/sync/service'
import { deriveKey, keyCheck, newKdf, newRecoveryKey, SyncCodec, verifyKeyCheck, WrongKeyError } from '../src/main/sync/crypto'
import { fingerprintOf, redactSecrets, scanText } from '../src/main/sync/secret-scan'
import { readRows, rowKey } from '../src/main/sync/transcript'
import { RenameService } from '../src/main/manage/rename'
import { FakeClaudeTree } from './manage/fake-tree'

// Real git, against a real repo in a temp folder.
vi.setConfig({ testTimeout: 120_000 })

const NO_DECISIONS = { redact: [], allow: [], excludeChats: [] }
const REPO = 'me/delegatto-sync'
// Built in pieces so this file doesn't look like it holds a real key.
const FAKE_KEY = ['sk-ant-api03', 'Qw8Zt2Lm9Xc4Vb7Nn1Rk5Jh3Gf6Ds0Pa'].join('-')

let base: string
let bare: string
let hub: SyncHub & { isPrivate: boolean; created: boolean }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function memoryKeys(): KeyStore {
  let key: Buffer | null = null
  let recovery: string | null = null
  return {
    load: () => key, loadRecovery: () => recovery, canSave: () => true,
    save: (k, r) => { key = k; recovery = r }, clear: () => { key = null; recovery = null }
  }
}

type Pc = {
  name: string
  tree: FakeClaudeTree
  service: SyncService
  busy: Set<string>
  open: Set<string>
  external: Set<string>
  stopped: string[]
  dataDir: string
  run: Runner
  titles: Map<string, string>
  incoming: SyncIncoming[][]
}

function makePc(name: string, opts: { run?: Runner } = {}): Pc {
  const tree = new FakeClaudeTree()
  const dataDir = join(base, `${name}-data`)
  mkdirSync(dataDir, { recursive: true })
  const busy = new Set<string>()
  const open = new Set<string>()
  const external = new Set<string>()
  const stopped: string[] = []
  const titles = new Map<string, string>()
  const incoming: SyncIncoming[][] = []
  const run = opts.run ?? realRunner
  const service = new SyncService({
    paths: tree.paths, run, hub, keys: memoryKeys(), dataDir, hostname: name,
    remoteUrl: () => `file:///${bare.replace(/\\/g, '/')}`,
    credentialArgs: [],
    isChatBusy: id => busy.has(id),
    isChatOpen: id => open.has(id),
    isExternallyLive: id => external.has(id),
    stopChat: id => { stopped.push(id); open.delete(id) },
    afterLocalChange: async () => {},
    sessionPkOf: () => null,
    setChatTitle: (file, title) => { titles.set(file, title) },
    trustFolder: () => {},
    onChange: () => {},
    onIncoming: list => { incoming.push(list) },
    sleep: () => Promise.resolve()
  })
  return { name, tree, service, busy, open, external, stopped, dataDir, run, titles, incoming }
}

function userRow(cwd: string, sessionId: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid: randomUUID(), cwd, sessionId, message: { role: 'user', content: text } })
}

function assistantRow(cwd: string, sessionId: string, text: string): string {
  return JSON.stringify({ type: 'assistant', uuid: randomUUID(), cwd, sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

function chatFile(pc: Pc, root: string, sessionId: string): string {
  return join(pc.tree.paths.projectsDir, encodePath(root), `${sessionId}.jsonl`)
}

function linesOf(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.length > 0)
}

function textsOf(file: string): string[] {
  return linesOf(file).map(l => {
    const row = JSON.parse(l) as { message?: { content?: unknown } }
    const c = row.message?.content
    return typeof c === 'string' ? c : Array.isArray(c) ? String((c[0] as { text?: string }).text) : ''
  })
}

function repoFiles(): string[] {
  return git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(l => l.length > 0)
}

async function ok(p: Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const r = await p
  expect(r.error).toBeUndefined()
  expect(r.ok).toBe(true)
}

/** PC A with one chat opted in, and PC B linked to the repo. */
async function pair(): Promise<{ a: Pc; b: Pc; rootA: string; rootB: string; sid: string; key: string; projectId: string }> {
  const a = makePc('PC-A')
  const b = makePc('PC-B')
  const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
  if (!made.ok) throw new Error(made.error)
  const rootA = a.tree.workDir('App')
  const sid = randomUUID()
  a.tree.addSessionRaw(rootA, sid, userRow(rootA, sid, `work in ${rootA}`), assistantRow(rootA, sid, 'done'))
  await ok(a.service.enableProject(rootA, NO_DECISIONS))
  const linked = await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: made.recoveryKey! })
  if (!linked.ok) throw new Error(linked.error)
  const status = await b.service.status()
  const projectId = status.remoteProjects[0]!.projectId
  const rootB = join(base, 'elsewhere', 'Moved')
  const result = await b.service.linkProject(projectId, rootB)
  if (!result.ok) throw new Error(result.error)
  return { a, b, rootA, rootB, sid, key: made.recoveryKey!, projectId }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cc-sync-'))
  bare = join(base, 'remote.git')
  mkdirSync(bare)
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(bare, 'config', 'uploadpack.allowFilter', 'true')
  hub = {
    isPrivate: true,
    created: false,
    status: async () => ({ state: 'ready', account: 'me' }),
    async view() { return { exists: hub.created, isPrivate: hub.created ? hub.isPrivate : null } },
    async create() { hub.created = true },
    sizeBytes: async () => 1234,
    async header() {
      try { return git(bare, 'show', 'main:delegatto-sync.json') } catch { return null }
    },
    async privateReposWithFile() {
      const text = await hub.header(REPO)
      return text === null ? [] : [{ repo: REPO, text }]
    }
  }
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('secret scan', () => {
  it('finds known key formats and masks them', () => {
    const found = scanText(JSON.stringify({ text: `my key is ${FAKE_KEY} ok` }))
    expect(found).toHaveLength(1)
    expect(found[0]!.rule).toBe('Anthropic API key')
    expect(found[0]!.confidence).toBe('definite')
    expect(found[0]!.masked).not.toContain('Qw8Zt2')
    expect(found[0]!.context).not.toContain(FAKE_KEY)
  })

  it('calls a keyword match only possible, and skips placeholders', () => {
    expect(scanText('password = "hT7$kQ2zPm9xLw4v"')[0]?.confidence).toBe('possible')
    expect(scanText('password = "your_password_here"')).toHaveLength(0)
    expect(scanText('api_key: process.env.API_KEY_VALUE')).toHaveLength(0)
    expect(scanText('sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toHaveLength(0)
  })

  it('ignores pictures', () => {
    const data = 'A'.repeat(3000) + `${FAKE_KEY.replace(/-/g, '')}`
    expect(scanText(`{"type":"image","source":{"data":"${data}"}}`)).toHaveLength(0)
  })

  it('copes with a picture many megabytes long in one row, and still finds a key beside it', () => {
    const data = 'QUJD'.repeat(4 * 1024 * 1024)
    const found = scanText(`{"type":"image","source":{"data":"${data}"},"note":"${FAKE_KEY}"}`)
    expect(found.map(f => f.rule)).toEqual(['Anthropic API key'])
  })

  it('redacts without breaking the JSON', () => {
    const line = JSON.stringify({ text: `key ${FAKE_KEY}` })
    const out = redactSecrets(line, scanText(line))
    expect(out).not.toContain(FAKE_KEY)
    expect(() => JSON.parse(out) as unknown).not.toThrow()
  })
})

describe('encryption', () => {
  it('round-trips, and refuses a wrong key or a swapped file', async () => {
    const kdf = newKdf()
    const recovery = newRecoveryKey()
    const key = await deriveKey(recovery, kdf)
    expect(await deriveKey(recovery.toLowerCase().replace(/-/g, ' '), kdf)).toEqual(key)
    const codec = new SyncCodec(key)
    const packed = await codec.pack(Buffer.from('hello'), 'a.bin')
    expect((await codec.unpack(packed, 'a.bin')).toString()).toBe('hello')
    expect(packed.includes(Buffer.from('hello'))).toBe(false)
    await expect(codec.unpack(packed, 'b.bin')).rejects.toBeInstanceOf(WrongKeyError)
    const other = new SyncCodec(await deriveKey(newRecoveryKey(), kdf))
    await expect(other.unpack(packed, 'a.bin')).rejects.toBeInstanceOf(WrongKeyError)
    expect(verifyKeyCheck(key, keyCheck(key))).toBe(true)
    expect(verifyKeyCheck(await deriveKey(newRecoveryKey(), kdf), keyCheck(key))).toBe(false)
  })
})

describe('transcript reading', () => {
  it('takes only complete lines', async () => {
    const file = join(base, 'chat.jsonl')
    writeFileSync(file, '{"uuid":"a"}\n{"uuid":"b"}\n{"uuid":"par')
    const rows = []
    for await (const r of readRows(file)) rows.push(r.text)
    expect(rows).toEqual(['{"uuid":"a"}', '{"uuid":"b"}'])
  })

  it('gives a row the same key whatever its paths say', () => {
    expect(rowKey('{"uuid":"x","cwd":"D:\\\\a"}')).toBe(rowKey('{"uuid":"x","cwd":"E:\\\\b"}'))
    expect(rowKey('{"type":"ai-title","aiTitle":"T","cwd":"a"}')).toBe(rowKey('{"type":"ai-title","aiTitle":"T","cwd":"b"}'))
  })
})

describe('setting up', () => {
  it('can sync a brand-new project with nothing in it yet', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: false })
    const folder = join(a.dataDir, 'brand-new')
    mkdirSync(folder, { recursive: true })
    const scan = await a.service.scanProjectFor(folder)
    expect(scan).toMatchObject({ chats: 0, findings: [] })
    await ok(a.service.enableProject(folder, { redact: [], allow: [], excludeChats: [] }))
    const row = (await a.service.status()).projects.find(p => p.name === 'brand-new')
    expect(row?.projectId).not.toBeNull()
  })

  it('finds sync repos on the account and ignores files that only look like one', async () => {
    const a = makePc('PC-A')
    hub.privateReposWithFile = async () => [
      { repo: 'me/real', text: JSON.stringify({ format: 'delegatto-sync', version: 1, encrypted: true, kdf: null, check: null }) },
      { repo: 'me/other-format', text: JSON.stringify({ format: 'something-else', version: 1 }) },
      { repo: 'me/junk', text: 'not json' }
    ]
    await a.service.status()
    await new Promise(r => setTimeout(r, 20))
    const found = await a.service.status()
    expect(found.discoveredRepos).toEqual(['me/real'])
    expect(found.leftSync).toBe(false)
  })

  it('stops offering a repo once linked, and remembers choosing to disconnect', async () => {
    const a = makePc('PC-A')
    hub.privateReposWithFile = async () => [{ repo: 'me/delegatto-sync', text: JSON.stringify({ format: 'delegatto-sync', version: 1 }) }]
    await a.service.status()
    await new Promise(r => setTimeout(r, 20))
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    expect(syncOffer(await a.service.status(), new Set())).toBeNull()
    await a.service.disconnect()
    expect((await a.service.status()).leftSync).toBe(true)
  })

  it('carries on if the look-up fails', async () => {
    const a = makePc('PC-A')
    hub.privateReposWithFile = async () => { throw new Error('offline') }
    expect((await a.service.status()).discoveredRepos).toEqual([])
    await new Promise(r => setTimeout(r, 20))
    expect((await a.service.status()).discoveredRepos).toEqual([])
  })

  it('creates a private repo with a key, and refuses a public one', async () => {
    const a = makePc('PC-A')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    expect(made.ok).toBe(true)
    if (made.ok) expect(made.recoveryKey).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/)
    expect(repoFiles()).toEqual(['delegatto-sync.json'])

    hub.isPrivate = false
    const b = makePc('PC-B')
    const linked = await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: 'whatever' })
    expect(linked).toEqual({ ok: false, error: `${REPO} is public. Sync only uses private repositories.` })
  })

  it('refuses a repo that came out public, uploading nothing', async () => {
    hub.isPrivate = false
    const a = makePc('PC-A')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    expect(made.ok).toBe(false)
    expect(git(bare, 'for-each-ref')).toBe('')
  })

  it('refuses a wrong recovery key', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const b = makePc('PC-B')
    const linked = await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: newRecoveryKey() })
    expect(linked).toEqual({ ok: false, error: "That recovery key doesn't match this sync repo." })
  })
})

describe('turning sync on', () => {
  it('makes an encrypted repo with no questions when the account has none', async () => {
    const a = makePc('PC-A')
    const r = await a.service.turnOn(null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.repo).toBe(REPO)
    expect(r.encrypted).toBe(true)
    expect(r.recoveryKey).not.toBeNull()
    expect(a.service.recoveryKey()).toBe(r.recoveryKey)
  })

  it('asks for the key when the account already has a sync repo, then links with it', async () => {
    const a = makePc('PC-A')
    const made = await a.service.turnOn(null)
    const b = makePc('PC-B')
    expect(await b.service.turnOn(null)).toEqual({ ok: false, needsKey: true, repo: REPO })
    expect((await b.service.turnOn(newRecoveryKey())).ok).toBe(false)
    const linked = await b.service.turnOn(made.ok ? made.recoveryKey : null)
    expect(linked.ok).toBe(true)
    expect((await b.service.status()).configured).toBe(true)
  })

  it('lists synced GitHub repos where a PC without the key can read them, and keeps the list current', async () => {
    const a = makePc('PC-A')
    await a.service.turnOn(null)
    const root = a.tree.workDir('Shop')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/me/Shop.git\n')
    const sid = randomUUID()
    a.tree.addSessionRaw(root, sid, userRow(root, sid, 'hi'), assistantRow(root, sid, 'done'))
    await ok(a.service.enableProject(root, NO_DECISIONS))
    expect(JSON.parse(git(bare, 'show', 'main:delegatto-sync.json')).repos).toEqual(['me/Shop'])
    expect((await a.service.status()).syncedRepos).toEqual(['me/Shop'])

    // A PC that hasn't linked sees it too, from the header alone.
    const b = makePc('PC-B')
    await b.service.status()
    await new Promise(r => setTimeout(r, 50))
    expect((await b.service.status()).syncedRepos).toEqual(['me/Shop'])

    const projectId = (await a.service.status()).projects.find(p => p.projectId !== null)!.projectId!
    await ok(a.service.removeFromGithub(projectId))
    expect(JSON.parse(git(bare, 'show', 'main:delegatto-sync.json')).repos).toEqual([])
  })
})

describe('the recovery key', () => {
  it('can be shown again on the PC that made it and on a PC linked with it', async () => {
    const { a, b, key } = await pair()
    expect(a.service.recoveryKey()).toBe(key)
    expect(b.service.recoveryKey()).toBe(key)
    expect((await a.service.status()).hasRecoveryKey).toBe(true)
    await ok(b.service.disconnect())
    expect(b.service.recoveryKey()).toBeNull()
  })

  it('keeps the usual form however it was typed when linking', async () => {
    const a = makePc('PC-A')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const b = makePc('PC-B')
    const sloppy = made.ok ? made.recoveryKey!.toLowerCase().replace(/-/g, ' ') : ''
    const linked = await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: sloppy })
    expect(linked.ok).toBe(true)
    expect(b.service.recoveryKey()).toBe(made.ok ? made.recoveryKey : null)
  })

  it('has none for a repo that isn\'t encrypted', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: false })
    expect(a.service.recoveryKey()).toBeNull()
  })

  it('can be replaced: chats stay readable, the new key links a PC, and the old key stops working', async () => {
    const { a, b, rootA, sid, key } = await pair()
    const made = await a.service.replaceRecoveryKey()
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.recoveryKey).not.toBe(key)
    expect(a.service.recoveryKey()).toBe(made.recoveryKey)
    expect(git(bare, 'rev-list', '--count', 'main').trim()).toBe('1')

    // A keeps syncing under the new key.
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'after the new key')}\n`)
    await ok(a.service.syncNow())

    // B still has the old key, and is told what to do instead of failing on every file.
    const stale = await b.service.syncNow()
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error).toMatch(/new recovery key/)

    // The old key no longer links; the new one does, and brings the chat with what came after.
    const c = makePc('PC-C')
    expect((await c.service.setupExisting({ name: 'delegatto-sync', recoveryKey: key })).ok).toBe(false)
    expect((await c.service.setupExisting({ name: 'delegatto-sync', recoveryKey: made.recoveryKey! })).ok).toBe(true)
    const projectId = (await c.service.status()).remoteProjects[0]!.projectId
    const rootC = join(base, 'third', 'App')
    const linked = await c.service.linkProject(projectId, rootC)
    expect(linked.ok).toBe(true)
    expect(textsOf(chatFile(c, rootC, sid))).toContain('after the new key')
  })
})

describe('syncing between two PCs', () => {
  it('brings a chat across with its paths pointed at the new folder', async () => {
    const { b, rootA, rootB, sid } = await pair()
    const file = chatFile(b, rootB, sid)
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(JSON.stringify(rootA).slice(1, -1))
    expect(text).toContain(JSON.stringify(rootB).slice(1, -1))
    expect((JSON.parse(linesOf(file)[0]!) as { cwd: string }).cwd).toBe(rootB)
    expect(existsSync(rootB)).toBe(true)
  })

  it('stores everything encrypted, including names and titles', async () => {
    const { rootA } = await pair()
    for (const name of repoFiles()) {
      const data = git(bare, 'show', `main:${name}`)
      expect(data).not.toContain('done')
      expect(data).not.toContain(rootA.replace(/\\/g, '\\\\'))
      expect(name).not.toContain('App')
    }
  })

  it('uploads only new rows, and never changes a file already uploaded', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    const before = new Map(repoFiles().map(f => [f, git(bare, 'rev-parse', `main:${f}`).trim()]))
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'second')}\n`)
    await ok(a.service.syncNow())

    const after = repoFiles()
    const added = after.filter(f => !before.has(f))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatch(/\/r000001-[0-9a-f]+\.bin$/)
    for (const [f, sha] of before) {
      if (f.endsWith('index.bin') || f.startsWith('catalog/')) continue
      expect(git(bare, 'rev-parse', `main:${f}`).trim()).toBe(sha)
    }

    await ok(b.service.syncNow())
    expect(textsOf(chatFile(b, rootB, sid)).at(-1)).toBe('second')
  })

  it('keeps each PC on its own paths in both directions, and uploads no translation', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    appendFileSync(chatFile(b, rootB, sid), `${userRow(rootB, sid, `from b in ${rootB}`)}\n`)
    await ok(b.service.syncNow())
    await ok(a.service.syncNow())
    const last = linesOf(chatFile(a, rootA, sid)).at(-1)!
    expect((JSON.parse(last) as { cwd: string }).cwd).toBe(rootA)
    expect(textsOf(chatFile(a, rootA, sid)).at(-1)).toBe(`from b in ${rootA}`)

    // Nothing comes back the other way: B's copy didn't change and A has nothing new to send.
    const commits = git(bare, 'rev-list', '--count', 'main')
    await ok(a.service.syncNow())
    await ok(b.service.syncNow())
    expect(git(bare, 'rev-list', '--count', 'main')).toBe(commits)
    expect((JSON.parse(linesOf(chatFile(b, rootB, sid)).at(-1)!) as { cwd: string }).cwd).toBe(rootB)
  })

  it('leaves a chat alone while it is mid-turn, and closes an idle one before changing it', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'more')}\n`)
    await ok(a.service.syncNow())

    b.busy.add(sid)
    await ok(b.service.syncNow())
    expect(textsOf(chatFile(b, rootB, sid))).not.toContain('more')

    b.busy.delete(sid)
    b.open.add(sid)
    await ok(b.service.syncNow())
    expect(b.stopped).toEqual([sid])
    expect(textsOf(chatFile(b, rootB, sid))).toContain('more')
  })

  it('waits for a chat open in a terminal', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'more')}\n`)
    await ok(a.service.syncNow())
    b.external.add(sid)
    await ok(b.service.syncNow())
    expect(textsOf(chatFile(b, rootB, sid))).not.toContain('more')
    b.external.delete(sid)
    await ok(b.service.syncNow())
    expect(textsOf(chatFile(b, rootB, sid))).toContain('more')
  })

  it('splits a very long chat so no file nears GitHub\'s limit', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const root = a.tree.workDir('Big')
    const sid = randomUUID()
    const big = 'x'.repeat(1024 * 1024)
    a.tree.addSessionRaw(root, sid, ...Array.from({ length: 40 }, () => userRow(root, sid, big)))
    await ok(a.service.enableProject(root, NO_DECISIONS))
    const chunks = repoFiles().filter(f => /\/r\d+-/.test(f))
    expect(chunks.length).toBe(2)
  })

  it('reports how far a project\'s first sync has got', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const root = a.tree.workDir('Progress')
    for (let i = 0; i < 3; i++) {
      const sid = randomUUID()
      a.tree.addSessionRaw(root, sid, userRow(root, sid, `chat ${i}`), assistantRow(root, sid, 'done'))
    }
    const seen: EnableProgress[] = []
    await ok(a.service.enableProject(root, NO_DECISIONS, p => seen.push(p)))
    expect(seen[0]!.phase).toBe('download')
    const packs = seen.filter(p => p.phase === 'pack')
    expect(packs.map(p => p.done)).toEqual([0, 1, 2, 3])
    expect(packs.every(p => p.total === 3)).toBe(true)
    const uploads = seen.filter(p => p.phase === 'upload')
    expect(uploads[0]!.done).toBe(0)
    expect(uploads.at(-1)!.done).toBe(100)
    expect(seen.findIndex(p => p.phase === 'upload')).toBeGreaterThan(seen.findIndex(p => p.phase === 'pack'))
  })

  it('reads git\'s push progress even when a line arrives in pieces', () => {
    const got: number[] = []
    const read = pushProgressReader(p => got.push(p))
    read('Enumerating objects: 5, done.\nWriting objects:  4')
    read('0% (2/5)\rWriting objects:  40% (2/5)\rWriting objects: 100% (5/5), 1.2 KiB | 1.2 MiB/s, done.\n')
    expect(got).toEqual([40, 100])
  })

  it('reports each step of setting a project up on another PC, counting its chats in', async () => {
    const a = makePc('PC-A')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const rootA = a.tree.workDir('Shop')
    for (let i = 0; i < 2; i++) {
      const sid = randomUUID()
      a.tree.addSessionRaw(rootA, sid, userRow(rootA, sid, `chat ${i}`), assistantRow(rootA, sid, 'done'))
    }
    await ok(a.service.enableProject(rootA, NO_DECISIONS))
    const b = makePc('PC-B')
    await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: made.ok ? made.recoveryKey! : '' })
    const projectId = (await b.service.status()).remoteProjects[0]!.projectId
    const rootB = join(base, 'elsewhere', 'Shop')
    const seen: EnableProgress[] = []
    const linked = await b.service.linkProject(projectId, rootB, p => seen.push(p))
    expect(linked.ok).toBe(true)
    expect(seen[0]!.phase).toBe('download')
    const packs = seen.filter(p => p.phase === 'pack')
    expect(packs.map(p => p.done)).toEqual([0, 1, 2])
    expect(packs.every(p => p.total === 2)).toBe(true)
    expect(seen.findIndex(p => p.phase === 'pack')).toBeGreaterThan(seen.findIndex(p => p.phase === 'download'))
    expect(seen.every(p => p.workingDir.toLowerCase() === rootB.toLowerCase())).toBe(true)
  })

  it('says which chat is getting messages from which PC, counts them in, then lets go', async () => {
    const { a, b, rootA, sid } = await pair()
    for (let i = 0; i < 3; i++) appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, `more ${i}`)}\n`)
    await ok(a.service.syncNow())
    b.incoming.length = 0
    await ok(b.service.syncNow())
    const seen = b.incoming.flat().filter(i => i.sessionId === sid)
    expect(seen[0]).toMatchObject({ phase: 'download', from: 'PC-A' })
    const writes = seen.filter(i => i.phase === 'write')
    expect(writes[0]).toMatchObject({ done: 0, total: 3, from: 'PC-A' })
    expect(writes.at(-1)).toMatchObject({ done: 3, total: 3 })
    expect(b.incoming.at(-1)).toEqual([])
    expect(b.service.incomingChats()).toEqual([])

    // Its own upload isn't news to itself.
    a.incoming.length = 0
    await ok(a.service.syncNow())
    expect(a.incoming.flat()).toEqual([])
  })

  it('stops syncing a project on this PC when it is deleted here, and leaves GitHub alone', async () => {
    const { b, rootB, projectId } = await pair()
    await b.service.projectDeleted(rootB)
    const status = await b.service.status()
    expect(status.projects.some(p => p.projectId === projectId)).toBe(false)
    expect(status.remoteProjects.some(p => p.projectId === projectId)).toBe(true)
  })

  it('does not bring back a chat deleted on this PC, or remove it from the other', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    rmSync(chatFile(b, rootB, sid))
    await ok(b.service.syncNow())
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'still here')}\n`)
    await ok(a.service.syncNow())
    await ok(b.service.syncNow())
    expect(existsSync(chatFile(b, rootB, sid))).toBe(false)
    expect(textsOf(chatFile(a, rootA, sid))).toContain('still here')
  })

  it('syncs project memory and subagent logs, and leaves environment files behind', async () => {
    const a = makePc('PC-A')
    const b = makePc('PC-B')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    if (!made.ok) throw new Error(made.error)
    const root = a.tree.workDir('App')
    const sid = randomUUID()
    a.tree.addSessionRaw(root, sid, userRow(root, sid, 'hi'))
    const dir = join(a.tree.paths.projectsDir, encodePath(root))
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'MEMORY.md'), `notes about ${root}`)
    mkdirSync(join(dir, sid, 'subagents'), { recursive: true })
    writeFileSync(join(dir, sid, 'subagents', 'agent-1.jsonl'), '{"uuid":"s1"}\n')
    const envDir = join(a.tree.paths.claudeDir, 'session-env', sid)
    mkdirSync(envDir, { recursive: true })
    writeFileSync(join(envDir, 'hook.sh'), 'export SECRET=abc')
    await ok(a.service.enableProject(root, NO_DECISIONS))

    await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: made.recoveryKey! })
    const rootB = join(base, 'elsewhere', 'App2')
    const id = (await b.service.status()).remoteProjects[0]!.projectId
    const linked = await b.service.linkProject(id, rootB)
    expect(linked.ok).toBe(true)
    const dirB = join(b.tree.paths.projectsDir, encodePath(rootB))
    expect(readFileSync(join(dirB, 'memory', 'MEMORY.md'), 'utf8')).toBe(`notes about ${rootB}`)
    expect(readFileSync(join(dirB, sid, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"uuid":"s1"}\n')
    expect(existsSync(join(b.tree.paths.claudeDir, 'session-env', sid))).toBe(false)
  })

  it('keeps syncing after a project folder is renamed, without treating it as a conflict', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    const renamed = `${rootA}-renamed`
    const rename = new RenameService(a.tree.paths, () => [])
    const result = await rename.execute(await rename.plan(rootA, renamed))
    expect(result.failures).toEqual([])
    await a.service.projectFolderRenamed(encodePath(rootA), encodePath(renamed))
    appendFileSync(chatFile(a, renamed, sid), `${userRow(renamed, sid, 'after the rename')}\n`)
    await ok(a.service.syncNow())
    expect((await a.service.status()).conflicts).toHaveLength(0)
    await ok(b.service.syncNow())
    expect(textsOf(chatFile(b, rootB, sid)).at(-1)).toBe('after the rename')
    expect((JSON.parse(linesOf(chatFile(b, rootB, sid)).at(-1)!) as { cwd: string }).cwd).toBe(rootB)
    appendFileSync(chatFile(b, rootB, sid), `${userRow(rootB, sid, 'reply from b')}\n`)
    await ok(b.service.syncNow())
    await ok(a.service.syncNow())
    expect((JSON.parse(linesOf(chatFile(a, renamed, sid)).at(-1)!) as { cwd: string }).cwd).toBe(renamed)
  })

  it('downloads only the projects this PC chose', async () => {
    const { a, b, projectId } = await pair()
    const other = a.tree.workDir('Other')
    const sid = randomUUID()
    a.tree.addSessionRaw(other, sid, userRow(other, sid, 'other project'))
    await ok(a.service.enableProject(other, NO_DECISIONS))
    await ok(b.service.syncNow())
    const data = readdirSync(join(b.dataDir, 'sync-repo', 'data'))
    expect(data).toEqual([projectId])
    expect((await b.service.status()).remoteProjects.map(p => p.name)).toEqual(['Other'])
  })
})

describe('when a chat changes on two PCs', () => {
  it('notices, and uploads nothing until the user chooses', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'from a')}\n`)
    await ok(a.service.syncNow())
    appendFileSync(chatFile(b, rootB, sid), `${userRow(rootB, sid, 'from b')}\n`)
    await ok(b.service.syncNow())

    const status = await b.service.status()
    expect(status.conflicts).toHaveLength(1)
    expect(status.conflicts[0]).toMatchObject({ sessionId: sid, otherDevice: 'PC-A', localRows: 1, remoteRows: 1 })
    expect(textsOf(chatFile(b, rootB, sid)).at(-1)).toBe('from b')
    await ok(a.service.syncNow())
    expect(textsOf(chatFile(a, rootA, sid))).not.toContain('from b')
  })

  it('keeps both: the synced version stays, and this PC\'s messages become a linked chat', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'from a')}\n`)
    await ok(a.service.syncNow())
    appendFileSync(chatFile(b, rootB, sid), `${userRow(rootB, sid, 'from b')}\n${assistantRow(rootB, sid, 'b replied')}\n`)
    await ok(b.service.syncNow())

    const r = await b.service.resolveConflict(sid)
    if (!r.ok) throw new Error(r.error)
    expect(textsOf(chatFile(b, rootB, sid))).toEqual([`work in ${rootB}`, 'done', 'from a'])
    const branch = chatFile(b, rootB, r.branchSessionId)
    const rows = linesOf(branch)
    expect(textsOf(branch).slice(0, 4)).toEqual([`work in ${rootB}`, 'done', 'from b', 'b replied'])
    expect(rows.slice(0, 4).every(l => (JSON.parse(l) as { sessionId: string }).sessionId === r.branchSessionId)).toBe(true)
    expect(JSON.parse(rows.at(-1)!)).toMatchObject({ type: 'custom-title', sessionId: r.branchSessionId })
    expect(r.summary).toContain('from b')
    expect(r.summary).toContain('b replied')
    expect(r.summary).toContain('report of separate work')
    expect((await b.service.status()).conflicts).toHaveLength(0)

    // The branch reaches the other PC, and the main chat carries on normally.
    await ok(a.service.syncNow())
    expect(existsSync(chatFile(a, rootA, r.branchSessionId))).toBe(true)
    expect(b.titles.get(branch)).toContain('(from PC-B)')
    await new Promise(done => setTimeout(done, 50))
    expect(a.titles.get(chatFile(a, rootA, r.branchSessionId))).toContain('(from PC-B)')
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'carry on')}\n`)
    await ok(a.service.syncNow())
    await ok(b.service.syncNow())
    expect(textsOf(chatFile(b, rootB, sid)).at(-1)).toBe('carry on')
    expect((await b.service.status()).conflicts).toHaveLength(0)
  })

  it('a PC that was behind when pushing redoes the sync without losing anything', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    // Another project's change arrives between B's pull and its push.
    const second = randomUUID()
    a.tree.addSessionRaw(rootA, second, userRow(rootA, second, 'new chat on a'))
    const realPull = (b.service as unknown as { git: { pull(): Promise<string | null> } }).git
    const pull = realPull.pull.bind(realPull)
    let once = true
    realPull.pull = async () => {
      const result = await pull()
      if (once) {
        once = false
        await ok(a.service.syncNow())
      }
      return result
    }
    const third = randomUUID()
    b.tree.addSessionRaw(rootB, third, userRow(rootB, third, 'new chat on b'))
    await ok(b.service.syncNow())
    expect(existsSync(chatFile(b, rootB, second))).toBe(true)
    await ok(a.service.syncNow())
    expect(existsSync(chatFile(a, rootA, third))).toBe(true)
    expect(existsSync(chatFile(b, rootB, sid))).toBe(true)
  })

  it('recognises the same chat already on both PCs at first sync', async () => {
    const a = makePc('PC-A')
    const b = makePc('PC-B')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    if (!made.ok) throw new Error(made.error)
    const rootA = a.tree.workDir('App')
    const rootB = b.tree.workDir('App')
    const sid = randomUUID()
    const row1 = userRow(rootA, sid, 'shared')
    a.tree.addSessionRaw(rootA, sid, row1)
    b.tree.addSessionRaw(rootB, sid, row1.split(JSON.stringify(rootA).slice(1, -1)).join(JSON.stringify(rootB).slice(1, -1)))
    await ok(a.service.enableProject(rootA, NO_DECISIONS))
    await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: made.recoveryKey! })
    const id = (await b.service.status()).remoteProjects[0]!.projectId
    const linked = await b.service.linkProject(id, rootB)
    expect(linked.ok).toBe(true)
    expect((await b.service.status()).conflicts).toHaveLength(0)
    expect(linesOf(chatFile(b, rootB, sid))).toHaveLength(1)
  })
})

describe('likely secrets', () => {
  it('scans what tools read, not only what was typed, and lists it before opting in', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const root = a.tree.workDir('App')
    const sid = randomUUID()
    a.tree.addSessionRaw(root, sid, JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: sid, cwd: root, toolUseResult: { stdout: `API=${FAKE_KEY}` } }))
    const scan = await a.service.scanProjectFor(root)
    expect(scan.findings).toHaveLength(1)
    expect(scan.findings[0]!.sessionIds).toEqual([sid])
    expect(JSON.stringify(scan)).not.toContain(FAKE_KEY)
  })

  it('redacts only the synced copy when asked', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const root = a.tree.workDir('App')
    const sid = randomUUID()
    a.tree.addSessionRaw(root, sid, userRow(root, sid, `key ${FAKE_KEY}`))
    await ok(a.service.enableProject(root, { redact: [fingerprintOf(FAKE_KEY)], allow: [], excludeChats: [] }))
    expect(readFileSync(chatFile(a, root, sid), 'utf8')).toContain(FAKE_KEY)
    const status = await a.service.status()
    expect(status.projects.find(p => p.projectId !== null)!.pendingFindings).toHaveLength(0)
    expect(repoFiles().some(f => /\/r000000-/.test(f))).toBe(true)
  })

  it('holds a chat when a new secret appears, until the user chooses', async () => {
    const { a, b, rootA, rootB, sid, projectId } = await pair()
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, `oops ${FAKE_KEY}`)}\n`)
    await ok(a.service.syncNow())
    const status = await a.service.status()
    expect(status.projects.find(p => p.projectId === projectId)!.pendingFindings).toHaveLength(1)
    await ok(b.service.syncNow())
    expect(readFileSync(chatFile(b, rootB, sid), 'utf8')).not.toContain('oops')

    await ok(a.service.decideFindings(projectId, { redact: [fingerprintOf(FAKE_KEY)], allow: [], excludeChats: [] }))
    await ok(b.service.syncNow())
    const text = readFileSync(chatFile(b, rootB, sid), 'utf8')
    expect(text).toContain('oops')
    expect(text).not.toContain(FAKE_KEY)
    expect(text).toContain('[REDACTED Anthropic API key]')
    expect((await a.service.status()).projects.find(p => p.projectId === projectId)!.pendingFindings).toHaveLength(0)
  })

  it('leaves out a chat the user excluded', async () => {
    const a = makePc('PC-A')
    await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    const root = a.tree.workDir('App')
    const keep = randomUUID()
    const leave = randomUUID()
    a.tree.addSessionRaw(root, keep, userRow(root, keep, 'fine'))
    a.tree.addSessionRaw(root, leave, userRow(root, leave, `key ${FAKE_KEY}`))
    await ok(a.service.enableProject(root, { redact: [], allow: [], excludeChats: [leave] }))
    const files = repoFiles()
    expect(files.some(f => f.includes(keep))).toBe(true)
    expect(files.some(f => f.includes(leave))).toBe(false)
  })
})

describe('other PCs and project code', () => {
  it('shows which PC has a chat open, by name, and when it was last seen', async () => {
    const { a, b, sid, rootB } = await pair()
    a.service.chatOpened(sid)
    await a.service.syncNow()
    await b.service.tick()
    await b.service.tick()
    const info = await b.service.chatInfo(sid, rootB)
    expect(info.synced).toBe(true)
    expect(info.elsewhere).toMatchObject({ device: 'PC-A', hostname: 'PC-A', active: true })
  })

  it('presence does not add to main\'s history', async () => {
    const { a, sid } = await pair()
    a.service.setDeviceName('Office PC')
    await a.service.syncNow()
    const before = git(bare, 'rev-list', '--count', 'main')
    a.service.chatOpened(sid)
    await a.service.syncNow()
    a.service.chatOpened(null)
    await a.service.syncNow()
    expect(git(bare, 'rev-list', '--count', 'main')).toBe(before)
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/presence')).toMatch(/refs\/heads\/presence\//)
  })

  it('clones the project repo, follows its branch, and warns about what a clone can\'t have', async () => {
    const source = join(base, 'project-origin.git')
    mkdirSync(source)
    git(source, 'init', '-q', '--bare', '-b', 'main')
    // gh goes to the local stand-in for GitHub, everything else runs for real.
    const run: Runner = async (file, args, opts) => {
      if (file === 'gh' && args[0] === 'repo' && args[1] === 'clone') return realRunner('git', ['clone', '-q', source, args[3]!], opts)
      return realRunner(file, args, opts)
    }
    const a = makePc('PC-A', { run })
    const b = makePc('PC-B', { run })
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    if (!made.ok) throw new Error(made.error)
    const root = a.tree.workDir('App')
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 't@example.invalid')
    git(root, 'config', 'user.name', 'T')
    writeFileSync(join(root, 'a.txt'), 'one')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'one')
    git(root, 'remote', 'add', 'origin', 'https://github.com/me/app.git')
    git(root, 'config', `url.${source.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/me/app.git')
    git(root, 'checkout', '-qb', 'feature')
    git(root, 'push', '-q', '-u', 'origin', 'main', 'feature')
    writeFileSync(join(root, 'a.txt'), 'two')
    git(root, 'commit', '-qam', 'unpushed')
    writeFileSync(join(root, 'b.txt'), 'not committed')
    const sid = randomUUID()
    a.tree.addSessionRaw(root, sid, userRow(root, sid, 'hi'))
    await ok(a.service.enableProject(root, NO_DECISIONS))

    await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: made.recoveryKey! })
    const remote = (await b.service.status()).remoteProjects[0]!
    expect(remote).toMatchObject({ github: 'me/app', branch: 'feature', unpushed: 1, uncommitted: 1 })
    const rootB = join(base, 'test', 'App')
    const linked = await b.service.linkProject(remote.projectId, rootB)
    if (!linked.ok) throw new Error(linked.error)
    expect(git(rootB, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature')
    expect(readFileSync(join(rootB, 'a.txt'), 'utf8')).toBe('one')
    expect(linked.warnings.join(' ')).toContain('1 commit not pushed')
    expect(linked.warnings.join(' ')).toContain('1 changed file not committed')
    expect(existsSync(chatFile(b, rootB, sid))).toBe(true)

    const info = await b.service.chatInfo(sid, rootB)
    expect(info.codeNote).toContain('last ran on PC-A')
  })

  it('never imports chats when the clone fails or the folder has other files', async () => {
    const a = makePc('PC-A')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: true })
    if (!made.ok) throw new Error(made.error)
    const root = a.tree.workDir('App')
    writeFileSync(join(root, '.placeholder'), '')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/me/app.git\n')
    const sid = randomUUID()
    a.tree.addSessionRaw(root, sid, userRow(root, sid, 'hi'))
    await ok(a.service.enableProject(root, NO_DECISIONS))

    const b = makePc('PC-B')
    await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: made.recoveryKey! })
    const remote = (await b.service.status()).remoteProjects[0]!
    const taken = join(base, 'taken')
    mkdirSync(taken)
    writeFileSync(join(taken, 'mine.txt'), 'keep me')
    const linked = await b.service.linkProject(remote.projectId, taken)
    expect(linked.ok).toBe(false)
    expect(readFileSync(join(taken, 'mine.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(chatFile(b, taken, sid))).toBe(false)
  })

  it('removes a project from GitHub without touching chats on any PC', async () => {
    const { a, b, rootA, rootB, sid, projectId } = await pair()
    await ok(a.service.removeFromGithub(projectId))
    expect(repoFiles().some(f => f.includes(projectId))).toBe(false)
    expect(existsSync(chatFile(a, rootA, sid))).toBe(true)
    expect(existsSync(chatFile(b, rootB, sid))).toBe(true)
  })

  it('starting fresh keeps every project and drops old history, and other PCs carry on', async () => {
    const { a, b, rootA, rootB, sid } = await pair()
    appendFileSync(chatFile(a, rootA, sid), `${userRow(rootA, sid, 'before fresh')}\n`)
    await ok(a.service.syncNow())
    const files = repoFiles().sort()
    await ok(a.service.startFresh())
    expect(git(bare, 'rev-list', '--count', 'main').trim()).toBe('1')
    expect(repoFiles().sort()).toEqual(files)
    await ok(b.service.syncNow())
    expect(textsOf(chatFile(b, rootB, sid))).toContain('before fresh')
    appendFileSync(chatFile(b, rootB, sid), `${userRow(rootB, sid, 'after fresh')}\n`)
    await ok(b.service.syncNow())
    await ok(a.service.syncNow())
    expect(textsOf(chatFile(a, rootA, sid)).at(-1)).toBe('after fresh')
  })

  it('works without encryption when chosen', async () => {
    const a = makePc('PC-A')
    const b = makePc('PC-B')
    const made = await a.service.setupNew({ name: 'delegatto-sync', encrypted: false })
    if (!made.ok) throw new Error(made.error)
    expect(made.recoveryKey).toBeNull()
    const root = a.tree.workDir('App')
    const sid = randomUUID()
    a.tree.addSessionRaw(root, sid, userRow(root, sid, 'plain'))
    await ok(a.service.enableProject(root, NO_DECISIONS))
    await b.service.setupExisting({ name: 'delegatto-sync', recoveryKey: '' })
    const id = (await b.service.status()).remoteProjects[0]!.projectId
    const rootB = join(base, 'elsewhere', 'P')
    expect((await b.service.linkProject(id, rootB)).ok).toBe(true)
    expect(textsOf(chatFile(b, rootB, sid))).toEqual(['plain'])
  })
})
