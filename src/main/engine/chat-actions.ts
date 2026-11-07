import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Catalog } from '../catalog/db'
import { isSamePath } from '../manage/paths'

/** Naming a chat, branching one off, and recalling what was typed. Node-only. */

/** Claude Code's own record of a chat's name. */
export function titleRow(sessionId: string, title: string): string {
  return `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`
}

export function replaceSessionId(line: string, from: string, to: string): string {
  return line.split(`"sessionId":"${from}"`).join(`"sessionId":"${to}"`).split(`"session_id":"${from}"`).join(`"session_id":"${to}"`)
}

/** Copies a chat under a new id, with what it keeps beside it, so it can go its own way. */
export async function forkTranscript(file: string, sessionId: string, newId: string, title: string): Promise<string> {
  const target = join(dirname(file), `${newId}.jsonl`)
  const text = await fsp.readFile(file, 'utf8')
  // A line the process is still writing isn't finished, so it stays behind.
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)
  await fsp.writeFile(target, `${replaceSessionId(whole, sessionId, newId)}${titleRow(newId, title)}`, 'utf8')
  await fsp.cp(join(dirname(file), sessionId), join(dirname(file), newId), { recursive: true }).catch(() => { /* nothing beside it */ })
  return target
}

const HISTORY_LIMIT = 500

/** Text Claude Code stores as the user's that nobody typed. */
const NOT_TYPED = ['<', '[Request interrupted by user', 'Base directory for this skill:', 'This session is being continued from a previous conversation', 'Caveat:']

/** A message of the user's the chat can go back to. */
export type RewindPointRow = { uuid: string; text: string; ts: string | null }

const REWIND_POINTS = 100

/** The messages typed in this chat, newest first. */
export function rewindPoints(db: Catalog, sessionPk: number): RewindPointRow[] {
  const rows = db.prepare(`
    SELECT uuid, text, ts FROM messages
    WHERE session_pk = ? AND role = 'user' AND is_sidechain = 0 AND rewound = 0 AND text IS NOT NULL AND text <> ''
    ORDER BY seq DESC LIMIT 2000
  `).all(sessionPk) as RewindPointRow[]
  return rows.filter(r => !NOT_TYPED.some(start => r.text.trim().startsWith(start)) && !r.text.startsWith('[Image:')).slice(0, REWIND_POINTS)
}

/** Records that the chat went back to before this message: it and all that followed. */
export function markRewoundFrom(db: Catalog, sessionPk: number, uuid: string): void {
  const target = db.prepare('SELECT seq FROM messages WHERE session_pk = ? AND uuid = ?').get(sessionPk, uuid) as { seq: number } | undefined
  if (target !== undefined) db.prepare('UPDATE messages SET rewound = 1 WHERE session_pk = ? AND seq >= ? AND is_sidechain = 0').run(sessionPk, target.seq)
}

/** Something typed, and when (ms), from Claude Code's own history file. */
export type HistoryEntry = { text: string; at: number }

/** Keeps text in Claude Code's own history file, where the terminal's Up finds it too. One
 *  line in one append, so it can't land in the middle of a line the terminal is writing. */
export async function appendHistory(file: string, entry: { text: string; project: string; sessionId: string; at: number }): Promise<void> {
  const line = JSON.stringify({ display: entry.text, pastedContents: {}, timestamp: entry.at, project: entry.project, sessionId: entry.sessionId })
  await fsp.appendFile(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** A pasted block's placeholder, as the terminal stores it, with its text put back. */
function withPastes(display: string, pasted: unknown): string {
  if (typeof pasted !== 'object' || pasted === null) return display
  return display.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (whole, id: string) => {
    const content = (pasted as Record<string, { content?: unknown } | undefined>)[id]?.content
    return typeof content === 'string' ? content : whole
  })
}

/** What Claude Code's history file holds for this project. A bad line is skipped: the file
 *  is the terminal's, and nothing in it should stop the box working. */
export async function readHistory(file: string, project: string): Promise<HistoryEntry[]> {
  let text: string
  try { text = await fsp.readFile(file, 'utf8') } catch { return [] }
  const out: HistoryEntry[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let row: { display?: unknown; pastedContents?: unknown; timestamp?: unknown; project?: unknown }
    try { row = JSON.parse(line) } catch { continue }
    if (typeof row.display !== 'string' || typeof row.project !== 'string' || !isSamePath(row.project, project)) continue
    out.push({ text: withPastes(row.display, row.pastedContents), at: typeof row.timestamp === 'number' ? row.timestamp : 0 })
  }
  return out
}

/** What was typed in this chat's project, newest first, each once: Up and Ctrl+R in the box.
 *  `fromFile` adds what only Claude Code's history file has, like text cleared with Esc Esc. */
export function promptHistory(db: Catalog, sessionPk: number, fromFile: HistoryEntry[] = []): string[] {
  const rows = db.prepare(`
    SELECT m.text, m.ts FROM messages m
    JOIN sessions s ON s.id = m.session_pk
    WHERE s.project_id = (SELECT project_id FROM sessions WHERE id = ?)
      AND s.kind = 'main' AND m.role = 'user' AND m.is_sidechain = 0 AND m.text IS NOT NULL AND m.text <> ''
    ORDER BY m.ts DESC, m.seq DESC
    LIMIT 5000
  `).all(sessionPk) as Array<{ text: string; ts: string | null }>
  const dated = [
    ...rows.map(r => ({ text: r.text, at: r.ts === null ? 0 : Date.parse(r.ts) || 0 })),
    ...fromFile
  ].sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  const out: string[] = []
  for (const { text } of dated) {
    const t = text.trim()
    if (t.length === 0 || seen.has(t) || NOT_TYPED.some(start => t.startsWith(start))) continue
    seen.add(t)
    out.push(t)
    if (out.length >= HISTORY_LIMIT) break
  }
  return out
}
