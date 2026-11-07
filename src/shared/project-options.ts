/** Options a project can have its own value for, and how they combine with Settings.
 *  Settings gives the default; a project's own choice, made in Project options, wins.
 *  Electron-free: shared by the main process and the renderer. */

export type ToolDisplay = 'grouped' | 'all' | 'hidden'
export const TOOL_DISPLAYS: readonly ToolDisplay[] = ['grouped', 'all', 'hidden']
export type ToolDisplaySetting = ToolDisplay
export const TOOL_DISPLAY_SETTINGS: readonly ToolDisplaySetting[] = TOOL_DISPLAYS

export type SuggestionsSetting = 'off' | 'on'
export const SUGGESTIONS_SETTINGS: readonly SuggestionsSetting[] = ['off', 'on']

export type ThinkingDisplay = 'show' | 'hidden'
export const THINKING_DISPLAYS: readonly ThinkingDisplay[] = ['show', 'hidden']
export type ThinkingDisplaySetting = ThinkingDisplay
export const THINKING_DISPLAY_SETTINGS: readonly ThinkingDisplaySetting[] = THINKING_DISPLAYS

/** What one project remembers, shared by every chat in its folder. */
export type ProjectSettings = {
  model?: string
  effort?: string
  skipPermissions?: boolean
  promptSuggestions?: boolean
  toolDisplay?: ToolDisplay
  thinkingDisplay?: ThinkingDisplay
  /** Whether the Files panel is open. Unset: whatever was last chosen anywhere. */
  filesExpanded?: boolean
  /** Folders outside the project that Claude may use, for every chat in it. */
  extraDirs?: string[]
}

/** A project that hasn't chosen follows Settings. */
export function effectiveToolDisplay(setting: ToolDisplaySetting, project: ProjectSettings | null): ToolDisplay {
  return project?.toolDisplay ?? setting
}

export function effectiveThinkingDisplay(setting: ThinkingDisplaySetting, project: ProjectSettings | null): ThinkingDisplay {
  return project?.thinkingDisplay ?? setting
}

/** `claudeAllows` is false when the user's Claude Code settings turn suggestions off,
 *  which outranks everything here. */
export function suggestionsWanted(setting: SuggestionsSetting, project: ProjectSettings | null, claudeAllows: boolean): boolean {
  if (!claudeAllows) return false
  return project?.promptSuggestions ?? setting === 'on'
}

/** Turning tool calls back on in a project keeps the way Settings shows them, grouped or all. */
export function shownToolDisplay(setting: ToolDisplaySetting): ToolDisplay {
  return setting === 'hidden' ? 'grouped' : setting
}

export type ContextUsage = {
  usedTokens: number
  maxTokens: number
  percent: number
  /** What's taking the room, largest first. */
  categories: Array<{ name: string; tokens: number }>
}
