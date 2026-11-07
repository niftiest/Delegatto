import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { childEnv } from './transport'
import type { ContentBlock } from '../../shared/types'
import type { ShellRun } from '../../shared/shell-run-types'

/** Runs `!` commands for a chat: a separate process in its folder, with no permission
 *  prompts (the user typed it). As in the terminal, Claude gets the output of one that
 *  finishes and replies to it, through `onFinished`. One that was stopped gets no reply;
 *  it waits for the next message, as does anything that couldn't be delivered, surviving a
 *  restart until then. Node-only (no electron), injectable for tests. */

/** Plenty to read, without one noisy command filling memory. */
const MAX_OUTPUT_CHARS = 200_000
/** What Claude gets from one command, so a long log can't eat the conversation. */
const MAX_CLAUDE_CHARS = 30_000

/** Keeps the start and end of `text`, which is usually where the answer is. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = Math.floor(max / 2)
  return `${text.slice(0, keep)}\n… ${(text.length - keep * 2).toLocaleString('en-US')} characters left out …\n${text.slice(-keep)}`
}

/** Git Bash when installed, as Claude Code itself prefers on Windows, else PowerShell. */
export function shellCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): { file: string; args: string[] } {
  const bash = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles === undefined ? undefined : join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] === undefined ? undefined : join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
  ].find((p): p is string => p !== undefined && p.length > 0 && exists(p))
  return bash !== undefined
    ? { file: bash, args: ['-c', command] }
    : { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
}

/** The tags Claude Code itself stores a `!` command under, which its model
 *  understands and Delegatto's transcript already displays. */
export function shellRunBlocks(runs: ShellRun[]): ContentBlock[] {
  const safe = (s: string): string => s.replace(/<\/bash-/g, '<\\/bash-')
  return runs.flatMap((run): ContentBlock[] => {
    const note = run.state === 'stopped' ? '\n[stopped by the user]' : run.exitCode !== null && run.exitCode !== 0 ? `\n[exit code ${run.exitCode}]` : ''
    return [
      { type: 'text', text: `<bash-input>${safe(run.command)}</bash-input>` },
      { type: 'text', text: `<bash-stdout>${safe(clipMiddle(run.output.trimEnd(), MAX_CLAUDE_CHARS))}${note}</bash-stdout><bash-stderr></bash-stderr>` }
    ]
  })
}

export interface ShellChild {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  pid?: number
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'close', cb: (code: number | null) => void): unknown
}

export type ShellRunnerDeps = {
  /** The JSON file finished runs wait in, or null to keep them in memory only. */
  storePath: string | null
  onChange: (sessionPk: number, runs: ShellRun[]) => void
  /** A command ran to its end, successfully or not. Not called for one that was stopped. */
  onFinished?: (run: ShellRun) => void
  start?: (command: string, cwd: string) => ShellChild
  /** Ends a run and whatever it started. */
  killTree?: (pid: number) => void
  now?: () => number
  makeId?: () => string
}

function defaultStart(command: string, cwd: string): ShellChild {
  const { file, args } = shellCommand(command)
  return spawn(file, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) as unknown as ShellChild
}

function defaultKillTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* already gone */ })
}

export class ShellRunner {
  private runs: ShellRun[] = []
  private readonly pids = new Map<string, number>()
  private readonly stopping = new Set<string>()
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly deps: ShellRunnerDeps

  constructor(deps: ShellRunnerDeps) {
    this.deps = deps
    this.runs = this.load()
  }

  list(sessionPk: number): ShellRun[] {
    return this.runs.filter(r => r.sessionPk === sessionPk)
  }

  /** Chats with a command still running, once each. */
  runningChats(): number[] {
    return [...new Set(this.runs.filter(r => r.state === 'running').map(r => r.sessionPk))]
  }

