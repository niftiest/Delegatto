import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FolderContents } from '../../shared/shell-run-types'

/** Whether a new chat may start in a folder without asking. Delegatto's chats run
 *  `claude -p`, which skips Claude Code's own "do you trust this folder?" prompt,
 *  so a folder's settings, hooks and MCP servers would otherwise apply unannounced.
 *
 *  The rule is Claude Code's own (2.1.318): inside a git repository, trust is kept
 *  for the repository root, and only the folders from the chat's folder up to that
 *  root count, so a trusted D:/GIT doesn't cover a new repository inside it. Outside
 *  a repository, any folder above counts. The home folder is never trusted for good.
 *
 *  Delegatto keeps its own answers in its settings. It never edits ~/.claude.json,
 *  which Claude Code rewrites constantly; it tells Claude Code at startup instead
 *  (initialize's workspaceTrust), and Claude Code records the answer itself. */

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function sameFolder(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

/** The git repository a folder is in: the nearest folder holding `.git`. */
export function repoRoot(cwd: string): string | null {
  let current = cwd
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Where trust for this folder is kept: its repository's root, or the folder itself. */
export function trustKey(cwd: string): string {
  return repoRoot(cwd) ?? cwd
}

/** The folders whose trust covers `cwd`, normalized: up to the repository root when
 *  there is one, otherwise every folder above. */
function coveringFolders(cwd: string): string[] {
  const root = repoRoot(cwd)
  const stop = root === null ? null : normalize(root)
  const out: string[] = []
  let current = cwd
  for (;;) {
    out.push(normalize(current))
    if (normalize(current) === stop) return out
    const parent = dirname(current)
    if (parent === current) return out
    current = parent
  }
}

/** Trusted in Claude Code's own records. */
export function claudeTrusts(cwd: string, claudeJson: string | null): boolean {
  if (claudeJson === null) return false
  let root: unknown
  try { root = JSON.parse(claudeJson) } catch { return false }
  const projects = (root as { projects?: unknown } | null)?.projects
  if (typeof projects !== 'object' || projects === null) return false
  const trusted = new Set(Object.entries(projects)
    .filter(([, v]) => (v as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted === true)
    .map(([k]) => normalize(k)))
  return coveringFolders(cwd).some(p => trusted.has(p))
}

/** Delegatto's own list: a folder the user said yes to that covers this one, or null. */
export function listTrusts(cwd: string, trustedFolders: string[]): string | null {
  const byKey = new Map(trustedFolders.map(f => [normalize(f), f]))
  for (const p of coveringFolders(cwd)) { const hit = byKey.get(p); if (hit !== undefined) return hit }
  return null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** What in this folder would take effect, for the prompt to name. */
export function folderContents(cwd: string): FolderContents {
  const claudeDir = join(cwd, '.claude')
  const settingsFiles = [join(claudeDir, 'settings.json'), join(claudeDir, 'settings.local.json')]
  const hooks = new Set<string>()
  for (const file of settingsFiles) {
    const h = readJson(file)?.hooks
    if (typeof h === 'object' && h !== null) for (const event of Object.keys(h)) hooks.add(event)
  }
  const servers = readJson(join(cwd, '.mcp.json'))?.mcpServers
  return {
    settings: settingsFiles.some(existsSync),
    hooks: [...hooks].sort(),
    mcpServers: typeof servers === 'object' && servers !== null ? Object.keys(servers).sort() : [],
    instructions: existsSync(join(cwd, 'CLAUDE.md')),
    extensions: ['skills', 'commands', 'agents'].some(d => existsSync(join(claudeDir, d)))
  }
}
