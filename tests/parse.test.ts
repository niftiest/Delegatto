import { describe, it, expect } from 'vitest'
import { parseLine, isMessageRow, blocksOf, blocksFromContent, textOf } from '../src/main/jsonl/parse'

const USER = '{"parentUuid":null,"type":"user","uuid":"u1","cwd":"C:\\\\a\\\\b","timestamp":"2026-02-26T01:05:53.376Z","message":{"role":"user","content":"hey"}}'
const ASSISTANT = '{"parentUuid":"u1","type":"assistant","uuid":"a1","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Hello"},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"x.ts"}}],"usage":{"input_tokens":3,"output_tokens":2}}}'

describe('parseLine', () => {
  it('returns null for blank and malformed lines instead of throwing', () => {
    expect(parseLine('')).toBeNull()
    expect(parseLine('   ')).toBeNull()
    expect(parseLine('{"broken":')).toBeNull()
    expect(parseLine('null')).toBeNull()
    expect(parseLine('[]')).toBeNull()
  })

  it('returns null for bare JSON values (number, string) instead of throwing', () => {
    expect(parseLine('42')).toBeNull()
    expect(parseLine('"oops"')).toBeNull()
  })

  it('returns null for object with no type field', () => {
    expect(parseLine('{"foo":1}')).toBeNull()
  })

  it('parses a string-content user row', () => {
    const row = parseLine(USER)!
    expect(isMessageRow(row)).toBe(true)
    expect(textOf(row as never)).toBe('hey')
    expect(blocksOf(row as never)).toEqual([{ type: 'text', text: 'hey' }])
  })

  it('parses an assistant row and keeps every block kind', () => {
    const row = parseLine(ASSISTANT)!
    const blocks = blocksOf(row as never)
    expect(blocks.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(textOf(row as never)).toBe('Hello')
  })

  it('preserves unknown row types rather than dropping them', () => {
    const row = parseLine('{"type":"file-history-snapshot","messageId":"m1"}')!
    expect(isMessageRow(row)).toBe(false)
    expect(row.type).toBe('file-history-snapshot')
  })

  it('returns row for message-type without message field; isMessageRow rejects it', () => {
    const row = parseLine('{"type":"user","uuid":"u1","parentUuid":null}')!
    expect(row).toBeDefined()
    expect(isMessageRow(row)).toBe(false)
  })
})

describe('blocksFromContent', () => {
  it('collapses a bare string into a single text block', () => {
    expect(blocksFromContent('hey')).toEqual([{ type: 'text', text: 'hey' }])
  })

  it('keeps only well-formed blocks from an array, dropping malformed entries', () => {
    const content = [{ type: 'text', text: 'ok' }, { notType: 'nope' }, 'plain-string', null]
    expect(blocksFromContent(content)).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('returns an empty array for non-array, non-string content', () => {
    expect(blocksFromContent(42)).toEqual([])
    expect(blocksFromContent(null)).toEqual([])
    expect(blocksFromContent(undefined)).toEqual([])
    expect(blocksFromContent({ type: 'text', text: 'not-an-array' })).toEqual([])
  })
})

describe('isMessageRow validation', () => {
  it('accepts valid row with parentUuid null', () => {
    const row = parseLine(USER)!
    expect(isMessageRow(row)).toBe(true)
  })

  it('accepts valid row with parentUuid as string', () => {
    const row = parseLine(ASSISTANT)!
    expect(isMessageRow(row)).toBe(true)
  })

  it('rejects row with missing parentUuid', () => {
    const row = parseLine('{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}')!
    expect(isMessageRow(row)).toBe(false)
  })

  it('rejects row with parentUuid as number', () => {
    const row = parseLine('{"type":"user","uuid":"u1","parentUuid":123,"message":{"role":"user","content":"hi"}}')!
    expect(isMessageRow(row)).toBe(false)
  })

  it('rejects row with message as array', () => {
    const row = parseLine('{"type":"user","uuid":"u1","parentUuid":null,"message":[]}')!
    expect(isMessageRow(row)).toBe(false)
  })

  it('rejects row with message.role missing', () => {
    const row = parseLine('{"type":"user","uuid":"u1","parentUuid":null,"message":{"content":"hi"}}')!
    expect(isMessageRow(row)).toBe(false)
  })
})
