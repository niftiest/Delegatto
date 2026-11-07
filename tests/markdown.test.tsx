import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/renderer/components/Markdown'
import { buildRenderItems } from '../src/main/jsonl/render'
import { elapsedLabel, groupToolRuns, plainPreview, thoughtRuns, thoughtsLabel, tokenLabel, toolRunSummary } from '../src/renderer/lib'
import { pickVerb } from '../src/renderer/components/WorkingLine'
import { parseEvent } from '../src/main/engine/events'
import type { RenderItem } from '../src/shared/types'
import type { MessageRow } from '../src/main/jsonl/rows'

vi.mock('../src/renderer/api', () => ({ api: { openLink: () => Promise.resolve() } }))

const html = (text: string, highlight = true): string => renderToStaticMarkup(<Markdown text={text} highlight={highlight} />)

// Each sample is a form found in real replies.
describe('Claude reply formatting', () => {
  it('tables, including alignment and pipes inside code', () => {
    const out = html('| Slot | Replace | Cost |\n|---|:---|--:|\n| Helm | Life `a\\|b` | **9** |\n| Ring 1 | Lucky | 2 |')
    expect(out).toContain('<div class="md-table"><table>')
    expect(out).toContain('<th>Slot</th>')
    expect(out).toContain('<td>Helm</td>')
    expect(out).toContain('<code>a|b</code>')
    expect(out).toContain('<strong>9</strong>')
    expect(out).toMatch(/text-align:\s*right/)
    expect(out).not.toContain('|---')
  })

  it('bold, italic, code and strikethrough', () => {
    const out = html('**One thing I would confirm** and *behind* and `code` and ~~old~~ and **`D:\\GIT\\x`**')
    expect(out).toContain('<strong>One thing I would confirm</strong>')
    expect(out).toContain('<em>behind</em>')
    expect(out).toContain('<code>code</code>')
    expect(out).toContain('<del>old</del>')
    expect(out).toContain('<strong><code>D:\\GIT\\x</code></strong>')
  })

  it('"about" tildes stay as written', () => {
    const out = html('~2,000 comments, about ~1,600 of them')
    expect(out).toContain('~2,000 comments, about ~1,600 of them')
    expect(out).not.toContain('<del>')
  })

  it('bullets, nesting, numbers and task lists', () => {
    const out = html('- This\n- That\n  - Deeper\n\n1. One\n2. Two\n\n5) Five\n\n- [x] Done\n- [ ] Not')
    expect(out).toContain('<li>This</li>')
    expect(out).toMatch(/<li>That\s*<ul>\s*<li>Deeper<\/li>/)
    expect(out).toContain('<ol>')
    expect(out).toContain('<ol start="5">')
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('checked')
  })

  it('headings, quotes and rules', () => {
    const out = html('# One\n## Two\n### Three\n#### Four\n\n> quoted\n\n---\n\nafter')
    for (const tag of ['<h1>One', '<h2>Two', '<h3>Three', '<h4>Four', '<blockquote>', '<hr/>']) expect(out).toContain(tag)
  })

  it('code blocks keep their text and language, and colour it', () => {
    const out = html('```csharp\nvar x = "a|b"; // **not bold**\n```\n\n```\nplain\n```\n\n```powershell\nGet-Item x\n```\n\n```nosuchlanguage\nkept\n```')
    expect(out).toContain('<span>csharp</span>')
    expect(out).toContain('hljs-string')
    expect(out).toContain('**not bold**')
    expect(out).toContain('plain')
    expect(out).toContain('hljs-built_in')
    expect(out).toContain('kept')
    expect(html('```js\nconst a = 1\n```', false)).not.toContain('hljs-')
  })

  it('links: named, bare and without the trailing full stop', () => {
    const out = html('[MCP page](https://e.run/mcp) and https://status.claude.com. Done')
    expect(out).toContain('href="https://e.run/mcp"')
    expect(out).toContain('href="https://status.claude.com"')
  })

  it('drops dangerous links', () => {
    expect(html('[x](javascript:alert(1))')).not.toContain('javascript:')
  })

  it('never injects HTML or fetches images', () => {
    const out = html('Use <summary> here. <script>alert(1)</script>\n\n<img src="http://evil/x.png">\n\n![alt text](http://evil/y.png)')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;summary&gt;')
    expect(out).toContain('alt text')
  })

  it('keeps single line breaks and Windows paths', () => {
    const out = html('first line\nsecond line\n\nSee C:\\Users\\cpaec\\file_name_here.txt:38')
    expect(out).toContain('<br/>')
    expect(out).toContain('C:\\Users\\cpaec\\file_name_here.txt:38')
  })

  it('leaves dollar amounts alone', () => {
    expect(html('It cost $5 and then $6')).toContain('It cost $5 and then $6')
  })

  it('copes with half-streamed text', () => {
    for (const partial of ['**unfinished', '| a | b |\n|--', '```js\nconst', '- ', '[link](http']) expect(() => html(partial, false)).not.toThrow()
  })
})

