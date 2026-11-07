import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  availableRepos, defaultCloneRoot, githubStatus, listGithubRepos, parseGithubRemote, prepareRepo, readOriginRepo,
  type GithubRepo, type Runner
} from '../src/main/engine/github'
import { openCatalog, closeCatalog } from '../src/main/catalog/db'
import { upsertProject, setProjectCwd } from '../src/main/catalog/repos'
import { setFriendlyName } from '../src/main/catalog/metadata'
import { listChannels } from '../src/main/ipc'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-github-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

type Call = { file: string; args: string[]; cwd?: string }
function fakeRunner(reply: (c: Call) => { code: number; stdout?: string; stderr?: string }): Runner & { calls: Call[] } {
  const calls: Call[] = []
  const run = (async (file: string, args: string[], opts?: { cwd?: string }) => {
    const call = { file, args, cwd: opts?.cwd }
    calls.push(call)
    const r = reply(call)
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }) as Runner & { calls: Call[] }
  run.calls = calls
  return run
}

function fakeClone(path: string, url = 'https://github.com/me/app.git'): void {
  mkdirSync(join(path, '.git'), { recursive: true })
  writeFileSync(join(path, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
}

const repo = (fullName: string, over: Partial<GithubRepo> = {}): GithubRepo => ({
  fullName, description: null, isPrivate: false, isArchived: false, pushedAt: null, ...over
})

describe('parseGithubRemote', () => {
  it.each([
    ['https://github.com/me/app.git', 'me/app'],
    ['https://github.com/me/app', 'me/app'],
    ['https://github.com/me/app/', 'me/app'],
    ['HTTPS://GitHub.com/Me/App.git', 'Me/App'],
    ['git@github.com:me/app.git', 'me/app'],
    ['ssh://git@github.com/me/app.git', 'me/app'],
    ['ssh://git@ssh.github.com:443/me/app.git', 'me/app'],
    ['https://user:ghp_secret@github.com/me/app.git', 'me/app'],
    ['https://github.com/me/my.dotted-repo_1.git', 'me/my.dotted-repo_1']
  ])('reads %s', (url, expected) => { expect(parseGithubRemote(url)).toBe(expected) })

  it.each([
    'https://gitlab.com/me/app.git', 'https://github.com.evil.example/me/app.git', 'https://evil.example/github.com/me/app',
    'git@bitbucket.org:me/app.git', 'https://github.com/me', 'https://github.com/me/app/extra', '/local/path/app.git', ''
  ])('ignores %s', url => { expect(parseGithubRemote(url)).toBeNull() })
})

describe('readOriginRepo', () => {
  it('reads origin from .git/config, without any credentials in the url', () => {
    fakeClone(dir, 'https://me:ghp_secret@github.com/me/app.git')
    expect(readOriginRepo(dir)).toBe('me/app')
  })

  it('finds the repo from a subfolder', () => {
    fakeClone(dir)
    const sub = join(dir, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    expect(readOriginRepo(sub)).toBe('me/app')
  })

  it('follows a worktree .git file back to the main config', () => {
    const main = join(dir, 'main')
    fakeClone(main)
    const gitdir = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'commondir'), '../..\n')
    const wt = join(dir, 'wt')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
    expect(readOriginRepo(wt)).toBe('me/app')
  })

  it('prefers origin over another remote, and accepts another if there is no origin', () => {
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'config'),
      '[remote "upstream"]\n\turl = https://github.com/them/app.git\n[remote "origin"]\n\turl = https://github.com/me/app.git\n')
    expect(readOriginRepo(dir)).toBe('me/app')
    writeFileSync(join(dir, '.git', 'config'), '[remote "upstream"]\n\turl = https://github.com/them/app.git\n')
    expect(readOriginRepo(dir)).toBe('them/app')
  })

  it('is null for a missing folder, a non-repo, or a non-GitHub remote', () => {
    expect(readOriginRepo(join(dir, 'gone'))).toBeNull()
    fakeClone(dir, 'https://gitlab.com/me/app.git')
    expect(readOriginRepo(dir)).toBeNull()
  })
})

