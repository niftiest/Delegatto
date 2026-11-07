/** Claude Code's own settings files, as Delegatto reads and edits them, plus
 *  chat retention (Claude Code's cleanupPeriodDays and Delegatto's own
 *  per-project auto-clean). Electron-free: shared by main and the renderer. */

export const CLAUDE_SETTINGS_IPC = {
  get: 'claudeSettings:get',
  update: 'claudeSettings:update',
  getText: 'claudeSettings:getText',
  saveText: 'claudeSettings:saveText',
  retentionStatus: 'retention:status',
  retentionPreview: 'retention:preview',
  retentionRunNow: 'retention:runNow',
  retentionCleaned: 'retention:cleaned',
  openChat: 'notify:openChat'
} as const

/** Which settings file to read or edit:
 *  - user:    ~/.claude/settings.json (every project)
 *  - project: <cwd>/.claude/settings.json (shared with the repo)
 *  - local:   <cwd>/.claude/settings.local.json (this machine only, not committed) */
export type ClaudeSettingsTarget = { scope: 'user' } | { scope: 'project' | 'local'; cwd: string }

/** Where the value in effect comes from. Precedence, highest first:
 *  managed > local > project > user > Claude Code's default. */
export type SettingSource = 'managed' | 'local' | 'project' | 'user' | 'default'

export type EffectiveValue = { value: unknown; source: SettingSource }

/** Keys Delegatto knows how to edit. Dotted keys are nested
 *  (`permissions.defaultMode` is `{ permissions: { defaultMode } }`). */
export const CLAUDE_SETTING_KEYS = [
  'model',
  'effortLevel',
  'alwaysThinkingEnabled',
  'permissions.defaultMode',
  'permissions.allow',
  'permissions.ask',
  'permissions.deny',
  'attribution.commit',
  'attribution.pr',
  'includeCoAuthoredBy',
  'autoMemoryEnabled',
  'autoCompactEnabled',
  'outputStyle',
  'language',
  'cleanupPeriodDays',
  'remoteControlAtStartup',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  // Written only when the user accepts Claude Code's bypass-mode question in Delegatto,
  // the same key accepting it in a terminal writes.
  'skipDangerousModePermissionPrompt'
] as const
export type ClaudeSettingKey = (typeof CLAUDE_SETTING_KEYS)[number]

/** Keys Claude Code only honours in the user file (or that only make sense there). */
export const USER_ONLY_KEYS: ReadonlySet<ClaudeSettingKey> = new Set<ClaudeSettingKey>(['cleanupPeriodDays', 'remoteControlAtStartup', 'skipDangerousModePermissionPrompt'])

/** List-valued keys: lists merge across files (every file's entries apply). */
export const LIST_KEYS: ReadonlySet<ClaudeSettingKey> = new Set<ClaudeSettingKey>([
  'permissions.allow', 'permissions.ask', 'permissions.deny', 'enabledMcpjsonServers', 'disabledMcpjsonServers'
])

export const PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'] as const

export type ClaudeSettingsView = {
  target: ClaudeSettingsTarget
  /** The file being edited. */
  path: string
  exists: boolean
  /** The file isn't valid JSON: shown, never written (fix it by hand first). */
  error: string | null
  /** This file's own values for the known keys (absent = not set here). */
  own: Partial<Record<ClaudeSettingKey, unknown>>
  /** What applies for this target (for a project, its files over the user's). */
  effective: Partial<Record<ClaudeSettingKey, EffectiveValue>>
  /** For list keys: every entry in effect, with the file it comes from. */
  lists: Partial<Record<ClaudeSettingKey, Array<{ value: string; source: SettingSource }>>>
  /** MCP servers declared in the project's .mcp.json (project targets only). */
  projectMcpServers: string[]
}

/** null removes the key from the file. */
export type ClaudeSettingsPatch = Partial<Record<ClaudeSettingKey, unknown>>

export type ClaudeSettingsUpdateResult = { ok: true; view: ClaudeSettingsView } | { ok: false; error: string }

/** A project or local settings file that sets its own cleanupPeriodDays. */
export type RetentionOverride = { cwd: string; file: string; days: number }

export type AutoCleanResult = {
  at: number
  removed: number
  sizeBytes: number
  /** Chats left alone: open in a terminal / Delegatto, or on a drive without a Recycle Bin. */
  skipped: number
  errors: string[]
}

export type RetentionStatus = {
  /** cleanupPeriodDays from ~/.claude/settings.json, or Claude Code's default (30). */
  claudeDays: number
  /** False when the user file doesn't set it (Claude Code's 30-day default applies). */
  claudeDaysSet: boolean
  /** Project files that set their own (possibly lower) value. */
  overrides: RetentionOverride[]
  lastRun: AutoCleanResult | null
}

export type AutoCleanPreview = {
  count: number
  sizeBytes: number
  byProject: Array<{ dirName: string; cwd: string | null; count: number; sizeBytes: number }>
}

export type ClaudeSettingsApi = {
  claudeSettingsGet(target: ClaudeSettingsTarget): Promise<ClaudeSettingsView>
  claudeSettingsUpdate(target: ClaudeSettingsTarget, patch: ClaudeSettingsPatch): Promise<ClaudeSettingsUpdateResult>
  /** The file itself, for settings that have no control of their own. */
  claudeSettingsText(target: ClaudeSettingsTarget): Promise<{ path: string; text: string }>
  claudeSettingsSaveText(target: ClaudeSettingsTarget, text: string): Promise<ClaudeSettingsUpdateResult>
  retentionStatus(): Promise<RetentionStatus>
  retentionPreview(): Promise<AutoCleanPreview>
  retentionRunNow(): Promise<AutoCleanResult>
  onRetentionCleaned(cb: (r: AutoCleanResult) => void): () => void
  /** A desktop notification was clicked: open this chat. */
  onOpenChat(cb: (sessionPk: number, dirName: string) => void): () => void
}

/** Claude Code's default retention when cleanupPeriodDays isn't set. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30
