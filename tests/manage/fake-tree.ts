import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { encodePath, pathsFor, type ClaudePaths } from '../../src/main/manage/paths'

/** A fake %USERPROFILE% (.claude, .claude.json, temp\claude) in a temp dir --
 *  port of ClaudeMemoryTool's FakeClaudeTree. Tests never touch the real ~/.claude. */
export class FakeClaudeTree {
  readonly root: string
  readonly paths: ClaudePaths
  private readonly claudeJson: { projects: Record<string, unknown>; githubRepoPaths: Record<string, string[]> } =
    { projects: {}, githubRepoPaths: {} }

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'cc-manage-'))
    this.paths = pathsFor(this.root)
    mkdirSync(this.paths.claudeDir, { recursive: true })
    this.flushClaudeJson()
  }

  /** Creates and returns a real directory under the fixture root. */
  workDir(name: string): string {
    const d = join(this.root, 'work', name)
    mkdirSync(d, { recursive: true })
    return d
  }

  private projectFolder(workingDir: string): string {
    return join(this.paths.projectsDir, encodePath(workingDir))
  }

  addSession(workingDir: string, sessionId: string, ...extraLines: string[]): string {
    return this.addSessionRaw(workingDir, sessionId,
      JSON.stringify({ type: 'user', cwd: workingDir, sessionId }), ...extraLines)
  }

  addSessionRaw(workingDir: string, sessionId: string, ...lines: string[]): string {
    const dir = this.projectFolder(workingDir)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(file, lines.map(l => l + '\n').join(''))
    return file
  }

  addMemory(workingDir: string, file: string, text: string): string {
    const dir = join(this.projectFolder(workingDir), 'memory')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, file)
    mkdirSync(dirname(p), { recursive: true }) // `file` may be nested, e.g. sub/x.md
    writeFileSync(p, text)
    return p
  }

  addClaudeJsonProject(workingDir: string): void {
    this.claudeJson.projects[workingDir] = { allowedTools: [] }
    this.flushClaudeJson()
  }

  addGithubRepoPath(repo: string, dir: string): void {
    ;(this.claudeJson.githubRepoPaths[repo] ??= []).push(dir)
    this.flushClaudeJson()
  }

  private flushClaudeJson(): void {
    writeFileSync(this.paths.claudeJson, JSON.stringify(this.claudeJson))
  }

  addHistory(project: string, sessionId: string, display: string): void {
    mkdirSync(this.paths.claudeDir, { recursive: true })
    appendFileSync(this.paths.historyFile,
      JSON.stringify({ display, pastedContents: {}, timestamp: 1762917016684, project, sessionId }) + '\n')
  }

  /** kind = file-history | session-env | tasks | uploads */
  addSessionDir(kind: string, sessionId: string): string {
    const dir = join(this.paths.claudeDir, kind, sessionId)
    mkdirSync(dir, { recursive: true })
    const name = kind === 'tasks' ? '1.json' : kind === 'uploads' ? 'img.png' : 'data.txt'
    writeFileSync(join(dir, name), 'x')
    return dir
  }

  addTemp(workingDir: string): string {
    const dir = join(this.paths.tempClaudeDir, encodePath(workingDir))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'scratch.txt'), 'x')
    return dir
  }

  addJob(id: string, sessionId: string, cwd: string): string {
    const dir = join(this.paths.jobsDir, id)
    mkdirSync(dir, { recursive: true })
    const link = join(this.paths.projectsDir, encodePath(cwd), `${sessionId}.jsonl`)
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ sessionId, cwd, linkScanPath: link }))
    return dir
  }

  addTodo(sessionId: string): string {
    const dir = join(this.paths.claudeDir, 'todos')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, `${sessionId}-agent-${sessionId}.json`)
    writeFileSync(f, '[]')
    return f
  }

  /** .claude\settings.json and CLAUDE.md inside the working dir. */
  addInDirItems(workingDir: string): void {
    mkdirSync(join(workingDir, '.claude'), { recursive: true })
    writeFileSync(join(workingDir, '.claude', 'settings.json'), '{}')
    writeFileSync(join(workingDir, 'CLAUDE.md'), '# x')
  }

  addLiveSession(pid: number, sessionId: string, cwd: string, name = 't'): string {
    mkdirSync(this.paths.sessionsDir, { recursive: true })
    const file = join(this.paths.sessionsDir, `${pid}.json`)
    writeFileSync(file, JSON.stringify({ pid, sessionId, cwd, name }))
    return file
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}
