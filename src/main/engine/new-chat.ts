import { join } from 'node:path'
import type { Catalog } from '../catalog/db'
import { upsertProject, setProjectCwd, upsertSession } from '../catalog/repos'
import { cwdToProjectDir } from '../indexer/discover'
import type { NewProjectOptions } from '../../shared/engine-ipc-contract'

/** Node-only (no electron): the electron-boundary bits -- the native
 *  directory picker, node:crypto's randomUUID, and the real fs
 *  existence check -- live in engine-ipc.ts, which injects them here via
 *  NewChatDeps. Enforced by tests/architecture.test.ts the same as the rest
 *  of src/main/engine. */

export type NewChatResult = { sessionPk: number; sessionId: string }
export type NewChatOutcome = { ok: true; result: NewChatResult } | { ok: false; error: string }

export type NewChatDeps = {
  db: Catalog
  /** Generates the fresh durable session_id (a uuid) this new chat's file
   *  will be keyed by. Production wires node:crypto's randomUUID; tests
   *  pass a deterministic fake. */
  makeSessionId: () => string
  /** True when `cwd` exists on disk as a directory. Injected so this
   *  module's decision logic is testable without touching a real
   *  filesystem; production wires a node:fs existsSync+statSync check. */
  cwdExists: (cwd: string) => boolean
  /** Root of ~/.claude (production wires discover.ts's claudeHome();
   *  explicit here rather than defaulted so this module has no implicit
   *  env/homedir dependency of its own). */
  claudeHomeDir: string
}

/** Registers a brand-new chat in the catalog: a project row for
 *  `options.cwd` (reusing an existing one if this cwd already has indexed
 *  history -- upsertProject's ON CONFLICT(dir_name) dedups by the SAME slug
 *  cwdToProjectDir computes here, so a new chat in a cwd a terminal has
 *  already used lands in that project, not a duplicate) and a session row
 *  for a freshly generated uuid, addressable by the returned sessionPk.
 *
 *  Does NOT spawn a `claude` process. SessionPool spawns lazily on the first
 *  Composer send (the existing coordinator.send() path, Tasks 6/7) -- at
 *  that point EngineCoordinator's isNew check (repos.ts's
 *  getEngineSessionInfo, via fs.existsSync on the filePath predicted below)
 *  decides --session-id vs --resume. Since the file doesn't exist yet
 *  immediately after this call, that first spawn is guaranteed to see
 *  isNew=true and use --session-id, exactly matching the freshly-registered
 *  identity.
 *
 *  Guard: a cwd that doesn't exist on disk surfaces `{ok:false}` instead of
 *  silently registering a session no CLI process could ever be spawned
 *  against (the CLI creates the `projects/<slug>/` directory itself on
 *  first run, but it cannot create a working directory that was never
 *  real). Idempotency: calling this twice with the SAME cwd+sessionId (the
 *  sessionId collision the standing instruction calls "astronomically
 *  unlikely" with randomUUID, but worth naming) produces the SAME
 *  predicted filePath, so upsertSession's `ON CONFLICT(file_path) DO
 *  UPDATE` merges into the one existing row rather than erroring or
 *  duplicating it. */
export function startNewChat(deps: NewChatDeps, options: NewProjectOptions): NewChatOutcome {
  const cwd = options.cwd.trim()
  if (!deps.cwdExists(cwd)) {
    return { ok: false, error: `Working directory does not exist: ${cwd}` }
  }

  const sessionId = deps.makeSessionId()
  const dirName = cwdToProjectDir(cwd)
  const projectId = upsertProject(deps.db, dirName)
  setProjectCwd(deps.db, projectId, cwd)

  const filePath = join(deps.claudeHomeDir, 'projects', dirName, `${sessionId}.jsonl`)
  const sessionPk = upsertSession(deps.db, {
    projectId,
    sessionId,
    kind: 'main',
    filePath,
    fileSize: 0,
    fileMtimeMs: 0,
    ...(options.name !== undefined ? { title: options.name } : {}),
    ...(options.model !== undefined ? { model: options.model } : {})
  })

  return { ok: true, result: { sessionPk, sessionId } }
}