  run(sessionPk: number, cwd: string, command: string): ShellRun {
    const run: ShellRun = {
      id: this.deps.makeId?.() ?? randomUUID(), sessionPk, command, output: '',
      startedAt: this.deps.now?.() ?? Date.now(), state: 'running', exitCode: null
    }
    this.runs.push(run)
    this.announce(sessionPk, true)
    let child: ShellChild
    try {
      child = (this.deps.start ?? defaultStart)(command, cwd)
    } catch (err) {
      this.finish(run, null, `Couldn't start the command: ${err instanceof Error ? err.message : String(err)}`)
      return run
    }
    if (child.pid !== undefined) this.pids.set(run.id, child.pid)
    const append = (chunk: Buffer | string): void => {
      run.output = clipMiddle(run.output + chunk.toString(), MAX_OUTPUT_CHARS)
      this.announce(sessionPk, false)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', err => this.finish(run, null, `Couldn't start the command: ${err.message}`))
    child.on('close', code => this.finish(run, code))
    return run
  }

  stop(id: string): void {
    const run = this.runs.find(r => r.id === id)
    const pid = this.pids.get(id)
    if (run === undefined || run.state !== 'running' || pid === undefined) return
    this.stopping.add(id)
    ;(this.deps.killTree ?? defaultKillTree)(pid)
  }

  /** "Leave out": the run won't go to Claude, and goes away. */
  dismiss(id: string): void {
    const run = this.runs.find(r => r.id === id)
    if (run === undefined) return
    this.stop(id)
    this.runs = this.runs.filter(r => r !== run)
    this.save()
    this.announce(run.sessionPk, true)
  }

  /** Hands over this chat's finished runs for its next message. Running ones
   *  stay, to go with the message after they finish. */
  takeFinished(sessionPk: number): ShellRun[] {
    const taken = this.runs.filter(r => r.sessionPk === sessionPk && r.state !== 'running')
    if (taken.length === 0) return []
    this.runs = this.runs.filter(r => !taken.includes(r))
    this.save()
    this.announce(sessionPk, true)
    return taken
  }

  /** App quit: nothing a `!` started should outlive it unnoticed. */
  dispose(): void {
    for (const run of this.runs) this.stop(run.id)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private finish(run: ShellRun, code: number | null, message?: string): void {
    if (run.state !== 'running') return
    if (message !== undefined) run.output += (run.output === '' ? '' : '\n') + message
    run.state = this.stopping.delete(run.id) ? 'stopped' : 'done'
    run.exitCode = run.state === 'done' ? code : null
    this.pids.delete(run.id)
    this.save()
    this.announce(run.sessionPk, true)
    if (run.state === 'done') this.deps.onFinished?.(run)
  }

  /** Output can arrive thousands of times a second; the screen needs a few. */
  private announce(sessionPk: number, now: boolean): void {
    const pending = this.timers.get(sessionPk)
    if (now) {
      if (pending !== undefined) { clearTimeout(pending); this.timers.delete(sessionPk) }
      this.deps.onChange(sessionPk, this.list(sessionPk))
    } else if (pending === undefined) {
      const timer = setTimeout(() => {
        this.timers.delete(sessionPk)
        this.deps.onChange(sessionPk, this.list(sessionPk))
      }, 100)
      timer.unref?.()
      this.timers.set(sessionPk, timer)
    }
  }

  private load(): ShellRun[] {
    if (this.deps.storePath === null) return []
    try {
      const raw = JSON.parse(readFileSync(this.deps.storePath, 'utf8')) as unknown
      return Array.isArray(raw) ? raw.filter((r): r is ShellRun => typeof r === 'object' && r !== null && typeof (r as ShellRun).id === 'string' && (r as ShellRun).state !== 'running') : []
    } catch {
      return []
    }
  }

  private save(): void {
    if (this.deps.storePath === null) return
    try {
      mkdirSync(dirname(this.deps.storePath), { recursive: true })
      writeFileSync(this.deps.storePath, JSON.stringify(this.runs.filter(r => r.state !== 'running')), 'utf8')
    } catch (err) {
      console.warn('[shell-run] could not save', err)
    }
  }
}
