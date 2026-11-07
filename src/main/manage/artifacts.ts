import { createReadStream, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ClaudePaths } from './paths'
import { encodePath, isFullyQualified, isSamePath, isSameOrUnder } from './paths'
import type { Artifact, ArtifactKind, ProjectInfo } from './types'
import { dirSize, fileSize, isDir, isFile, listDir } from './fs-util'

/** Everything Claude keeps for one project (port of ClaudeMemoryTool's
 *  ArtifactCollector), plus `collectChatArtifacts` for a single chat. */

export async function collectProjectArtifacts(paths: ClaudePaths, p: ProjectInfo): Promise<Artifact[]> {
  const r: Artifact[] = []

  if (p.projectDir !== null && await isDir(p.projectDir)) {
    r.push(a('ProjectFolder', p.projectDir, 'Project folder (sessions, memory)', await dirSize(p.projectDir)))
    const mem = join(p.projectDir, 'memory')
    if (await isDir(mem)) {
      r.push(a('Memory', mem, 'Memory', await dirSize(mem)))
      // Display-only children so the detail view can open each memory file.
      const files = (await listDir(mem)).filter(f => f.toLowerCase().endsWith('.md'))
        .sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }))
      for (const f of files) {
        const fp = join(mem, f)
        r.push({ ...a('Memory', fp, 'Memory file ' + f, fileSize(fp)), parent: mem })
      }
    }
  }

  collectClaudeJson(paths, p.workingDir, r)
  const history = await countHistoryLines(paths, line => isSamePath(String(line.project ?? ''), p.workingDir))
  if (history > 0) r.push(a('HistoryLines', paths.historyFile, `${history} lines`, 0))

  const temp = join(paths.tempClaudeDir, encodePath(p.workingDir))
  if (await isDir(temp)) r.push(a('TempScratch', temp, 'Temp scratch folder', await dirSize(temp)))

  for (const id of p.sessionIds) await collectSessionDirs(paths, id, r)
  await collectJobs(paths, s => p.sessionIds.some(id => id.toLowerCase() === s.toLowerCase()),
    c => isSamePath(c, p.workingDir), r)

  if (p.workingDirKnown && isFullyQualified(p.workingDir)) {
    const dotClaude = join(p.workingDir, '.claude')
    if (await isDir(dotClaude) && !isClaudeOwnData(paths, dotClaude)) {
      r.push(a('InDirClaudeFolder', dotClaude, await dotClaudeDescription(dotClaude), await dirSize(dotClaude), true))
    }
    const md = join(p.workingDir, 'CLAUDE.md')
    if (await isFile(md) && !isClaudeOwnData(paths, md)) {
      r.push(a('InDirClaudeMd', md, "Project's CLAUDE.md", fileSize(md), true))
    }
  }
  return r
}

/** One chat's own data: its transcript, its `<sessionId>\` subfolder
 *  (subagents, tool results), the per-session folders, todos, jobs tied to it,
 *  and its history.jsonl lines (matched by sessionId). Project-level data
 *  (memory, .claude.json entry, temp scratch) is not included. */
export async function collectChatArtifacts(paths: ClaudePaths, projectDir: string, sessionId: string): Promise<Artifact[]> {
  const r: Artifact[] = []
  const transcript = join(projectDir, `${sessionId}.jsonl`)
  if (await isFile(transcript)) r.push(a('SessionTranscript', transcript, 'Chat transcript', fileSize(transcript)))
  const sub = join(projectDir, sessionId)
  if (await isDir(sub)) r.push(a('SessionFolder', sub, 'Subagents and tool results', await dirSize(sub)))
  await collectSessionDirs(paths, sessionId, r)
  await collectJobs(paths, s => s.toLowerCase() === sessionId.toLowerCase(), () => false, r)
  const history = await countHistoryLines(paths, line => String(line.sessionId ?? '').toLowerCase() === sessionId.toLowerCase())
  if (history > 0) r.push(a('HistoryLines', paths.historyFile, `${history} lines`, 0))
  return r
}

function a(kind: ArtifactKind, path: string, description: string, sizeBytes: number, optional = false): Artifact {
  return { kind, path, description, sizeBytes, optional }
}

