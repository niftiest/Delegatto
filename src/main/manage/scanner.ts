import { createReadStream, promises as fsp, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ClaudePaths } from './paths'
import { encodePath, isFullyQualified, isSamePath, isSameOrUnder, normalizePath } from './paths'
import type { ProjectInfo } from './types'
import { dirSize, isDir, listDir } from './fs-util'

/** Every project Claude Code has data for (port of ClaudeMemoryTool's
 *  ProjectScanner): one per ~/.claude/projects/<encoded> folder, plus
 *  .claude.json project keys with no folder. The real working dir comes from
 *  the transcripts' `cwd` (the encoded name is lossy), else a matching
 *  .claude.json key, else the encoded name marked unknown. */
export async function scanProjects(paths: ClaudePaths): Promise<ProjectInfo[]> {
  const jsonKeys = readClaudeJsonProjectKeys(paths)
  const usedKeys = new Set<string>()
  const result: ProjectInfo[] = []

  for (const enc of await listDir(paths.projectsDir)) {
    const info = await scanFolder(paths, enc, jsonKeys)
    if (info === null) continue
    if (info.workingDirKnown) {
      for (const k of jsonKeys) if (isSamePath(k, info.workingDir) || sameEncoded(k, enc)) usedKeys.add(k)
    }
    result.push(info)
  }

  const seen: string[] = []
  for (const k of jsonKeys) {
    if (usedKeys.has(k) || seen.some(s => isSamePath(s, k))) continue
    seen.push(k)
    const wd = normalizePath(k)
    result.push({
      workingDir: wd, workingDirKnown: true, encodedName: encodePath(wd), projectDir: null,
      sessionIds: [], lastUsed: null, sizeBytes: 0, exists: await isDir(wd), worktreeOf: null
    })
  }

  return result.sort((x, y) => x.workingDir.localeCompare(y.workingDir, undefined, { sensitivity: 'base' }))
}

/** One project by its ~/.claude/projects/<encoded> folder name (same rules as
 *  scanProjects), or null when that folder doesn't exist. Lets a single-project
 *  action (delete one channel) avoid walking every project. */
export async function scanProject(paths: ClaudePaths, encodedName: string): Promise<ProjectInfo | null> {
  return scanFolder(paths, encodedName, readClaudeJsonProjectKeys(paths))
}

async function scanFolder(paths: ClaudePaths, enc: string, jsonKeys: string[]): Promise<ProjectInfo | null> {
  const dir = join(paths.projectsDir, enc)
  if (!await isDir(dir)) return null
  const files = (await listDir(dir)).filter(f => f.toLowerCase().endsWith('.jsonl'))
    .sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }))
    .map(f => join(dir, f))

  let wd: string | null = null
  for (const f of files) {
    wd = await firstCwd(f, c => sameEncoded(c, enc))
    if (wd !== null) break
  }
  if (wd === null) wd = jsonKeys.find(k => sameEncoded(k, enc)) ?? null
  const known = wd !== null
  const workingDir = wd ?? enc

  let worktreeOf: string | null = null
  if (known && isWorktree(workingDir)) {
    for (const f of files) {
      worktreeOf = await firstCwd(f, c => !isSameOrUnder(c, workingDir))
      if (worktreeOf !== null) break
    }
  }

  let lastUsed: number | null = null
  for (const f of files) {
    try {
      const m = (await fsp.stat(f)).mtimeMs
      if (lastUsed === null || m > lastUsed) lastUsed = m
    } catch { /* vanished */ }
  }
  return {
    workingDir, workingDirKnown: known, encodedName: enc, projectDir: dir,
    sessionIds: files.map(f => basename(f).replace(/\.jsonl$/i, '')),
    lastUsed, sizeBytes: await dirSize(dir),
    exists: known && await isDir(workingDir), worktreeOf
  }
}

function sameEncoded(workingDir: string, enc: string): boolean {
  return encodePath(workingDir).toLowerCase() === enc.toLowerCase()
}

function isWorktree(wd: string): boolean {
  const l = wd.toLowerCase()
  return l.includes('\\.claude\\worktrees\\') || l.includes('claude-worktrees')
}

/** First `cwd` in a transcript that `accept` takes; malformed lines skipped. */
async function firstCwd(file: string, accept: (cwd: string) => boolean): Promise<string | null> {
  const stream = createReadStream(file)
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.length === 0 || !line.includes('"cwd"')) continue
      try {
        const v = JSON.parse(line) as { cwd?: unknown }
        if (typeof v.cwd === 'string' && v.cwd.length > 0 && accept(v.cwd)) return v.cwd
      } catch { /* malformed */ }
    }
  } catch { /* unreadable */ } finally {
    // Returning early leaves the file handle open; on Windows that blocks a
    // later rename/replace of the transcript (EPERM). Close it for real.
    rl.close()
    if (!stream.destroyed) {
      await new Promise<void>(res => { stream.once('close', () => res()); stream.destroy() })
    }
  }
  return null
}

/** `.claude.json` project keys that are usable working dirs (fully qualified). */
export function readClaudeJsonProjectKeys(paths: ClaudePaths): string[] {
  try {
    const root = JSON.parse(readFileSync(paths.claudeJson, 'utf8')) as { projects?: unknown }
    const projects = root.projects
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return []
    return Object.keys(projects).filter(k => k.trim().length > 0 && isFullyQualified(k))
  } catch { return [] }
}
