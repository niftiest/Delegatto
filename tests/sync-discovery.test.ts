import { describe, it, expect } from 'vitest'
import { privateReposWithFile, type Runner } from '../src/main/engine/github'
import { projectSyncState, syncOffer, type RemoteProject, type SyncProjectRow, type SyncStatus } from '../src/shared/sync-types'
import { checkoutRows, filterCheckoutRows } from '../src/renderer/lib'
import type { GithubRepoOption } from '../src/shared/github-types'

function page(nodes: Array<[string, string | null]>, next: string | null): string {
  return JSON.stringify({ data: { viewer: { repositories: {
    pageInfo: { hasNextPage: next !== null, endCursor: next },
    nodes: nodes.map(([nameWithOwner, text]) => ({ nameWithOwner, object: text === null ? null : { text } }))
  } } } })
}

describe('looking for a file across private repos', () => {
  it('goes through every page and keeps only repos with the file', async () => {
    const asked: string[][] = []
    const run: Runner = async (_f, args) => {
      asked.push(args)
      return { code: 0, stderr: '', stdout: args.includes('after=two') ? page([['me/c', 'three']], null) : page([['me/a', 'one'], ['me/b', null]], 'two') }
    }
    expect(await privateReposWithFile(run, 'x.json')).toEqual([{ repo: 'me/a', text: 'one' }, { repo: 'me/c', text: 'three' }])
    expect(asked).toHaveLength(2)
    expect(asked[0]!.join(' ')).toContain('privacy: PRIVATE')
    expect(asked[0]!.join(' ')).toContain('HEAD:x.json')
  })
  it('reports a failure, without any token in it', async () => {
    const run: Runner = async () => ({ code: 1, stdout: '', stderr: 'bad gho_abc123' })
    await expect(privateReposWithFile(run, 'x.json')).rejects.toThrow('bad [token]')
  })
})

const remote = (o: Partial<RemoteProject>): RemoteProject => ({
  projectId: 'p1', name: 'app', github: 'me/app', branch: 'main', chats: 3, updatedBy: 'DESKTOP', updatedAt: 1, unpushed: 0, uncommitted: 0, suggestedFolder: 'D:\\GIT\\app', ...o
})
const status = (o: Partial<SyncStatus>): SyncStatus => ({
  github: { state: 'ready', account: 'me' }, configured: false, repo: null, discoveredRepos: [], leftSync: false, remoteProjects: [], ...o
} as SyncStatus)
const none = new Set<string>()

describe('what the chat list offers', () => {
  it('a repo found while this PC is not linked', () => {
    expect(syncOffer(status({ discoveredRepos: ['me/delegatto-sync'] }), none)?.text).toBe('Found your sync repo. Link this PC to see its projects.')
  })
  it('nothing without one, or when signed out', () => {
    expect(syncOffer(status({}), none)).toBeNull()
    expect(syncOffer(status({ github: { state: 'signed_out', account: null }, discoveredRepos: ['me/s'] }), none)).toBeNull()
  })
  it('nothing after this PC chose to disconnect', () => {
    expect(syncOffer(status({ discoveredRepos: ['me/s'], leftSync: true }), none)).toBeNull()
  })
  it('counts projects, naming the PC when there is one', () => {
    const on = { configured: true, repo: 'me/s' }
    expect(syncOffer(status({ ...on, remoteProjects: [remote({})] }), none)?.text).toBe('1 project available from DESKTOP')
    expect(syncOffer(status({ ...on, remoteProjects: [remote({}), remote({ projectId: 'p2', updatedBy: 'LAPTOP' })] }), none)?.text).toBe('2 projects available from your other PCs')
    expect(syncOffer(status({ ...on }), none)).toBeNull()
  })
  it('stays dismissed until something new appears', () => {
    const on = { configured: true, repo: 'me/s' }
    const dismissed = new Set(['p1'])
    expect(syncOffer(status({ ...on, remoteProjects: [remote({})] }), dismissed)).toBeNull()
    expect(syncOffer(status({ ...on, remoteProjects: [remote({}), remote({ projectId: 'p2' })] }), dismissed)?.text).toBe('2 projects available from DESKTOP')
  })
})