/** Claude Code's own data folders (or the global ~/.claude/CLAUDE.md): a project
 *  whose working dir is the home folder must not offer them as "its own". */
function isClaudeOwnData(paths: ClaudePaths, path: string): boolean {
  return isSameOrUnder(paths.claudeDir, path) || isSameOrUnder(paths.tempClaudeDir, path) ||
    isSamePath(path, join(paths.claudeDir, 'CLAUDE.md'))
}

async function dotClaudeDescription(dotClaude: string): Promise<string> {
  const plain = "Project's own .claude folder"
  const worktrees = join(dotClaude, 'worktrees')
  if (!await isDir(worktrees)) return plain
  const dirs: string[] = []
  for (const e of await listDir(worktrees)) if (await isDir(join(worktrees, e))) dirs.push(e)
  if (dirs.length === 0) return plain
  const mb = (await dirSize(worktrees)) / (1024 * 1024)
  return `${plain} — contains ${dirs.length} git worktree${dirs.length === 1 ? '' : 's'} (${mb.toFixed(1).replace(/\.0$/, '')} MB) — deleting breaks them`
}

async function collectSessionDirs(paths: ClaudePaths, id: string, r: Artifact[]): Promise<void> {
  const subs: Array<[ArtifactKind, string]> = [['FileHistory', 'file-history'], ['SessionEnv', 'session-env'], ['Tasks', 'tasks'], ['Uploads', 'uploads']]
  for (const [kind, sub] of subs) {
    const d = join(paths.claudeDir, sub, id)
    if (await isDir(d)) r.push(a(kind, d, `${sub}\\${id}`, await dirSize(d)))
  }
  const todos = join(paths.claudeDir, 'todos')
  for (const f of await listDir(todos)) {
    if (f.toLowerCase().startsWith(id.toLowerCase()) && f.toLowerCase().endsWith('.json')) {
      const fp = join(todos, f)
      r.push(a('Todos', fp, 'Todos ' + f, fileSize(fp)))
    }
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

function collectClaudeJson(paths: ClaudePaths, workingDir: string, r: Artifact[]): void {
  const root = readJsonObject(paths.claudeJson)
  if (root === null) return
  const projects = root.projects
  if (typeof projects === 'object' && projects !== null && !Array.isArray(projects)) {
    for (const key of Object.keys(projects)) {
      if (isSamePath(key, workingDir)) r.push(a('ClaudeJsonEntry', paths.claudeJson, `projects["${key}"]`, 0))
    }
  }
  const gh = root.githubRepoPaths
  if (typeof gh === 'object' && gh !== null && !Array.isArray(gh)) {
    for (const [repo, list] of Object.entries(gh)) {
      if (Array.isArray(list) && list.some(e => typeof e === 'string' && isSamePath(e, workingDir))) {
        r.push(a('GithubRepoPath', paths.claudeJson, `githubRepoPaths["${repo}"]`, 0))
      }
    }
  }
}

/** Streams history.jsonl and counts the JSON-object lines `match` accepts. */
export async function countHistoryLines(paths: ClaudePaths, match: (line: Record<string, unknown>) => boolean): Promise<number> {
  if (!await isFile(paths.historyFile)) return 0
  let count = 0
  const rl = createInterface({ input: createReadStream(paths.historyFile), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.length === 0) continue
      try {
        const v = JSON.parse(line) as unknown
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && match(v as Record<string, unknown>)) count++
      } catch { /* malformed line */ }
    }
  } catch { /* unreadable */ }
  return count
}

async function collectJobs(
  paths: ClaudePaths,
  matchSession: (sessionId: string) => boolean,
  matchCwd: (cwd: string) => boolean,
  r: Artifact[]
): Promise<void> {
  for (const name of await listDir(paths.jobsDir)) {
    const dir = join(paths.jobsDir, name)
    if (!await isDir(dir)) continue
    const state = readJsonObject(join(dir, 'state.json'))
    if (state === null) continue
    const match = (typeof state.sessionId === 'string' && matchSession(state.sessionId)) ||
      (typeof state.cwd === 'string' && matchCwd(state.cwd))
    if (match) r.push(a('Job', dir, 'Job ' + basename(dir), await dirSize(dir)))
  }
}
