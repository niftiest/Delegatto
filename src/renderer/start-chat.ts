import { api } from './api'
import type { ChannelRow, SessionSummary } from '../shared/types'
import type { AppSettings } from '../shared/shell-types'
import { resolveNewProjectOptions } from './lib'

export type StartChatResult =
  | { kind: 'created'; cwd: string; sessionId: string }
  /** It needs the New chat dialog: a folder not trusted yet, a chat that skips permissions
   *  while "confirm before bypass" is on, or a project with no folder. */
  | { kind: 'dialog'; cwd: string | null }
  | { kind: 'error'; message: string }

/** A new chat in an existing project, made the way the New chat dialog makes one for an
 *  existing folder, with the same settings defaults. */
export async function startChatIn(project: ChannelRow, settings: AppSettings | null): Promise<StartChatResult> {
  const cwd = project.cwd
  if (cwd === null || cwd.length === 0 || project.archived === true) return { kind: 'dialog', cwd: null }
  try {
    const skipPermissions = settings?.defaultSkipPermissions ?? true
    const trust = await api.folderTrust(cwd).catch(() => null)
    if (trust === null || !trust.trusted || (skipPermissions && (settings?.confirmBeforeBypass ?? false))) return { kind: 'dialog', cwd }
    const resolved = resolveNewProjectOptions({}, {
      cwd, skipPermissions,
      model: settings?.defaultModel ?? undefined,
      effort: settings?.defaultEffort ?? undefined
    })
    if (!resolved.ok) return { kind: 'error', message: resolved.error }
    const outcome = await api.newChat(resolved.options)
    if (!outcome.ok) return { kind: 'error', message: outcome.error }
    return { kind: 'created', cwd, sessionId: outcome.sessionId }
  } catch (err) {
    return { kind: 'error', message: `Couldn't start a new chat: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Finds a chat main has just registered: its project, that project's chats and the chat,
 *  from a fresh read of the catalog. Null while the catalog doesn't have it yet. */
export async function findCreated(cwd: string, sessionId: string): Promise<{ channels: ChannelRow[]; project: ChannelRow | null; chats: SessionSummary[]; created: SessionSummary | null }> {
  const channels = await api.listChannels()
  const project = channels.find(p => p.cwd === cwd) ?? null
  if (project === null) return { channels, project, chats: [], created: null }
  const chats = await api.listSessions(project.id)
  return { channels, project, chats, created: chats.find(s => s.sessionId === sessionId) ?? null }
}
