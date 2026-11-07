import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, readHistory } from '../src/main/engine/chat-actions'

describe("Claude Code's history file", () => {
  let dir: string
  let file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-history-')); file = join(dir, 'history.jsonl') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is written the way the terminal writes it', async () => {
    await appendHistory(file, { text: 'a draft', project: 'D:\\work', sessionId: 's', at: 5 })
    expect(JSON.parse(readFileSync(file, 'utf8').trim())).toEqual({ display: 'a draft', pastedContents: {}, timestamp: 5, project: 'D:\\work', sessionId: 's' })
  })

  it('adds to what is there', async () => {
    writeFileSync(file, '{"display":"old","pastedContents":{},"timestamp":1,"project":"D:\\\\work","sessionId":"s"}\n')
    await appendHistory(file, { text: 'new', project: 'D:\\work', sessionId: 's', at: 2 })
    expect(await readHistory(file, 'D:\\work')).toEqual([{ text: 'old', at: 1 }, { text: 'new', at: 2 }])
  })

  it('reads only this project, however the path is written', async () => {
    await appendHistory(file, { text: 'here', project: 'D:\\Work', sessionId: 's', at: 1 })
    await appendHistory(file, { text: 'elsewhere', project: 'D:\\other', sessionId: 's', at: 2 })
    expect((await readHistory(file, 'd:\\work')).map(e => e.text)).toEqual(['here'])
  })

  it('puts pasted text back, and leaves a placeholder it has no text for', async () => {
    const row = { display: 'see [Pasted text #1 +20 lines] and [Pasted text #2 +3 lines]', pastedContents: { 1: { id: 1, type: 'text', content: 'the paste' } }, timestamp: 1, project: 'D:\\work' }
    writeFileSync(file, `${JSON.stringify(row)}\n`)
    expect((await readHistory(file, 'D:\\work'))[0]!.text).toBe('see the paste and [Pasted text #2 +3 lines]')
  })

  it('skips a bad line, and copes with no file', async () => {
    writeFileSync(file, 'not json\n{"display":"ok","timestamp":1,"project":"D:\\\\work"}\n{"display":5,"project":"D:\\\\work"}\n')
    expect((await readHistory(file, 'D:\\work')).map(e => e.text)).toEqual(['ok'])
    expect(await readHistory(join(dir, 'none.jsonl'), 'D:\\work')).toEqual([])
  })
})
