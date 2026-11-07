import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, listSkills, listMcpServers } from '../src/main/mcp-skills'

function tmp(): string { return mkdtempSync(join(tmpdir(), 'cc-ms-')) }
function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), body)
}

describe('parseFrontmatter', () => {
  it('extracts scalar fields and strips quotes', () => {
    const fm = parseFrontmatter(`---\nname: debate\ndescription: "A: real debate, with colons"\nuser-invocable: true\n---\n# body`)
    expect(fm.name).toBe('debate')
    expect(fm.description).toBe('A: real debate, with colons') // value after first colon, quotes stripped
    expect(fm['user-invocable']).toBe('true')
  })
  it('returns {} when there is no frontmatter block', () => {
    expect(parseFrontmatter('# just a heading\nno frontmatter')).toEqual({})
  })
})

describe('listSkills', () => {
  it('reads user + project skills, parses frontmatter, sorts by name', () => {
    const home = tmp(); const proj = tmp()
    writeSkill(join(home, '.claude', 'skills'), 'zeta', `---\nname: zeta\ndescription: last\nuser-invocable: true\n---`)
    writeSkill(join(home, '.claude', 'skills'), 'alpha', `---\nname: alpha\ndescription: first\n---`)
    writeSkill(join(proj, '.claude', 'skills'), 'proj-skill', `---\nname: proj-skill\ndescription: p\n---`)
    try {
      const skills = listSkills({ homeDir: home, projectCwd: proj })
      expect(skills.map(s => s.name)).toEqual(['alpha', 'proj-skill', 'zeta'])
      expect(skills.find(s => s.name === 'zeta')?.userInvocable).toBe(true)
      expect(skills.find(s => s.name === 'alpha')?.userInvocable).toBe(true) // invocable unless it opts out
      expect(skills.find(s => s.name === 'proj-skill')?.scope).toBe('project')
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }) }
  })

  it('falls back to the directory name when frontmatter has no name, and skips dirs without SKILL.md', () => {
    const home = tmp()
    writeSkill(join(home, '.claude', 'skills'), 'noname', `---\ndescription: d\n---`)
    mkdirSync(join(home, '.claude', 'skills', 'empty-dir'), { recursive: true }) // no SKILL.md
    try {
      const skills = listSkills({ homeDir: home })
      expect(skills.map(s => s.name)).toEqual(['noname'])
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('returns [] when the skills dir does not exist', () => {
    const home = tmp()
    try { expect(listSkills({ homeDir: home })).toEqual([]) } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe('listMcpServers', () => {
  it('reads user (global) + project (per-project + .mcp.json) servers with transports and details', () => {
    const home = tmp(); const proj = tmp()
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        codex: { type: 'stdio', command: 'codex', args: ['-m', 'gpt', 'mcp-server'] },
        design: { type: 'http', url: 'https://api.example.com/mcp' }
      },
      projects: { [proj]: { mcpServers: { projsrv: { command: 'node', args: ['s.js'] } } } }
    }))
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'sse', url: 'http://localhost/sse' } } }))
    try {
      const servers = listMcpServers({ homeDir: home, projectCwd: proj })
      const byName = Object.fromEntries(servers.map(s => [s.name, s]))
      expect(byName.codex).toMatchObject({ scope: 'user', transport: 'stdio', detail: 'codex -m gpt mcp-server' })
      expect(byName.design).toMatchObject({ scope: 'user', transport: 'http', detail: 'https://api.example.com/mcp' })
      expect(byName.projsrv).toMatchObject({ scope: 'project', transport: 'stdio', detail: 'node s.js' })
      expect(byName.shared).toMatchObject({ scope: 'project', transport: 'sse' })
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }) }
  })

  it('infers http transport from a bare url and returns [] with no config file', () => {
    const home = tmp()
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { u: { url: 'http://x/mcp' } } }))
    const empty = tmp()
    try {
      expect(listMcpServers({ homeDir: home })[0]).toMatchObject({ transport: 'http', detail: 'http://x/mcp' })
      expect(listMcpServers({ homeDir: empty })).toEqual([])
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }) }
  })
})
