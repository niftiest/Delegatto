/** A `!` command: run by Delegatto in the chat's folder, without Claude. */
export type ShellRun = {
  id: string
  sessionPk: number
  command: string
  output: string
  startedAt: number
  state: 'running' | 'done' | 'stopped'
  /** null while running, or when it was stopped or never started. */
  exitCode: number | null
}

export type FolderContents = {
  /** .claude/settings.json or settings.local.json */
  settings: boolean
  /** Hook events its settings run commands on. */
  hooks: string[]
  /** Servers in its .mcp.json. */
  mcpServers: string[]
  /** CLAUDE.md */
  instructions: boolean
  /** .claude/skills, commands or agents */
  extensions: boolean
}

export type FolderTrust = {
  trusted: boolean
  contents: FolderContents
  /** The repository this folder is part of, when it isn't the repository's own root:
   *  trusting the folder trusts all of it, as in Claude Code. */
  repoRoot: string | null
  /** The home folder: trusted for this run of Delegatto only, never saved. */
  home: boolean
}