describe('githubStatus', () => {
  it('is missing when gh cannot run', async () => {
    const run: Runner = async () => { throw new Error('ENOENT') }
    expect(await githubStatus(run)).toEqual({ state: 'missing', account: null })
  })

  it('is signed_out when gh says so', async () => {
    const run = fakeRunner(c => (c.args[0] === 'auth' ? { code: 1, stderr: 'not logged in' } : { code: 0, stdout: 'gh version 2' }))
    expect(await githubStatus(run)).toEqual({ state: 'signed_out', account: null })
  })

  it('is ready with the account', async () => {
    const run = fakeRunner(c => (c.args[0] === 'api' ? { code: 0, stdout: 'niftiest\n' } : { code: 0 }))
    expect(await githubStatus(run)).toEqual({ state: 'ready', account: 'niftiest' })
  })
})

describe('listGithubRepos', () => {
  const line = (o: object) => JSON.stringify(o)

  it('asks for every repo you can reach, and reads one per line', async () => {
    const run = fakeRunner(() => ({
      code: 0,
      stdout: [
        line({ full_name: 'me/a', description: 'desc', private: true, archived: false, pushed_at: '2026-01-01T00:00:00Z' }),
        line({ full_name: 'org/b', description: null, private: false, archived: true, pushed_at: null })
      ].join('\n') + '\n'
    }))
    const repos = await listGithubRepos(run)
    expect(repos).toEqual([
      { fullName: 'me/a', description: 'desc', isPrivate: true, isArchived: false, pushedAt: '2026-01-01T00:00:00Z' },
      { fullName: 'org/b', description: null, isPrivate: false, isArchived: true, pushedAt: null }
    ])
    const args = run.calls[0]!.args
    expect(args[0]).toBe('api')
    expect(args).toContain('--paginate')
    expect(args.join(' ')).toContain('affiliation=owner,collaborator,organization_member')
  })

  it('drops a row whose name is not a plain owner/name', async () => {
    const run = fakeRunner(() => ({ code: 0, stdout: `${line({ full_name: '--upload-pack=x/y' })}\nnot json\n${line({ full_name: 'me/ok' })}\n` }))
    expect((await listGithubRepos(run)).map(r => r.fullName)).toEqual(['me/ok'])
  })

  it('throws what gh said when it fails', async () => {
    const run = fakeRunner(() => ({ code: 1, stderr: 'HTTP 401' }))
    await expect(listGithubRepos(run)).rejects.toThrow('HTTP 401')
  })
})

describe('defaultCloneRoot', () => {
  it('uses the folder most of your linked projects sit in', () => {
    const a = join(dir, 'code', 'a'), b = join(dir, 'code', 'b'), c = join(dir, 'other', 'c')
    expect(defaultCloneRoot([a, b, c], dir)).toBe(join(dir, 'code'))
  })

  it('falls back to a GitHub folder in home', () => {
    expect(defaultCloneRoot([], dir)).toBe(join(dir, 'GitHub'))
  })
})

describe('availableRepos', () => {
  const root = join('D:', 'GIT')
  const origins: Record<string, string> = { 'D:/GIT/linked': 'Me/Linked' }
  const originOf = (cwd: string) => origins[cwd.replace(/\\/g, '/')] ?? null

  it('lists every repo: one a project already uses, whatever the case, keeps that folder', () => {
    const repos = [repo('me/linked'), repo('me/free')]
    expect(availableRepos(repos, ['D:/GIT/linked'], root, originOf)).toEqual([
      { ...repos[0], destination: 'D:/GIT/linked', onThisPc: true },
      { ...repos[1], destination: join(root, 'free'), onThisPc: false }
    ])
  })

  it("doesn't count a folder as a clone just for having the repo's name", () => {
    const cwd = join(root, 'gone')
    expect(availableRepos([repo('me/gone')], [cwd], root, () => null)).toEqual([{ ...repo('me/gone'), destination: cwd, onThisPc: false }])
  })
})

