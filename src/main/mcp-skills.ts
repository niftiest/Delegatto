import { readdirSync, readFileSync } from 'node:fs'
import { isSamePath } from './manage/paths'
import { dirname, join, parse } from 'node:path'

/** Read-only views of the user's configured MCP servers and installed skills,
 *  for Delegatto's "MCP & Skills" panel -- the GUI stand-in for the CLI's
 *  interactive `/mcp` and `/skills` (which don't render in headless mode).
 *  Pure/injectable (take homeDir + optional projectCwd) so they unit-test
 *  against a temp dir with no real ~/.claude. */

export type McpServerInfo = {
  name: string
  scope: 'user' | 'project'
  transport: string          // 'stdio' | 'http' | 'sse' | 'ws' | ...
  detail: string             // command+args, or url
}

export type SkillInfo = {
  name: string
  description: string
  scope: 'user' | 'project'
  userInvocable: boolean
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Minimal YAML-frontmatter scalar parser: the leading `---\n...\n---` block,
 *  split into `key: value` lines (value after the first colon, surrounding
 *  quotes stripped). Enough for SKILL.md's name/description/user-invocable --
 *  we deliberately don't pull in a YAML dependency for three scalar fields. */
export function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (m === null) return out
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (key.length === 0) continue
    let val = line.slice(idx + 1).trim()
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function readSkillsFrom(skillsDir: string, scope: 'user' | 'project'): SkillInfo[] {
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(skillsDir, { withFileTypes: true }) } catch { return [] }
  const out: SkillInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    let md: string
    try { md = readFileSync(join(skillsDir, e.name, 'SKILL.md'), 'utf8') } catch { continue }
    const fm = parseFrontmatter(md)
    out.push({
      name: fm.name && fm.name.length > 0 ? fm.name : e.name,
      description: fm.description ?? '',
      scope,
      // Skills can be invoked by name unless they opt out.
      userInvocable: fm['user-invocable'] !== 'false'
    })
  }
  return out
}

export function listSkills(opts: { homeDir: string; projectCwd?: string | null }): SkillInfo[] {
  const user = readSkillsFrom(join(opts.homeDir, '.claude', 'skills'), 'user')
  const project = opts.projectCwd ? readSkillsFrom(join(opts.projectCwd, '.claude', 'skills'), 'project') : []
  return [...project, ...user].sort((a, b) => a.name.localeCompare(b.name))
}

function serversFromMap(map: unknown, scope: 'user' | 'project'): McpServerInfo[] {
  if (!isObj(map)) return []
  const out: McpServerInfo[] = []
  for (const [name, raw] of Object.entries(map)) {
    const def = isObj(raw) ? raw : {}
    const url = typeof def.url === 'string' ? def.url : null
    const transport = typeof def.type === 'string' ? def.type : (url !== null ? 'http' : 'stdio')
    let detail = ''
    if (url !== null) detail = url
    else if (typeof def.command === 'string') {
      const args = Array.isArray(def.args) ? def.args.map(String) : []
      detail = [def.command, ...args].join(' ')
    }
    out.push({ name, scope, transport, detail })
  }
  return out
}

/** A folder and those above it, outermost first, stopping short of the drive root. */
function foldersDownTo(folder: string): string[] {
  const out: string[] = []
  const root = parse(folder).root
  for (let dir = folder; dir !== root && dir !== dirname(dir); dir = dirname(dir)) out.unshift(dir)
  return out
}

export function listMcpServers(opts: { homeDir: string; projectCwd?: string | null }): McpServerInfo[] {
  let root: Record<string, unknown> = {}
  try { root = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? opts.homeDir, '.claude.json'), 'utf8')) as Record<string, unknown> } catch { /* none */ }

  const user = serversFromMap(root.mcpServers, 'user')
  const project: McpServerInfo[] = []
  if (opts.projectCwd) {
    const projects = isObj(root.projects) ? root.projects : {}
    // Claude Code writes these keys with forward slashes on Windows.
    const key = Object.keys(projects).find(k => isSamePath(k, opts.projectCwd!))
    const entry = key === undefined ? undefined : projects[key]
    if (isObj(entry)) project.push(...serversFromMap(entry.mcpServers, 'project'))
    // Like Claude Code: every folder above the project too, the nearest winning a name.
    const fromFiles = new Map<string, McpServerInfo>()
    for (const dir of foldersDownTo(opts.projectCwd)) {
      try {
        const mcpJson = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as Record<string, unknown>
        for (const server of serversFromMap(mcpJson.mcpServers, 'project')) fromFiles.set(server.name, server)
      } catch { /* no .mcp.json here */ }
    }
    project.push(...fromFiles.values())
  }
  return [...user, ...project].sort((a, b) => a.name.localeCompare(b.name))
}
