import { readJsonFile, settingsPath, writeSettings, type SettingsLocations } from '../claude-settings/files'
import type { MainDialogRequest } from '../../shared/app-dialog'

/** Claude Code's one-time question before an interactive run with
 *  --dangerously-skip-permissions: "Yes, I accept" or "No, exit". Delegatto's own chats
 *  (`claude -p`) never ask it and run in bypass mode regardless, so it only matters when a
 *  chat opens in a terminal. Delegatto asks it first, in its own window, and records the
 *  answer where accepting in a terminal does, so the terminal goes straight in.
 *
 *  Accepted when, as Claude Code checks it (2.1.318): skipDangerousModePermissionPrompt is
 *  true in user, local or managed settings (not the project's own file, which anyone with
 *  the repository controls), or the older bypassPermissionsModeAccepted is in ~/.claude.json. */
export function bypassAccepted(loc: SettingsLocations, cwd: string, claudeJson: string | null): boolean {
  const files = [settingsPath(loc, { scope: 'user' }), settingsPath(loc, { scope: 'local', cwd }), ...loc.managedFiles]
  if (files.some(f => readJsonFile(f).data.skipDangerousModePermissionPrompt === true)) return true
  if (claudeJson === null) return false
  try {
    return (JSON.parse(claudeJson) as { bypassPermissionsModeAccepted?: unknown } | null)?.bypassPermissionsModeAccepted === true
  } catch { return false }
}

/** Saying yes: the same key Claude Code writes when it's accepted in a terminal. */
export function recordBypassAccepted(loc: SettingsLocations): void {
  writeSettings(loc, { scope: 'user' }, { skipDangerousModePermissionPrompt: true })
}

/** Claude Code's own wording. No is the safe answer, as in the terminal. */
export const BYPASS_QUESTION: Omit<MainDialogRequest, 'id'> = {
  title: 'Claude Code running in Bypass Permissions mode',
  detail: [
    'This chat opens in the terminal with permission prompts off. In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
    'This mode should only be used in a sandboxed container or VM that has restricted internet access and can easily be restored if damaged.',
    'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode. Claude Code asks this once; your answer is saved in its settings. See https://code.claude.com/docs/en/security'
  ],
  buttons: [{ label: 'No, don’t open it', kind: 'secondary' }, { label: 'Yes, I accept', kind: 'danger' }],
  defaultIndex: 0,
  cancelIndex: 0
}
export const BYPASS_ACCEPT_INDEX = 1
