import { execFile } from 'node:child_process'
import { isPidAlive } from '../engine/live-sessions'
import type { LiveSession } from './live'

/** Ends running Claude Code sessions so Delete and Rename can go ahead (port of
 *  ClaudeMemoryTool's SessionTerminator). Only the session's own process is
 *  ended -- never its child tree, which may include this app when it was started
 *  from a Claude session -- and only after checking it IS that session: pids are
 *  reused, so with a recorded `procStart` the process's start time must match it
 *  exactly; without one (older CLI) its name must start with "claude". */

export type TerminateFailure = { session: LiveSession; error: string }
export type TerminateResult = { ended: LiveSession[]; failures: TerminateFailure[] }

/** What the OS says about one pid. */
export type ProcessInfo =
  | { pid: number; found: false }
  | {
    pid: number; found: true
    /** Image name without extension (e.g. "claude"), '' when unknown. */
    name: string
    exited: boolean
    /** Start time as a FILETIME (UTC, 100 ns ticks) in canonical decimal, or null when unreadable. */
    startFileTime: string | null
    /** Why the start time / exit state couldn't be read (e.g. access denied). */
    error: string | null
  }

/** The OS seam: real implementation below, fakes in tests. */
export interface ProcessControl {
  /** This app's own pid -- never ended. */
  readonly ownPid: number
  /** Looks up every pid in one go. A pid missing from the map counts as not found. */
  inspect(pids: number[]): Promise<Map<number, ProcessInfo>>
  /** Ends the process itself (not its children). Throws on failure. */
  kill(pid: number): void
  /** Resolves true once the pid is gone, false after `timeoutMs`. */
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>
}

const DEFAULT_WAIT_MS = 5000

export async function endAll(
  sessions: Iterable<LiveSession>,
  control: ProcessControl = windowsProcessControl,
  waitMs = DEFAULT_WAIT_MS
): Promise<TerminateResult> {
  const unique: LiveSession[] = []
  for (const s of sessions) if (!unique.some(u => u.pid === s.pid)) unique.push(s)

  const ended: LiveSession[] = []
  const failures: TerminateFailure[] = []
  const toQuery = unique.filter(s => s.pid !== control.ownPid).map(s => s.pid)
  let infos: Map<number, ProcessInfo>
  try {
    infos = toQuery.length > 0 ? await control.inspect(toQuery) : new Map()
  } catch (e) {
    const why = `Not ended: could not look up the process (${errorText(e)}).`
    for (const s of unique) failures.push({ session: s, error: s.pid === control.ownPid ? OWN : why })
    return { ended, failures }
  }

  const killed: LiveSession[] = []
  for (const s of unique) {
    if (s.pid === control.ownPid) { failures.push({ session: s, error: OWN }); continue }
    const info = infos.get(s.pid)
    if (info === undefined || !info.found) { ended.push(s); continue } // already gone
    const why = verify(info, s)
    if (why === 'exited') { ended.push(s); continue } // killing an exited process is a no-op
    if (why !== null) { failures.push({ session: s, error: why }); continue }
    try {
      control.kill(s.pid)
      killed.push(s)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') ended.push(s) // exited in between
      else failures.push({ session: s, error: errorText(e) })
    }
  }

  const exited = await Promise.all(killed.map(s => control.waitForExit(s.pid, waitMs)))
  killed.forEach((s, i) => {
    if (exited[i]) ended.push(s)
    else failures.push({ session: s, error: 'The process did not exit in time.' })
  })
  return { ended, failures }
}

const OWN = "That is this app's own process."

/** null = it is the session's process; 'exited' = nothing to do; else the refusal text. */
function verify(info: Extract<ProcessInfo, { found: true }>, s: LiveSession): string | 'exited' | null {
  if (info.exited) return 'exited'
  if (s.procStart !== null) {
    if (info.startFileTime === null) {
      return `Not ended: could not read the process's start time${info.error ? ` (${info.error})` : ''}. Close it yourself.`
    }
    return canonical(info.startFileTime) === canonical(s.procStart) ? null
      : 'Not ended: the process with this id started at a different time, so it is not this Claude Code session.'
  }
  if (info.error !== null) return `Not ended: ${info.error}`
  return info.name.toLowerCase().startsWith('claude') ? null
    : `Not ended: could not confirm that process "${info.name}" is Claude Code. Close it yourself.`
}

function canonical(n: string): string {
  try { return BigInt(n).toString() } catch { return n }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// --- Windows implementation -------------------------------------------------

/** One hidden Windows PowerShell call for all pids. Uses .NET's
 *  Process.StartTime (GetProcessTimes: full 100 ns FILETIME precision, same
 *  value the CLI records and the C# tool compares). Win32_Process.CreationDate
 *  is NOT used: its CIM datetime keeps only microseconds, so it never equals a
 *  recorded procStart exactly. Values come back as strings so no digits are lost. */
export function buildInspectScript(pids: number[]): string {
  for (const p of pids) if (!Number.isInteger(p) || p <= 0) throw new Error(`Invalid pid: ${p}`)
  return [
    '$ErrorActionPreference = "Stop"',
    `$out = foreach ($id in @(${pids.join(',')})) {`,
    '  try { $p = [System.Diagnostics.Process]::GetProcessById($id) } catch { [pscustomobject]@{ pid = $id; found = $false }; continue }',
    '  $r = [ordered]@{ pid = $id; found = $true; name = ""; exited = $false; start = $null; error = $null }',
    '  try { $r.name = $p.ProcessName } catch { }',
    '  try { $r.exited = $p.HasExited } catch { $r.error = $_.Exception.Message }',
    '  if (-not $r.exited) { try { $r.start = $p.StartTime.ToFileTimeUtc().ToString() } catch { $r.error = $_.Exception.Message } }',
    '  $p.Dispose()',
    '  [pscustomobject]$r',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress'
  ].join('\n')
}

/** Parses the script's JSON output (tolerates a single object instead of an array). */
export function parseInspectOutput(stdout: string): Map<number, ProcessInfo> {
  const trimmed = stdout.trim()
  const map = new Map<number, ProcessInfo>()
  if (trimmed.length === 0) return map
  const raw = JSON.parse(trimmed) as unknown
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.pid !== 'number') continue
    if (r.found !== true) { map.set(r.pid, { pid: r.pid, found: false }); continue }
    map.set(r.pid, {
      pid: r.pid, found: true,
      name: typeof r.name === 'string' ? r.name : '',
      exited: r.exited === true,
      startFileTime: typeof r.start === 'string' && /^\d+$/.test(r.start) ? r.start : null,
      error: typeof r.error === 'string' ? r.error : null
    })
  }
  return map
}

export const windowsProcessControl: ProcessControl = {
  ownPid: process.pid,
  inspect(pids) {
    const script = buildInspectScript(pids)
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) { reject(new Error(String(stderr).trim() || err.message)); return }
          try { resolve(parseInspectOutput(String(stdout))) } catch (e) { reject(e) }
        })
    })
  },
  kill(pid) {
    // On Windows this is TerminateProcess on that one process (children survive).
    process.kill(pid)
  },
  async waitForExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (!isPidAlive(pid)) return true
      if (Date.now() >= deadline) return false
      await new Promise(r => setTimeout(r, 100))
    }
  }
}
