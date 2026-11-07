import type { PermissionRequest, PermissionSuggestion } from './engine-types'

/** Claude Code writes a folder in a rule as `//c/Users/me/lib/**`. Null for anything else, and
 *  for the top of a drive, which is far too much to hand over with one button. */
function folderOfReadRule(rule: string): string | null {
  const m = /^\/\/(.+)\/\*\*$/.exec(rule)
  if (m === null) return null
  const drive = /^([a-zA-Z])\/(.+)$/.exec(m[1]!)
  if (drive !== null) return `${drive[1]!.toUpperCase()}:\\${drive[2]!.split('/').join('\\')}`
  if (/^[a-zA-Z]$/.test(m[1]!)) return null
  return `/${m[1]!}`
}

/** The folder a request is asking about, when the reason for asking is that it's outside the
 *  project. Only Claude Code's own reason counts: a Bash command may name a folder, but what it
 *  asks about is the command. */
export function outsideFolder(req: Pick<PermissionRequest, 'reasonType' | 'suggestions'>): string | null {
  if (req.reasonType !== 'workingDir') return null
  for (const s of req.suggestions ?? []) {
    const dir = s.type === 'addDirectories' ? s.directories?.[0] : undefined
    if (dir !== undefined && dir.length > 0) return dir
  }
  for (const s of req.suggestions ?? []) {
    if (s.type !== 'addRules') continue
    for (const r of s.rules ?? []) {
      if (r.toolName !== 'Read' || r.ruleContent === undefined) continue
      const dir = folderOfReadRule(r.ruleContent)
      if (dir !== null) return dir
    }
  }
  return null
}

/** What "don't ask again" applies from Claude Code's suggestions: rules and folders. One may
 *  also offer a change of mode, which is the user's own choice in the header, not a side effect. */
export function alwaysAllowChanges(suggestions: PermissionSuggestion[]): PermissionSuggestion[] {
  return suggestions.filter(s => s.type !== 'setMode')
}

/** Whether what's on offer ends with the session, so nothing about it is "always". */
export function onlyForSession(suggestions: PermissionSuggestion[]): boolean {
  const changes = alwaysAllowChanges(suggestions)
  return changes.length > 0 && changes.every(s => s.destination === 'session')
}

/** A session grant in the form `--allowedTools` takes. */
export function sessionRuleStrings(suggestions: PermissionSuggestion[]): string[] {
  return suggestions.flatMap(s => (s.type !== 'addRules' || s.destination !== 'session' || s.behavior !== 'allow' ? [] : (s.rules ?? []).flatMap(r => {
    if (r.toolName === undefined) return []
    return [r.ruleContent !== undefined && r.ruleContent.length > 0 ? `${r.toolName}(${r.ruleContent})` : r.toolName]
  })))
}
