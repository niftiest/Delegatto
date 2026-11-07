import { readdirSync, statSync, readFileSync, existsSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type SubagentMeta = { agentType: string; description: string; toolUseId: string; spawnDepth: number }

export type DiscoveredMain = {
  kind: 'main'; projectDir: string; sessionId: string; filePath: string; size: number; mtimeMs: number
}
export type DiscoveredSubagent = {
  kind: 'subagent'; projectDir: string; sessionId: string; agentId: string
  filePath: string; size: number; mtimeMs: number; meta: SubagentMeta | null
}
export type DiscoveredFile = DiscoveredMain | DiscoveredSubagent

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Computes the project directory name (the `<slug>` in
 *  `~/.claude/projects/<slug>/`) the `claude` CLI derives from an absolute
 *  working directory: every character that is not `[A-Za-z0-9]` is replaced
 *  1:1 with `-` -- no collapsing of consecutive separators, nothing
 *  stripped. Verified against this machine's real `~/.claude/projects`
 *  entries, e.g. a Windows cwd's drive-colon and every path separator each
 *  become their own `-` (`C:\Users\x\GIT\Demo` -> `C--Users-x-GIT-Demo`),
 *  and a literal `-` in the original path survives untouched (replacing `-`
 *  with `-` is the identity).
 *
 *  This is the FORWARD direction only (cwd -> slug), used by Task 8's
 *  new-chat registration to reuse the SAME project row a real terminal
 *  session in this cwd would already have (or will later), matching by the
 *  `dir_name` upsertProject dedups on. It is deliberately never used to go
 *  the other way -- see discover()'s own docs above on why unslugifying is
 *  forbidden. A future CLI version changing this algorithm degrades
 *  gracefully here (worst case: a duplicate project row appears once real
 *  transcripts are indexed under the CLI's actual slug), never a crash and
 *  never a wrong cwd.
 *
 *  NOTE: only verified against ASCII paths (this machine's real
 *  ~/.claude/projects entries, all ASCII). A non-ASCII cwd (accented
 *  letters, CJK, emoji, etc.) may not match the CLI's real slug for that
 *  cwd -- unverified how the CLI's own slugifier treats non-`[A-Za-z0-9]`
 *  Unicode. Same graceful degradation as above applies (a duplicate project
 *  row at worst, never a wrong-cwd spawn), but flagged here for future
 *  verification against a live CLI run with a non-ASCII path. */
export function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function readMeta(path: string): SubagentMeta | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SubagentMeta>
    if (typeof raw.toolUseId !== 'string') return null
    return {
      agentType: typeof raw.agentType === 'string' ? raw.agentType : 'unknown',
      description: typeof raw.description === 'string' ? raw.description : '',
      toolUseId: raw.toolUseId,
      spawnDepth: typeof raw.spawnDepth === 'number' ? raw.spawnDepth : 1
    }
  } catch {
    return null
  }
}

/** discover() walks the user's real, possibly-messy ~/.claude tree on every
 *  launch. A single bad entry -- a permission-denied project directory
 *  (EACCES on readdirSync), a plain file sitting where a `subagents`
 *  directory is expected (ENOTDIR on readdirSync), a file removed mid-scan
 *  (ENOENT on statSync) -- must never abort the whole walk: runIndex() calls
 *  discover() OUTSIDE its per-file try/catch, so an uncaught throw here
 *  would abort indexing of the entire archive before any file is processed.
 *  Every readdirSync/statSync below is therefore wrapped so a bad entry is
 *  skipped (with a console.warn for visibility) rather than fatal. */
function tryReaddir(dir: string, context: string): string[] | null {
  try {
    return readdirSync(dir)
  } catch (err) {
    console.warn(`[discover] skipping unreadable ${context} ${dir}:`, err)
    return null
  }
}

function tryStat(path: string, context: string): Stats | null {
  try {
    return statSync(path)
  } catch (err) {
    console.warn(`[discover] skipping unreadable ${context} ${path}:`, err)
    return null
  }
}

/** Reads the `<agentId>.meta.json` sidecar for a subagent transcript at
 *  `agentFilePath` (`.../subagents/<agentId>.jsonl`). Exposed so a caller that
 *  ran `discover(home, { readMeta: false })` can fill in meta for only the
 *  few subagent files it actually intends to index. */
export function readSubagentMeta(agentFilePath: string): SubagentMeta | null {
  return readMeta(agentFilePath.replace(/\.jsonl$/i, '.meta.json'))
}

/** `readMeta: false` skips reading every subagent's `.meta.json` sidecar
 *  (leaving `meta: null`) -- the periodic external-change sweep walks the
 *  whole tree every few seconds and only needs size/mtime to decide what
 *  changed, so it must not read N small files on every tick. */
export function discover(home: string = claudeHome(), opts: { readMeta?: boolean } = {}): DiscoveredFile[] {
  const withMeta = opts.readMeta ?? true
  const root = join(home, 'projects')
  if (!existsSync(root)) return []
  const out: DiscoveredFile[] = []

  // An unreadable root (e.g. permissions stripped from ~/.claude/projects
  // itself) degrades the same way an absent root does: no crash, no files.
  const projectDirs = tryReaddir(root, 'projects root')
  if (projectDirs === null) return []

  for (const projectDir of projectDirs) {
    const projectPath = join(root, projectDir)
    const projectStat = tryStat(projectPath, 'project entry')
    if (projectStat === null || !projectStat.isDirectory()) continue

    const projectEntries = tryReaddir(projectPath, 'project dir')
    if (projectEntries === null) continue

    for (const entry of projectEntries) {
      const entryPath = join(projectPath, entry)
      const st = tryStat(entryPath, 'session entry')
      if (st === null) continue

      if (st.isFile() && entry.endsWith('.jsonl')) {
        out.push({
          kind: 'main', projectDir, sessionId: entry.slice(0, -6),
          filePath: entryPath, size: st.size, mtimeMs: st.mtimeMs
        })
        continue
      }

      if (!st.isDirectory() || !UUID.test(entry)) continue
      const subDir = join(entryPath, 'subagents')
      if (!existsSync(subDir)) continue

      // ENOTDIR here means a stray file (not a directory) is sitting at the
      // `subagents` path -- skip just this session's subagents, not the walk.
      const subFiles = tryReaddir(subDir, 'subagents dir')
      if (subFiles === null) continue

      // A workflow's agents sit one folder further down, under its run.
      const workflowsDir = join(subDir, 'workflows')
      const runDirs = existsSync(workflowsDir) ? (tryReaddir(workflowsDir, 'workflows dir') ?? []).map(run => join(workflowsDir, run)) : []
      for (const dir of [subDir, ...runDirs]) {
        const files = dir === subDir ? subFiles : tryReaddir(dir, 'workflow run dir')
        if (files === null) continue
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const agentPath = join(dir, file)
          const ast = tryStat(agentPath, 'subagent file')
          if (ast === null) continue
          const agentId = file.slice(0, -6)
          out.push({
            kind: 'subagent', projectDir, sessionId: entry, agentId,
            filePath: agentPath, size: ast.size, mtimeMs: ast.mtimeMs,
            meta: withMeta ? readMeta(join(dir, `${agentId}.meta.json`)) : null
          })
        }
      }
    }
  }
  return out
}
