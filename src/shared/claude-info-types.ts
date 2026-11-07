/** What a running Claude Code says it has available for a folder. Electron-free:
 *  shared by the main process and the renderer. */

export type CommandSource = 'project' | 'user' | 'plugin' | 'synced' | 'mcp' | 'builtin'

export type ClaudeCommand = {
  /** Without the leading slash, e.g. "compact" or "superpowers:brainstorming". */
  name: string
  description: string
  /** e.g. "<optional custom summarization instructions>"; '' when it takes none. */
  argumentHint: string
  /** Other names that run it, e.g. "brainstorming". */
  aliases: string[]
  source: CommandSource
  /** The plugin it came from, when source is 'plugin'. */
  plugin: string | null
}

export type ClaudeModel = {
  /** What gets passed to --model. */
  value: string
  label: string
  description: string
  /** The full id it currently means, e.g. "claude-opus-5-5". */
  resolved: string | null
  efforts: string[]
}

export type ClaudeInfo = {
  commands: ClaudeCommand[]
  models: ClaudeModel[]
  version: string | null
  fetchedAt: number
}

export type McpServerStatus = {
  name: string
  /** connected | pending | failed | needs-auth | disabled */
  status: string
  error: string | null
  /** user | project | plugin | claudeai | … */
  source: string
  transport: string | null
  /** The command or URL it runs. */
  detail: string
  tools: string[]
}

export type McpCheckResult = { ok: true; servers: McpServerStatus[] } | { ok: false; error: string }

export type ClaudeInfoResult = { ok: true; info: ClaudeInfo } | { ok: false; error: string }

/** Slash commands that need Claude Code's terminal: tested against 2.1.316 and 2.1.318
 *  without a terminal (or, for logins and installers, inherently interactive). Ones
 *  Delegatto answers itself (appCommandOf, /mcp, /add-dir, /btw, /rename, /rewind, /fork,
 *  /clear) aren't here, and neither is /doctor, which runs headless as a bundled skill.
 *  Claude's own command list can't answer this alone: it lists a few of these
 *  and leaves out aliases that do work, such as /cost. */
export const TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'artifacts', 'autofix-pr', 'background', 'brief', 'bug', 'cd', 'cloud-plugins', 'daemon', 'design-login',
  'desktop', 'feedback', 'ide', 'install', 'install-github-app',
  'install-slack-app', 'keybindings', 'login', 'logout', 'loops', 'mobile', 'passes',
  'powerup', 'privacy-settings', 'radio', 'rate-limit-options', 'rc', 'remote-control', 'remote-env',
  'restart', 'sandbox', 'scroll-speed', 'send-to-project', 'session', 'setup-bedrock', 'setup-vertex',
  'statusline', 'stickers', 'subtask', 'teleport', 'terminal-setup', 'todos', 'tui', 'ultraplan', 'upgrade',
  'vim', 'voice', 'web-setup', 'wellbeing', 'workflows'
])

/** Commands Delegatto answers itself (see appCommandOf and the /mcp, /add-dir, /btw,
 *  /rewind and /fork handling), for the / menu: a headless Claude doesn't list them. */
export const APP_COMMANDS: ReadonlyArray<Pick<ClaudeCommand, 'name' | 'description' | 'argumentHint' | 'aliases'>> = [
  { name: 'add-dir', description: 'Let Claude use another folder in this project', argumentHint: '<path>', aliases: [] },
  { name: 'btw', description: 'Ask a quick side question without interrupting the chat', argumentHint: '<question>', aliases: [] },
  { name: 'rewind', description: 'Go back to an earlier message, and optionally undo file changes', argumentHint: '', aliases: ['checkpoint', 'undo'] },
  { name: 'fork', description: 'Fork this chat to try something else from here', argumentHint: '', aliases: ['branch'] },
  { name: 'memory', description: 'Edit this project’s CLAUDE.md files', argumentHint: '', aliases: [] },
  { name: 'skills', description: 'See the skills Claude can use', argumentHint: '', aliases: [] },
  { name: 'permissions', description: 'Edit the allow, ask and deny rules for tools', argumentHint: '', aliases: ['allowed-tools'] },
  { name: 'theme', description: 'Change Delegatto’s theme and colors', argumentHint: '', aliases: [] },
  { name: 'status', description: 'Claude Code version, plan, model, mode and MCP servers', argumentHint: '', aliases: [] },
  { name: 'resume', description: 'Find another chat to continue', argumentHint: '', aliases: ['continue'] },
  { name: 'copy', description: 'Copy Claude’s last reply (or /copy N for the Nth-latest)', argumentHint: '[N]', aliases: [] },
  { name: 'plan', description: 'Turn on plan mode, optionally with what to plan', argumentHint: '[description]', aliases: [] },
  { name: 'focus', description: 'Hide tool calls and thoughts in this project, or show them again', argumentHint: '[on|off]', aliases: [] },
  { name: 'chrome', description: 'Claude in Chrome settings', argumentHint: '', aliases: [] },
  { name: 'color', description: 'In the terminal, the prompt bar’s color; here, how to tell chats apart', argumentHint: '', aliases: [] },
  { name: 'release-notes', description: 'Claude Code’s release notes', argumentHint: '', aliases: [] },
  { name: 'hooks', description: 'See, add and remove the hooks Claude Code runs', argumentHint: '', aliases: [] },
  { name: 'diff', description: 'See what has changed in this folder, file by file', argumentHint: '', aliases: [] },
  { name: 'tasks', description: 'See, follow and stop this chat’s background tasks', argumentHint: '', aliases: ['bashes'] },
  { name: 'export', description: 'Copy or save this chat as text', argumentHint: '[filename]', aliases: [] },
  { name: 'plugin', description: 'Install, turn on or off, update and remove plugins and marketplaces', argumentHint: '[install|enable|disable|update|uninstall <plugin>]', aliases: ['plugins', 'marketplace'] },
  { name: 'help', description: 'How commands work here', argumentHint: '', aliases: [] }
]

/** Delegatto runs these itself: Claude would start a new session underneath
 *  the open chat, so instead they open a new chat in the same folder. */
export const CLEAR_COMMANDS: ReadonlySet<string> = new Set(['clear', 'new', 'reset'])
