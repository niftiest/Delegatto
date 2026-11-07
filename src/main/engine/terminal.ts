import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from './transport'

/** Opening a chat in a real Claude Code terminal, and reading the user's own
 *  Claude in Chrome preference. Node-only (no electron) like the rest of the
 *  engine core. */

/** Claude Code's "Claude in Chrome enabled by default" preference from
 *  ~/.claude.json. The interactive CLI honours it; headless `-p` runs don't,
 *  so Delegatto passes --chrome itself when this is on. */
export function claudeChromeDefault(claudeJson = join(homedir(), '.claude.json')): boolean {
  try {
    const v = JSON.parse(readFileSync(claudeJson, 'utf8')) as { claudeInChromeDefaultEnabled?: unknown }
    return v.claudeInChromeDefaultEnabled === true
  } catch {
    return false
  }
}

export function chromeEnabledFor(setting: 'auto' | 'on' | 'off', userDefault: () => boolean): boolean {
  return setting === 'on' || (setting === 'auto' && userDefault())
}

export type TerminalCommand = { file: string; args: string[]; verbatim: boolean }

/** The command that opens `claude --resume <id>` in `cwd` in a new visible
 *  terminal: Windows Terminal when installed, else a classic console. Pure, so
 *  it can be unit-tested; refuses values that could break out of the quoting. */
export function terminalCommand(cwd: string, sessionId: string, claudeBin: string, wtPath: string | null, flags: string[] = []): TerminalCommand {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) throw new Error('Unexpected session id.')
  if (/["\r\n]/.test(cwd) || /["\r\n&|<>^]/.test(claudeBin)) throw new Error('Unsupported characters in the folder or claude path.')
  // Refused rather than dropped: a terminal quietly running with other settings than
  // the chat would be worse than one that doesn't open.
  const unsafe = flags.find(f => /["\r\n&|<>^%;]/.test(f))
  if (unsafe !== undefined) throw new Error(`Unsupported characters in the extra CLI flag ${unsafe}.`)
  if (wtPath !== null) {
    return { file: wtPath, args: ['-d', cwd, claudeBin, '--resume', sessionId, ...flags], verbatim: false }
  }
  // cmd's `start` needs its own quoting: build the command line verbatim.
  return {
    file: 'cmd.exe',
    args: [`/d /c start "Claude Code" /D "${cwd}" cmd /k "${claudeBin}" --resume ${sessionId}${flags.map(f => ` ${/\s/.test(f) ? `"${f}"` : f}`).join('')}`],
    verbatim: true
  }
}

/** The command that opens `claude mcp login <name>` in a new visible terminal, so
 *  its browser sign-in can run and report back. */
export function mcpLoginCommand(cwd: string, serverName: string, claudeBin: string, wtPath: string | null): TerminalCommand {
  if (!/^[^"\r\n&|<>^%;]+$/.test(serverName)) throw new Error('Unsupported characters in the server name.')
  if (/["\r\n]/.test(cwd) || /["\r\n&|<>^]/.test(claudeBin)) throw new Error('Unsupported characters in the folder or claude path.')
  if (wtPath !== null) return { file: wtPath, args: ['-d', cwd, claudeBin, 'mcp', 'login', serverName], verbatim: false }
  return {
    file: 'cmd.exe',
    args: [`/d /c start "Claude Code" /D "${cwd}" cmd /k "${claudeBin}" mcp login "${serverName}"`],
    verbatim: true
  }
}

export function findWindowsTerminal(): string | null {
  const p = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe')
  return existsSync(p) ? p : null
}

/** Launches the terminal detached so it outlives Delegatto. */
export function openTerminal(cmd: TerminalCommand, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, {
      cwd, env: childEnv(), detached: true, stdio: 'ignore', windowsHide: cmd.verbatim, windowsVerbatimArguments: cmd.verbatim
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
