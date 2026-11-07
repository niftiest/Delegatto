import { describe, it, expect } from 'vitest'
import { openCatalog } from '../src/main/catalog/db'
import { listProjects, listSessions } from '../src/main/catalog/repos'
import { startNewChat, type NewChatDeps } from '../src/main/engine/new-chat'
import { cwdToProjectDir } from '../src/main/indexer/discover'
import type { NewProjectOptions } from '../src/shared/engine-ipc-contract'

const HOME = 'C:\\home\\.claude'

function makeDeps(overrides: Partial<NewChatDeps> = {}): NewChatDeps {
  return {
    db: openCatalog(':memory:'),
    makeSessionId: () => 'fixed-uuid-1',
    cwdExists: () => true,
    claudeHomeDir: HOME,
    ...overrides
  }
}

function options(overrides: Partial<NewProjectOptions> = {}): NewProjectOptions {
  return { cwd: 'C:\\Users\\x\\GIT\\Demo', skipPermissions: true, ...overrides }
}

describe('startNewChat', () => {
  it('rejects a cwd that does not exist on disk instead of registering a session', () => {
    const deps = makeDeps({ cwdExists: () => false })
    const outcome = startNewChat(deps, options())

    expect(outcome).toEqual({ ok: false, error: 'Working directory does not exist: C:\\Users\\x\\GIT\\Demo' })
    expect(listProjects(deps.db)).toEqual([])
  })

  it('registers a new project + session row and returns their catalog identity', () => {
    const deps = makeDeps()
    const outcome = startNewChat(deps, options())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.sessionId).toBe('fixed-uuid-1')

    const projects = listProjects(deps.db)
    expect(projects).toHaveLength(1)
    expect(projects[0]!.dirName).toBe(cwdToProjectDir(options().cwd))
    expect(projects[0]!.cwd).toBe(options().cwd)

    const sessions = listSessions(deps.db, projects[0]!.id)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.sessionId).toBe('fixed-uuid-1')
    expect(sessions[0]!.id).toBe(outcome.result.sessionPk)
  })

  it('predicts the file_path the CLI will create -- <home>/projects/<slug>/<uuid>.jsonl', () => {
    const deps = makeDeps()
    startNewChat(deps, options())

    const row = deps.db.prepare('SELECT file_path AS filePath FROM sessions').get() as { filePath: string }
    const slug = cwdToProjectDir(options().cwd)
    expect(row.filePath).toBe(`${HOME}\\projects\\${slug}\\fixed-uuid-1.jsonl`)
  })

  it('a cwd that already has an indexed project reuses that project instead of creating a duplicate', () => {
    const deps = makeDeps()
    // Simulate a project already indexed from real terminal history in this
    // same cwd -- upsertProject dedups by dir_name, which cwdToProjectDir
    // must compute identically for the reuse to happen.
    const dirName = cwdToProjectDir(options().cwd)
    deps.db.prepare('INSERT INTO projects (dir_name, cwd) VALUES (?, ?)').run(dirName, options().cwd)

    const outcome = startNewChat(deps, options())
    expect(outcome.ok).toBe(true)

    const projects = listProjects(deps.db)
    expect(projects).toHaveLength(1) // no duplicate project row
    expect(listSessions(deps.db, projects[0]!.id)).toHaveLength(1)
  })

  it('is idempotent for a repeated call with the same cwd + sessionId (the "duplicate collision" guard)', () => {
    const deps = makeDeps() // makeSessionId is fixed, so both calls mint the SAME uuid
    const first = startNewChat(deps, options())
    const second = startNewChat(deps, options())

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(second.result.sessionPk).toBe(first.result.sessionPk) // same row, not a duplicate

    const projects = listProjects(deps.db)
    expect(projects).toHaveLength(1)
    expect(listSessions(deps.db, projects[0]!.id)).toHaveLength(1)
  })

  it('an optional name is stored as the session title', () => {
    const deps = makeDeps()
    startNewChat(deps, options({ name: 'Refactor the scraper' }))

    const projects = listProjects(deps.db)
    const [session] = listSessions(deps.db, projects[0]!.id)
    expect(session!.title).toBe('Refactor the scraper')
  })

  it('an optional model is stored on the session row', () => {
    const deps = makeDeps()
    startNewChat(deps, options({ model: 'opus' }))

    const projects = listProjects(deps.db)
    const [session] = listSessions(deps.db, projects[0]!.id)
    expect(session!.model).toBe('opus')
  })

  it('trims the cwd before using it for both the slug and the stored project cwd', () => {
    const deps = makeDeps()
    startNewChat(deps, options({ cwd: '  C:\\Users\\x\\GIT\\Demo  ' }))

    const [project] = listProjects(deps.db)
    expect(project!.cwd).toBe('C:\\Users\\x\\GIT\\Demo')
  })
})