const repo = (fullName: string, o: Partial<GithubRepoOption> = {}): GithubRepoOption => ({
  fullName, description: null, isPrivate: false, isArchived: false, pushedAt: null, destination: `D:\\GIT\\${fullName.split('/')[1]}`, onThisPc: false, ...o
})

describe('the list in New Chat', () => {
  it('lists everything, with synced projects first', () => {
    const rows = checkoutRows([repo('me/a'), repo('me/app'), repo('me/b')], [remote({})], [])
    expect(rows.map(r => r.label)).toEqual(['me/app', 'me/a', 'me/b'])
    expect(rows[0]!.sync).toEqual({ projectId: 'p1', from: 'DESKTOP', chats: 3 })
    expect(rows[1]!.sync).toBeNull()
  })
  it('matches a synced repo whatever the case, without listing it twice', () => {
    const rows = checkoutRows([repo('Me/App')], [remote({})], [])
    expect(rows).toHaveLength(1)
  })
  it('shows a synced project with no GitHub repo by its name', () => {
    const rows = checkoutRows([], [remote({ github: null, name: 'notes', suggestedFolder: 'D:\\GIT\\notes' })], [])
    expect(rows[0]).toMatchObject({ label: 'notes', repo: null, folder: 'D:\\GIT\\notes' })
  })
  it('a synced repo already cloned here uses that clone', () => {
    const rows = checkoutRows([repo('me/app', { onThisPc: true, destination: 'E:\\mine\\app' })], [remote({})], [])
    expect(rows[0]).toMatchObject({ onThisPc: true, folder: 'E:\\mine\\app' })
  })
  it('marks repos this PC already syncs', () => {
    const rows = checkoutRows([repo('me/a'), repo('me/b')], [], [], ['ME/B'])
    expect(rows.map(r => [r.label, r.syncedHere])).toEqual([['me/a', false], ['me/b', true]])
  })
  it('leaves out the sync repo itself', () => {
    expect(checkoutRows([repo('me/delegatto-sync'), repo('me/a')], [], ['ME/delegatto-sync']).map(r => r.label)).toEqual(['me/a'])
  })
  it('filters by every word, in the name or description', () => {
    const rows = checkoutRows([repo('me/game-engine'), repo('me/notes', { description: 'Game ideas' }), repo('me/site')], [], [])
    expect(filterCheckoutRows(rows, 'GAME').map(r => r.label)).toEqual(['me/game-engine', 'me/notes'])
    expect(filterCheckoutRows(rows, 'game ideas').map(r => r.label)).toEqual(['me/notes'])
    expect(filterCheckoutRows(rows, '  ')).toHaveLength(3)
    expect(filterCheckoutRows(rows, 'zzz')).toEqual([])
  })
})

describe("what a project's menu offers", () => {
  const row = (workingDir: string, projectId: string | null): SyncProjectRow => ({ workingDir, name: 'app', projectId } as SyncProjectRow)
  const linked = { configured: true, repo: 'me/s', projects: [row('D:\\GIT\\app', null), row('D:\\GIT\\synced', 'p1')] }
  it('starting, for a project that is not syncing, however its path is written', () => {
    expect(projectSyncState(status(linked), { cwd: 'd:/git/APP/' })).toEqual({ kind: 'off', workingDir: 'D:\\GIT\\app', name: 'app' })
  })
  it('stopping, for one that is', () => {
    expect(projectSyncState(status(linked), { cwd: 'D:\\GIT\\synced' })).toEqual({ kind: 'on', projectId: 'p1' })
  })
  it('setup first, on a PC that is not linked', () => {
    expect(projectSyncState(status({}), { cwd: 'D:\\GIT\\app' })).toEqual({ kind: 'setup' })
  })
  it('nothing without GitHub, a folder, or a project sync can list, or when archived', () => {
    expect(projectSyncState(status({ ...linked, github: { state: 'missing', account: null } }), { cwd: 'D:\\GIT\\app' })).toBeNull()
    expect(projectSyncState(status({ ...linked, github: { state: 'signed_out', account: null } }), { cwd: 'D:\\GIT\\app' })).toBeNull()
    expect(projectSyncState(status(linked), { cwd: null })).toBeNull()
    expect(projectSyncState(status(linked), { cwd: 'D:\\GIT\\worktree' })).toBeNull()
    expect(projectSyncState(status(linked), { cwd: 'D:\\GIT\\app', archived: true })).toBeNull()
  })
})