describe('prepareRepo', () => {
  const ok = fakeRunner(() => ({ code: 0 }))

  it('clones into a folder that does not exist, with gh and no shell', async () => {
    const run = fakeRunner(() => ({ code: 0 }))
    const target = join(dir, 'app')
    expect(await prepareRepo(run, { repo: 'me/app', cwd: target })).toEqual({ ok: true, action: 'cloned' })
    expect(run.calls).toEqual([{ file: 'gh', args: ['repo', 'clone', 'me/app', target], cwd: undefined }])
  })

  it('clones into an empty folder', async () => {
    const run = fakeRunner(() => ({ code: 0 }))
    expect(await prepareRepo(run, { repo: 'me/app', cwd: dir })).toEqual({ ok: true, action: 'cloned' })
  })

  it('pulls when the folder is already that repo, however it is cased', async () => {
    const run = fakeRunner(() => ({ code: 0 }))
    fakeClone(dir, 'https://github.com/ME/App.git')
    expect(await prepareRepo(run, { repo: 'me/app', cwd: dir })).toEqual({ ok: true, action: 'pulled' })
    expect(run.calls).toEqual([{ file: 'git', args: ['pull', '--ff-only'], cwd: dir }])
  })

  it('a failed pull is a warning, not a failure: local work must not block the chat', async () => {
    const run = fakeRunner(() => ({ code: 1, stderr: 'Not possible to fast-forward' }))
    fakeClone(dir)
    const out = await prepareRepo(run, { repo: 'me/app', cwd: dir })
    expect(out).toMatchObject({ ok: true, action: 'kept' })
    expect(out.ok && out.warning).toContain('Not possible to fast-forward')
  })

  it('refuses a folder holding other files, and never touches it', async () => {
    const run = fakeRunner(() => ({ code: 0 }))
    writeFileSync(join(dir, 'mine.txt'), 'x')
    const out = await prepareRepo(run, { repo: 'me/app', cwd: dir })
    expect(out.ok).toBe(false)
    expect(run.calls).toEqual([])
  })

  it('refuses a clone of a different repo', async () => {
    const run = fakeRunner(() => ({ code: 0 }))
    fakeClone(dir, 'https://github.com/me/other.git')
    const out = await prepareRepo(run, { repo: 'me/app', cwd: dir })
    expect(out).toMatchObject({ ok: false })
    expect(!out.ok && out.error).toContain('me/other')
    expect(run.calls).toEqual([])
  })

  it.each(['--upload-pack=x/y', 'me', 'me/app/extra', 'me/..', '../me', 'me/-x', 'a b/c', ''])('refuses the repo name %j', async name => {
    const out = await prepareRepo(ok, { repo: name, cwd: join(dir, 'x') })
    expect(out.ok).toBe(false)
  })

  it('refuses a relative folder', async () => {
    const run = fakeRunner(() => ({ code: 0 }))
    expect((await prepareRepo(run, { repo: 'me/app', cwd: 'relative/dir' })).ok).toBe(false)
    expect(run.calls).toEqual([])
  })

  it('reports a failed clone without any token that was in the output', async () => {
    const run = fakeRunner(() => ({ code: 1, stderr: 'fatal: https://me:ghp_abc123@github.com/me/app.git not found' }))
    const out = await prepareRepo(run, { repo: 'me/app', cwd: join(dir, 'x') })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error).toContain('not found')
    expect(!out.ok && out.error).not.toContain('ghp_abc123')
  })

  it('reports gh not running', async () => {
    const run: Runner = async () => { throw new Error('spawn gh ENOENT') }
    const out = await prepareRepo(run, { repo: 'me/app', cwd: join(dir, 'x') })
    expect(out.ok).toBe(false)
  })
})

describe('listChannels', () => {
  it('says which repo each project is linked to', () => {
    fakeClone(dir)
    const db = openCatalog(':memory:')
    setProjectCwd(db, upsertProject(db, 'linked'), dir)
    setProjectCwd(db, upsertProject(db, 'plain'), join(dir, '..', 'not-here-at-all'))
    upsertProject(db, 'no-cwd')
    // A project with no chats and nothing customized isn't listed, so name each one.
    for (const name of ['linked', 'plain', 'no-cwd']) setFriendlyName(db, name, name)
    const byName = Object.fromEntries(listChannels(db).map(c => [c.dirName, c.repo]))
    expect(byName).toEqual({ linked: 'me/app', plain: null, 'no-cwd': null })
    closeCatalog(db)
  })
})
