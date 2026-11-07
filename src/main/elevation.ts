import { execFile, execFileSync } from 'node:child_process'

/** Windows startup + admin-elevation. Per spec §6.1:
 *  - Start with Windows (no admin)  -> a `Run` registry key.
 *  - Start with Windows + admin     -> a Task Scheduler task with RL HIGHEST
 *    (the Run key CANNOT start a process elevated).
 *  - Start with Admin (manual)      -> relaunch elevated via a UAC prompt.
 *  The pure argv builders below are unit-tested; the actual reg/schtasks/UAC
 *  invocations are Windows-only and human-verified. */

export const TASK_NAME = 'Delegatto'
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const RUN_VALUE_NAME = 'Delegatto'

/** `reg add` argv registering the Run-key launch command. The value is the
 *  exe path plus any app args, quoted as one REG_SZ string. */
export function runKeyAddArgs(exePath: string, appArgs: string[] = []): string[] {
  const command = [quote(exePath), ...appArgs.map(quote)].join(' ')
  return ['add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f']
}

/** `reg delete` argv removing the Run-key entry. */
export function runKeyDeleteArgs(): string[] {
  return ['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f']
}

/** `schtasks /create` argv for an at-logon, highest-privilege task — the only
 *  way to auto-start elevated. `/RL HIGHEST` and `/SC ONLOGON` are the two
 *  load-bearing flags; a missing either silently fails to elevate. */
export function schtasksCreateArgs(exePath: string, appArgs: string[] = []): string[] {
  const tr = [quote(exePath), ...appArgs.map(quote)].join(' ')
  return ['/create', '/tn', TASK_NAME, '/tr', tr, '/sc', 'ONLOGON', '/rl', 'HIGHEST', '/f']
}

/** `schtasks /delete` argv removing the scheduled task. */
export function schtasksDeleteArgs(): string[] {
  return ['/delete', '/tn', TASK_NAME, '/f']
}

/** PowerShell argv that relaunches the app elevated via `Start-Process -Verb
 *  RunAs` (raises one UAC prompt). App args are passed through. */
export function elevatedRelaunchArgs(exePath: string, appArgs: string[] = []): string[] {
  const argList = appArgs.length > 0
    ? ` -ArgumentList ${appArgs.map(a => `'${a.replace(/'/g, "''")}'`).join(',')}`
    : ''
  return ['-NoProfile', '-Command', `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -Verb RunAs${argList}`]
}

function quote(s: string): string {
  return s.includes(' ') ? `"${s}"` : s
}

// ── Windows-only runtime actions (no-ops elsewhere) ─────────────────────────

const isWindows = process.platform === 'win32'

/** Whether the current process is running elevated (Administrator). Uses
 *  `net session`, which requires admin and exits non-zero otherwise. */
export function isElevated(): boolean {
  if (!isWindows) return false
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Reconcile the OS startup registration with the settings. `startWithWindows`
 *  + `startWithAdmin` together use a scheduled task; `startWithWindows` alone
 *  uses the Run key; neither removes both. Best-effort; errors are logged. */
export function applyStartupSettings(
  opts: { startWithWindows: boolean; startWithAdmin: boolean; exePath: string; appArgs?: string[] }
): void {
  if (!isWindows) return
  const args = opts.appArgs ?? []
  const run = (bin: string, a: string[]) => execFile(bin, a, { windowsHide: true }, err => { if (err) console.warn(`[elevation] ${bin} failed`, err.message) })
  // Clear both mechanisms first, then set the one that applies — keeps the two
  // from lingering together after a toggle change.
  run('reg', runKeyDeleteArgs())
  run('schtasks', schtasksDeleteArgs())
  if (opts.startWithWindows && opts.startWithAdmin) {
    run('schtasks', schtasksCreateArgs(opts.exePath, args))
  } else if (opts.startWithWindows) {
    run('reg', runKeyAddArgs(opts.exePath, args))
  }
}

/** Relaunch elevated (one UAC prompt) and signal the caller to quit the
 *  current unelevated instance. Returns false if not on Windows. */
export function relaunchElevated(exePath: string, appArgs: string[] = []): boolean {
  if (!isWindows) return false
  execFile('powershell', elevatedRelaunchArgs(exePath, appArgs), { windowsHide: true }, err => {
    if (err) console.warn('[elevation] relaunch failed', err.message)
  })
  return true
}
