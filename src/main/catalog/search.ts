import type { Catalog } from './db'
import type { SearchHit } from '../../shared/types'
import { excerptAround, searchTerms, type ProjectSearchHit, type ProjectSearchResult } from '../../shared/project-search'

/**
 * FTS5 treats quotes and operators (AND/OR/NOT/NEAR, *, ^, -, :, parens) as
 * query syntax; users type prose. Quote each whitespace-separated term so it
 * is matched as a literal phrase rather than parsed as an operator.
 *
 * The schema's `unicode61` tokenizer treats *all* punctuation as a token
 * separator, not just quotes. That means any whitespace-separated token made
 * up entirely of punctuation (`-`, `*`, `^`, `(`, `---`, `!!!`, a stray `"`,
 * ...) tokenizes to zero terms. Quoted, it becomes an empty FTS5 phrase, and
 * an empty phrase ANDed with real terms matches nothing — silently zeroing
 * out the whole query even though the real terms are present. This is
 * ordinary human input: `config.py --verbose`, `wait...`, `fix this !!!`,
 * `the total (approx)`.
 *
 * So a term is kept only if it contains at least one character the
 * tokenizer will actually index — a Unicode letter or digit (`\p{L}`/`\p{N}`,
 * so CJK, accented, etc. all count, not just ASCII). Terms that are nothing
 * but punctuation are dropped entirely rather than turned into an empty
 * phrase. Terms that mix punctuation with letters/digits (`config.py`,
 * `--verbose`, `foo_bar`, `v2.1`) are kept and quote-stripped as before; the
 * tokenizer splits them into multiple tokens internally, so the quoted term
 * becomes a phrase query over adjacent tokens — that's correct and matches
 * the same text as indexed.
 */
function toMatchExpression(query: string): string {
  const terms = query
    .split(/\s+/)
    .filter(t => /[\p{L}\p{N}]/u.test(t))
    .map(t => t.replace(/"/g, ''))
  if (terms.length === 0) return ''
  return terms.map(t => `"${t}"`).join(' AND ')
}

const PROJECT_SEARCH_LIMIT = 200

/** Ctrl+F: messages in one project's chats containing every word. A plain scan rather
 *  than the full-text index, which only matches whole words and ignores punctuation.
 *  Only what the chat shows as a message: not subagents' own traffic or task pings. */
export function searchProject(db: Catalog, projectId: number, query: string, limit = PROJECT_SEARCH_LIMIT): ProjectSearchResult {
  const terms = searchTerms(query)
  if (terms.length === 0) return { hits: [], total: 0 }
  const where = `
    FROM messages m JOIN sessions s ON s.id = m.session_pk
    WHERE s.project_id = ? AND s.kind = 'main' AND m.is_sidechain = 0 AND m.role IN ('user', 'assistant')
      AND m.text NOT LIKE '<task-notification>%'
      AND m.rewound = 0 AND m.text NOT LIKE '[Request interrupted by user%'
      AND m.text <> 'No response requested.'
      AND COALESCE(m.model, '') <> '<synthetic>'
      ${terms.map(() => `AND m.text LIKE ? ESCAPE '\\'`).join(' ')}`
  const patterns = terms.map(t => `%${t.replace(/[\\%_]/g, c => `\\${c}`)}%`)
  const { total } = db.prepare(`SELECT COUNT(*) AS total ${where}`).get(projectId, ...patterns) as { total: number }
  const rows = db.prepare(`
    SELECT m.id, m.session_pk AS sessionPk, m.uuid, m.seq, COALESCE(s.custom_title, s.ai_title, s.title) AS title, m.role, m.ts, m.text ${where}
    ORDER BY m.ts DESC, m.seq DESC
    LIMIT ?
  `).all(projectId, ...patterns, limit) as Array<Omit<ProjectSearchHit, 'trimmed'>>
  const hits = rows.reverse().map(r => ({ ...r, ...excerptAround(r.text, terms) }))
  return { hits, total }
}

/** Ctrl+K: every indexed message, subagents' included. Only main chats can open, so each
 *  hit names the chat it belongs to, not the subagent's own row. */
export function search(db: Catalog, query: string, limit = 100): SearchHit[] {
  const match = toMatchExpression(query)
  if (match === '') return []
  return db.prepare(`
    SELECT chat.id AS sessionPk, s.session_id AS sessionId, p.dir_name AS projectDir,
           m.seq, m.ts,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_pk
    JOIN sessions chat ON chat.project_id = s.project_id AND chat.session_id = s.session_id AND chat.kind = 'main'
    JOIN projects p ON p.id = s.project_id
    WHERE messages_fts MATCH ? AND m.rewound = 0
    ORDER BY rank
    LIMIT ?
  `).all(match, limit) as SearchHit[]
}
