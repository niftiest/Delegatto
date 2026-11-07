import type { McpServerStatus } from '../../shared/claude-info-types'

/** Delegatto's own permission server, which isn't one of the user's tools. */
export const OWN_MCP_SERVER = 'delegatto'

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The command or URL a server runs, without its env or headers (those hold secrets). */
function serverDetail(config: unknown): string {
  if (!isObj(config)) return ''
  if (typeof config.url === 'string') return config.url
  if (typeof config.command !== 'string') return ''
  return [config.command, ...(Array.isArray(config.args) ? config.args.map(String) : [])].join(' ')
}

/** The answer to `mcp_status`, or the `mcp_servers` list in a turn's init event
 *  (which has only name, status and source). */
export function parseMcpServers(raw: unknown): McpServerStatus[] {
  if (!Array.isArray(raw)) return []
  const out: McpServerStatus[] = []
  for (const s of raw) {
    if (!isObj(s) || typeof s.name !== 'string' || s.name === OWN_MCP_SERVER) continue
    out.push({
      name: s.name,
      status: typeof s.status === 'string' ? s.status : 'unknown',
      error: typeof s.error === 'string' && s.error.length > 0 ? s.error : null,
      source: typeof s.source === 'string' ? s.source : '',
      transport: typeof s.transport === 'string' ? s.transport : null,
      detail: serverDetail(s.config),
      tools: Array.isArray(s.tools) ? s.tools.flatMap(t => isObj(t) && typeof t.name === 'string' ? [t.name] : []) : []
    })
  }
  return out
}
