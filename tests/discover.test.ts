import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, cwdToProjectDir } from '../src/main/indexer/discover'

// Simulating a genuine EACCES from the OS is impractical on Windows (no
// POSIX permission bits, and node:fs's readdirSync export isn't
// re-configurable via vi.spyOn under vitest's ESM interop). Instead this
// partially mocks node:fs so one specific project directory's readdirSync
// throws like a permission-denied entry would, exercising the same
// fault-tolerance path as a real EACCES. The stray-`subagents`-file test
// below covers a real-filesystem ENOTDIR case without any mocking.
let throwForPath: string | null = null
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readdirSync: ((dir: Parameters<typeof actual.readdirSync>[0], ...rest: unknown[]) => {
      if (throwForPath !== null && String(dir) === throwForPath) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readdirSync as any)(dir, ...rest)
    }) as typeof actual.readdirSync
  }
})

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-'))
  const proj = join(home, 'projects', 'C--Users-x-GIT-Demo')
  const sid = '61212a6c-6326-4c06-acd1-fd6d3c3b3003'
  mkdirSync(join(proj, sid, 'subagents'), { recursive: true })
  mkdirSync(join(proj, 'memory'), { recursive: true })
  writeFileSync(join(proj, `${sid}.jsonl`), '{"type":"user"}\n')
  writeFileSync(join(proj, sid, 'subagents', 'agent-abc123.jsonl'), '{"type":"user"}\n')
  writeFileSync(
    join(proj, sid, 'subagents', 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Build editor', toolUseId: 'toolu_01', spawnDepth: 1 })
  )
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('discover', () => {
  it('finds main transcripts and ignores memory dirs', () => {
    const mains = discover(home).filter(f => f.kind === 'main')
    expect(mains).toHaveLength(1)
    expect(mains[0]!.sessionId).toBe('61212a6c-6326-4c06-acd1-fd6d3c3b3003')
    expect(mains[0]!.size).toBeGreaterThan(0)
  })

  it('finds subagents and attaches their meta sidecar', () => {
    const subs = discover(home).filter(f => f.kind === 'subagent')
    expect(subs).toHaveLength(1)
    expect(subs[0]!.kind === 'subagent' && subs[0]!.meta?.toolUseId).toBe('toolu_01')
    expect(subs[0]!.kind === 'subagent' && subs[0]!.meta?.spawnDepth).toBe(1)
  })

  it('returns an empty array when the projects dir is absent', () => {
    expect(discover(join(home, 'nope'))).toEqual([])
  })

  it('returns null meta when .meta.json sidecar is absent', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'cc-'))
    try {
      const proj = join(tempHome, 'projects', 'test-project')
      const sid = '12345678-1234-1234-1234-123456789012'
      mkdirSync(join(proj, sid, 'subagents'), { recursive: true })
      writeFileSync(join(proj, sid, 'subagents', 'agent-xyz.jsonl'), '{"type":"user"}\n')
      // Note: no .meta.json file written
      const subs = discover(tempHome).filter(f => f.kind === 'subagent')
      expect(subs).toHaveLength(1)
      expect(subs[0]!.kind === 'subagent' && subs[0]!.meta).toBe(null)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('returns null meta when .meta.json contains invalid JSON', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'cc-'))
    try {
      const proj = join(tempHome, 'projects', 'test-project')
      const sid = '12345678-1234-1234-1234-123456789012'
      mkdirSync(join(proj, sid, 'subagents'), { recursive: true })
      writeFileSync(join(proj, sid, 'subagents', 'agent-xyz.jsonl'), '{"type":"user"}\n')
      writeFileSync(join(proj, sid, 'subagents', 'agent-xyz.meta.json'), 'not valid json {]')
      const subs = discover(tempHome).filter(f => f.kind === 'subagent')
      expect(subs).toHaveLength(1)
      expect(subs[0]!.kind === 'subagent' && subs[0]!.meta).toBe(null)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('validates agentType and description types, falling back to defaults when wrong', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'cc-'))
    try {
      const proj = join(tempHome, 'projects', 'test-project')
      const sid = '12345678-1234-1234-1234-123456789012'
      mkdirSync(join(proj, sid, 'subagents'), { recursive: true })
      writeFileSync(join(proj, sid, 'subagents', 'agent-xyz.jsonl'), '{"type":"user"}\n')
      writeFileSync(
        join(proj, sid, 'subagents', 'agent-xyz.meta.json'),
        JSON.stringify({ agentType: 5, description: true, toolUseId: 'toolu_xyz', spawnDepth: 1 })
      )
      const subs = discover(tempHome).filter(f => f.kind === 'subagent')
      expect(subs).toHaveLength(1)
      const sub = subs[0]!
      expect(sub.kind === 'subagent' && sub.meta).not.toBe(null)
      expect(sub.kind === 'subagent' && sub.meta?.agentType).toBe('unknown')
      expect(sub.kind === 'subagent' && sub.meta?.description).toBe('')
      expect(sub.kind === 'subagent' && sub.meta?.toolUseId).toBe('toolu_xyz')
      expect(sub.kind === 'subagent' && sub.meta?.spawnDepth).toBe(1)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('skips a session whose `subagents` path is a stray file (ENOTDIR), without aborting the rest of the walk', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'cc-'))
    try {
      const proj = join(tempHome, 'projects', 'test-project')
      const badSid = '12345678-1234-1234-1234-123456789012'
      const goodSid = '87654321-4321-4321-4321-210987654321'

      // Session whose `subagents` entry is a plain FILE, not a directory --
      // readdirSync(subDir) throws ENOTDIR on this.
      mkdirSync(join(proj, badSid), { recursive: true })
      writeFileSync(join(proj, `${badSid}.jsonl`), '{"type":"user"}\n')
      writeFileSync(join(proj, badSid, 'subagents'), 'not a directory')

      // A second, healthy session alongside it.
      mkdirSync(join(proj, goodSid, 'subagents'), { recursive: true })
      writeFileSync(join(proj, `${goodSid}.jsonl`), '{"type":"user"}\n')
      writeFileSync(join(proj, goodSid, 'subagents', 'agent-ok.jsonl'), '{"type":"user"}\n')

      let files: ReturnType<typeof discover> = []
      expect(() => {
        files = discover(tempHome)
      }).not.toThrow()

      const mains = files.filter(f => f.kind === 'main')
      expect(mains.map(f => f.sessionId).sort()).toEqual([badSid, goodSid].sort())

      const subs = files.filter(f => f.kind === 'subagent')
      expect(subs).toHaveLength(1)
      expect(subs[0]!.sessionId).toBe(goodSid)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('skips a project directory whose readdirSync throws (e.g. EACCES), without aborting other projects', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'cc-'))
    try {
      const root = join(tempHome, 'projects')
      const badProject = join(root, 'bad-project')
      const goodProject = join(root, 'good-project')
      const sid = '11111111-2222-3333-4444-555555555555'

      mkdirSync(badProject, { recursive: true })
      mkdirSync(goodProject, { recursive: true })
      writeFileSync(join(goodProject, `${sid}.jsonl`), '{"type":"user"}\n')

      throwForPath = badProject
      try {
        let files: ReturnType<typeof discover> = []
        expect(() => {
          files = discover(tempHome)
        }).not.toThrow()

        const mains = files.filter(f => f.kind === 'main')
        expect(mains).toHaveLength(1)
        expect(mains[0]!.sessionId).toBe(sid)
      } finally {
        throwForPath = null
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})

describe('cwdToProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash (verified against real CLI slugs)', () => {
    expect(cwdToProjectDir('C:\\Users\\x\\OneDrive\\Desktop\\GIT\\Delegatto'))
      .toBe('C--Users-x-OneDrive-Desktop-GIT-Delegatto')
  })

  it('replaces a posix path the same way', () => {
    expect(cwdToProjectDir('/home/x/git/demo')).toBe('-home-x-git-demo')
  })

  it('does not collapse consecutive separators (e.g. a dotfile segment)', () => {
    expect(cwdToProjectDir('C:\\Users\\x\\.claude\\jobs\\abc')).toBe('C--Users-x--claude-jobs-abc')
  })

  it('leaves a literal dash in the original path untouched (replacing "-" with "-" is the identity)', () => {
    expect(cwdToProjectDir('/home/x/Code-Review')).toBe('-home-x-Code-Review')
  })

  it('is deterministic: the same cwd always yields the same slug', () => {
    expect(cwdToProjectDir('/a/b/c')).toBe(cwdToProjectDir('/a/b/c'))
  })

  it('is the identity for an already-alphanumeric string', () => {
    expect(cwdToProjectDir('AlreadyClean123')).toBe('AlreadyClean123')
  })
})
