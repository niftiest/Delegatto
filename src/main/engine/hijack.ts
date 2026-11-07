import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { findExternalLock, readLiveSessions, type LockDeps } from './live-sessions'
import { endAll } from '../manage/terminate'
import { HIJACK_NOT_TERMINAL_TEXT, HIJACK_WORKING_TEXT, hijackBlock } from '../../shared/hijack'

export type HijackDeps = LockDeps & {
  end?: typeof endAll
  unlink?: (path: string) => void
}

/** Ends the terminal holding a chat, so Delegatto can use it. Decides from a fresh
 *  read of the lock, never what the screen last showed: Claude may have started
 *  working since. Ends that one process only (see manage/terminate.ts), then
 *  removes the lock it can no longer clean up itself. */
export async function hijackChat(filePath: string, deps: HijackDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const sessions = (deps.readSessions ?? readLiveSessions)(deps.sessionsDir)
  const holder = findExternalLock(filePath, deps, sessions)
  if (holder === null) return { ok: true } // already released
  const block = hijackBlock({ entrypoint: holder.entrypoint ?? null, status: holder.status ?? null })
  if (block === 'not-terminal') return { ok: false, error: HIJACK_NOT_TERMINAL_TEXT }
  if (block === 'working') return { ok: false, error: HIJACK_WORKING_TEXT }

  const { failures } = await (deps.end ?? endAll)([{
    pid: holder.pid,
    sessionId: holder.sessionId,
    cwd: holder.cwd,
    name: holder.name ?? null,
    procStart: holder.procStart ?? null
  }])
  if (failures.length > 0) return { ok: false, error: failures[0]!.error }

  const rm = deps.unlink ?? ((p: string) => { try { unlinkSync(p) } catch { /* already gone */ } })
  rm(join(deps.sessionsDir, `${holder.pid}.json`))
  return { ok: true }
}