describe('chat list previews', () => {
  it('read as plain text', () => {
    expect(plainPreview('**Keep `cruisesitescripts`** on *Vultr*')).toBe('Keep cruisesitescripts on Vultr')
    expect(plainPreview('# Formatting Check\n| Element | Included |\n|---|---|\n| Heading | Yes |')).toBe('Formatting Check · Element · Included · Heading · Yes')
    expect(plainPreview('- first\n- second')).toBe('first second')
    expect(plainPreview('See [the page](https://x.y) now')).toBe('See the page now')
    expect(plainPreview('2 * 3 * 4 and a_b_c')).toBe('2 * 3 * 4 and a_b_c')
  })
})

describe('working line and tool runs', () => {
  const tool = (name: string): RenderItem => ({ kind: 'tool', uuid: 'u', toolUseId: name, name, input: {}, result: null, subagentToolUseId: null })
  const think: RenderItem = { kind: 'thinking', uuid: 't', ts: null, text: 'hm' }
  const say: RenderItem = { kind: 'text', uuid: 's', role: 'assistant', ts: null, model: null, text: 'hi' }

  it('formats time and tokens as the terminal does', () => {
    expect(elapsedLabel(8_000)).toBe('8s')
    expect(elapsedLabel(709_000)).toBe('11m 49s')
    expect(elapsedLabel(3_720_000)).toBe('1h 2m')
    expect(tokenLabel(850)).toBe('850')
    expect(tokenLabel(53_900)).toBe('53.9k')
    expect(tokenLabel(1_200_000)).toBe('1.2M')
  })

  it('collapses runs of steps, leaving text and lone steps alone', () => {
    expect(groupToolRuns([say, tool('Bash'), think, tool('Read'), say, tool('Bash'), say])).toEqual([
      { group: false, index: 0 }, { group: true, indices: [1, 2, 3] }, { group: false, index: 4 }, { group: false, index: 5 }, { group: false, index: 6 }
    ])
    expect(toolRunSummary([tool('Bash'), think, tool('Bash'), tool('Read')])).toBe('4 steps · Bash ×2, thought, Read')
  })

  it('treats thoughts in a row as one thing', () => {
    expect(groupToolRuns([think, think, think])).toEqual([{ group: 'thoughts', indices: [0, 1, 2] }])
    expect(groupToolRuns([say, think, think, say])).toEqual([{ group: false, index: 0 }, { group: 'thoughts', indices: [1, 2] }, { group: false, index: 3 }])
    expect(groupToolRuns([think])).toEqual([{ group: false, index: 0 }])
    // With a tool beside them it's still a run of steps, with those thoughts counted once.
    expect(groupToolRuns([think, think, tool('Bash')])).toEqual([{ group: true, indices: [0, 1, 2] }])
    expect(toolRunSummary([think, think, tool('Bash')])).toBe('2 steps · thought, Bash')
    expect(toolRunSummary([think, tool('Bash'), think, think])).toBe('3 steps · thought ×2, Bash')
  })

  it('only joins thoughts with nothing between them', () => {
    const items = [think, think, tool('Bash'), think, say, think, think, think]
    expect(thoughtRuns(items.map((_, i) => i), items)).toEqual([[0, 1], [2], [3], [4], [5, 6, 7]])
    expect(thoughtRuns([], [])).toEqual([])
    expect(thoughtRuns([0, 1], [tool('A'), tool('B')])).toEqual([[0], [1]])
  })

  it('labels one thought and several', () => {
    expect(thoughtsLabel(['x'.repeat(494)])).toBe('thought · 494 chars')
    expect(thoughtsLabel(['x'.repeat(300), 'y'.repeat(194)])).toBe('thoughts · 2 · 494 chars')
    expect(thoughtsLabel(['x'.repeat(1500), 'y'.repeat(750)])).toBe(`thoughts · 2 · ${(2250).toLocaleString()} chars`)
  })

  it('reads token use, and keeps the same word for a whole turn', () => {
    expect(parseEvent('{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":104}}}')).toEqual({ kind: 'usage', outputTokens: 104 })
    expect(pickVerb(1000)).toBe(pickVerb(1000))
  })
})

describe('what stays literal', () => {
  it('marks a shell command\'s output so it isn\'t read as markdown', () => {
    const row = { type: 'user', uuid: 'u', parentUuid: null, message: { role: 'user', content: '<bash-stdout>**a** _b_</bash-stdout><bash-stderr></bash-stderr>' } } as MessageRow
    expect(buildRenderItems([row])[0]).toMatchObject({ kind: 'text', role: 'assistant', text: '**a** _b_', literal: true })
    const local = { type: 'user', uuid: 'v', parentUuid: null, message: { role: 'user', content: '<local-command-stdout>## Context</local-command-stdout>' } } as MessageRow
    expect(buildRenderItems([local])[0]).not.toHaveProperty('literal')
  })
})
