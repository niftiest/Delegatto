import { compareVersions } from '../../shared/semver'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Which program to start for Claude Code. Claude Code's Windows installer puts it in
 *  ~\.local\bin and can leave that off PATH, and a running app keeps the PATH it started
 *  with, so the default setting needs a second place to look. A path the user chose is
 *  theirs, and is used as given. Looked up each time, so installing Claude Code while the
 *  app is open works without a restart. */

export const DEFAULT_CLAUDE_BIN = 'claude'

export type FoundClaude = { bin: string; found: boolean }

type Look = { path?: string; home?: string; exists?: (file: string) => boolean }

/** Starting a program directly only runs these, so a `claude.cmd` wouldn't count. */
const RUNNABLE = ['.exe', '.com']

function onPath(name: string, path: string, exists: (file: string) => boolean): boolean {
  return path.split(delimiter).filter(dir => dir.length > 0).some(dir => RUNNABLE.some(ext => exists(join(dir.replace(/^"|"$/g, ''), `${name}${ext}`))))
}

export function findClaude(configured: string, look: Look = {}): FoundClaude {
  const exists = look.exists ?? existsSync
  const path = look.path ?? process.env.PATH ?? ''
  if (configured !== DEFAULT_CLAUDE_BIN) {
    const isPath = isAbsolute(configured) || /[\\/]/.test(configured)
    return { bin: configured, found: isPath ? exists(configured) : onPath(configured, path, exists) }
  }
  if (onPath(DEFAULT_CLAUDE_BIN, path, exists)) return { bin: DEFAULT_CLAUDE_BIN, found: true }
  const installed = join(look.home ?? homedir(), '.local', 'bin', 'claude.exe')
  if (exists(installed)) return { bin: installed, found: true }
  return { bin: DEFAULT_CLAUDE_BIN, found: false }
}

/** Thinking text as it comes, and what subagents are doing. */
export const LIVE_DETAIL_FLAGS = ['--thinking-display', 'summarized', '--forward-subagent-text']

/** The oldest Claude Code these were tried on. */
const LIVE_DETAIL_FROM = '2.1.318'

/** Whether `claude --version` names a version these flags work on. */
export function supportsLiveDetail(versionOutput: string): boolean {
  const found = /(\d+\.\d+\.\d+)/.exec(versionOutput)?.[1]
  return found !== undefined && compareVersions(found, LIVE_DETAIL_FROM) >= 0
}
