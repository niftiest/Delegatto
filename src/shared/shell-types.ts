import type { SuggestionsSetting, ThinkingDisplaySetting, ToolDisplaySetting } from './project-options'
import type { ThemeColors } from './theme-colors'
// App-owned channel customization (rename/favorite/group/icon). Kept in
// shared/ (electron-free) since both the main-process metadata repos
// (src/main/catalog/metadata.ts) and the renderer nav need the shape.
export type ChannelIcon =
  | { kind: 'initials' }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'color'; color: string }
  | { kind: 'image'; dataUrl: string }

export type ChannelMeta = {
  dirName: string
  friendlyName: string | null
  starred: boolean
  groupId: number | null
  icon: ChannelIcon
  /** Removed from the main nav (into a collapsed "Hidden" section) without
   *  deleting its transcripts. Reversible via Unhide. */
  hidden: boolean
}

export type ChannelGroup = { id: number; name: string; sortOrder: number; icon: ChannelIcon }

/** App preferences, persisted in the catalog's settings_kv table. Every field
 *  has a default (see DEFAULT_SETTINGS in settings.ts); a stored value always
 *  overrides its default. */
export type BuiltInTheme = 'paper' | 'slate' | 'ember' | 'plum' | 'forest' | 'terminal'
export const APP_THEMES: readonly BuiltInTheme[] = ['paper', 'slate', 'ember', 'plum', 'forest', 'terminal']
export const DEFAULT_THEME: BuiltInTheme = 'paper'
/** A built-in, or `local:<name>`: a theme file kept in this PC's themes folder. */
export type AppTheme = BuiltInTheme | `local:${string}`
/** Where a non-default theme applies: just the chat pane (header, transcript,
 *  composer) or the whole window (rail, chat list, context rail, dialogs). */
export type AppThemeScope = 'chat' | 'app'
export const APP_THEME_SCOPES: readonly AppThemeScope[] = ['chat', 'app']

export const CLOSE_ACTIONS = ['ask', 'exit', 'tray'] as const
export type CloseAction = typeof CLOSE_ACTIONS[number]

/** A page of the Settings window, for opening it at one. */
export type SettingsSection = 'startup' | 'updates' | 'defaults' | 'notifications' | 'appearance' | 'claude' | 'history' | 'sync' | 'mcp' | 'skills' | 'plugins' | 'openrouter' | 'engine'

export type AppSettings = {
  // Startup & System (Windows-specific behaviour behind a platform guard)
  startWithWindows: boolean; startMinimized: boolean; startWithAdmin: boolean
  /** What the window's close button does. 'ask' until the user has chosen. */
  closeAction: CloseAction; showTrayIcon: boolean
  // Defaults for new chats
  defaultCwd: string | null; defaultModel: string | null; defaultEffort: string | null
  defaultSkipPermissions: boolean
  /** --max-budget-usd for each Claude process Delegatto starts (null = no cap). */
  defaultBudgetUsd: number | null
  // Notifications
  notifyTurnComplete: boolean; notifyInputNeeded: boolean; notifyPermission: boolean; notifyError: boolean
  doNotDisturb: boolean; quietHoursStart: string | null; quietHoursEnd: string | null
  // Appearance
  /** Visual theme, applied as `<html data-theme>`. The built-ins live in
   *  styles.css; a `local:` theme is a file in this PC's themes folder. */
  theme: AppTheme
  /** Where `theme` applies -- 'chat' (the chat pane only, default) or 'app'. */
  themeScope: AppThemeScope
  /** The saved theme these settings came from, by name. Null: a built-in look. */
  activeTheme: string | null
  /** Your own colours on top of the theme. Empty: the theme's own. */
  themeColors: ThemeColors
  /** Check GitHub for a new Delegatto version on launch and every few hours. */
  autoCheckUpdates: boolean
  /** Restart into a downloaded update by itself once nothing would be interrupted. */
  autoInstallUpdates: boolean
  /** Claude in Chrome for chats run by Delegatto: 'auto' follows Claude
   *  Code's own "enabled by default" preference; 'on' / 'off' override it. */
  chromeIntegration: 'auto' | 'on' | 'off'
  density: 'comfortable' | 'compact'
  /** The chat list: two lines with a large icon, or one line with a small one. */
  navDensity: 'comfortable' | 'compact'
  /** Text size in the chat, and in the sidebars, as a percentage. See font-settings.ts. */
  chatFontScale: number
  sidebarFontScale: number
  /** The font everywhere but code. Blank: the app's own fonts. */
  appFont: string
  thinkingExpanded: boolean; toolCardsExpanded: boolean
  /** How tool calls show in chats, for projects that haven't chosen in Project options. */
  toolDisplay: ToolDisplaySetting
  /** Whether Claude's thoughts show in chats. Same rule as toolDisplay. */
  thinkingDisplay: ThinkingDisplaySetting
  /** Same rule as toolDisplay. */
  promptSuggestions: SuggestionsSetting
  /** Command-deck redesign: the separate session Blade column. Default false --
   *  the redesigned layout is rail + chat list + chat + context rail; the blade
   *  is an opt-in fourth column for users who want a per-session picker. */
  showBlade: boolean
  /** The right-hand context rail (Files / Context / Usage). Default true. */
  showContextRail: boolean
  /** OpenRouter API key for AI avatar generation (empty = feature off). Stored
   *  in the local settings DB, never in source. */
  openRouterKey: string
  /** OpenRouter image-generation model used for AI avatars. */
  avatarModel: string
  /** Custom avatar for Claude in the transcript (app-wide). `initials` (the
   *  default) keeps the classic ✳ accent circle; emoji/color/image override it. */
  claudeIcon: ChannelIcon
  // Engine
  claudeBin: string; idleReapMin: number; extraFlags: string[]
  // Safety
  /** Ask before creating a chat that skips permission prompts. */
  confirmBeforeBypass: boolean
  // Chat history (Delegatto's own auto-clean; Claude Code's cleanupPeriodDays is separate)
  /** Send chats untouched for this many days to the Recycle Bin (null = never). */
  autoCleanDays: number | null
  /** Per project (projects-folder name): days, or null = never. Absent = autoCleanDays. */
  autoCleanProjects: Record<string, number | null>
  /** The "Claude Code deletes old chats" notice was dismissed. */
  retentionNoticeDismissed: boolean
  /** MCP servers the chat header shouldn't warn about (e.g. one that's only up sometimes). */
  mcpWarnIgnore: string[]
  /** Folders the user said new chats may start in. */
  trustedFolders: string[]
}
