import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamRows, streamRange, MAX_LINE_BYTES } from '../src/main/jsonl/stream'

let dir: string
const line = (uuid: string) => JSON.stringify({ type: 'user', uuid, parentUuid: null, message: { role: 'user', content: uuid } })
const rowWithContent = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, parentUuid: null, message: { role: 'user', content } })

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cc-stream-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('streamRows', () => {
  it('reads all complete lines and reports the end offset', async () => {
    const f = join(dir, 'a.jsonl')
    const content = `${line('u1')}\n${line('u2')}\n`
    writeFileSync(f, content)
    const res = await streamRows(f)
    expect(res.rows.map(r => (r.row as { uuid: string }).uuid)).toEqual(['u1', 'u2'])
    expect(res.endOffset).toBe(Buffer.byteLength(content))
    expect(res.seqEnd).toBe(2)
  })

  it('reports byteOffset at the start of each line', async () => {
    const f = join(dir, 'b.jsonl')
    const first = `${line('u1')}\n`
    writeFileSync(f, `${first}${line('u2')}\n`)
    const res = await streamRows(f)
    expect(res.rows[0]!.byteOffset).toBe(0)
    expect(res.rows[1]!.byteOffset).toBe(Buffer.byteLength(first))
  })

  it('does not emit a trailing partial line', async () => {
    const f = join(dir, 'c.jsonl')
    const complete = `${line('u1')}\n`
    writeFileSync(f, `${complete}{"type":"user","uuid":"hal`)
    const res = await streamRows(f)
    expect(res.rows).toHaveLength(1)
    expect(res.endOffset).toBe(Buffer.byteLength(complete))
  })

  it('resumes from an offset and continues the sequence', async () => {
    const f = join(dir, 'd.jsonl')
    writeFileSync(f, `${line('u1')}\n`)
    const first = await streamRows(f)
    appendFileSync(f, `${line('u2')}\n`)
    const second = await streamRows(f, first.endOffset, first.seqEnd)
    expect(second.rows.map(r => (r.row as { uuid: string }).uuid)).toEqual(['u2'])
    expect(second.rows[0]!.seq).toBe(1)
    expect(second.seqEnd).toBe(2)
  })

  it('counts multi-byte characters as bytes, not code units', async () => {
    const f = join(dir, 'e.jsonl')
    const emoji = JSON.stringify({ type: 'user', uuid: '✅✅', parentUuid: null, message: { role: 'user', content: 'ok' } })
    writeFileSync(f, `${emoji}\n${line('u2')}\n`)
    const res = await streamRows(f)
    expect(res.rows[1]!.byteOffset).toBe(Buffer.byteLength(`${emoji}\n`))
  })

  it('keeps byteOffset exact for every row across many real chunk boundaries', async () => {
    const f = join(dir, 'f.jsonl')
    const rowCount = 3000
    let content = ''
    const expectedOffsets: number[] = []
    const expectedUuids: string[] = []
    for (let i = 0; i < rowCount; i++) {
      // Variable, unpredictable padding length so line boundaries land at
      // irregular positions relative to 64 KiB (65536-byte) chunk edges.
      const padLen = ((i * 37) % 503) + 1
      const uuid = `row-${i}`
      const lineText = rowWithContent(uuid, 'x'.repeat(padLen))
      const lineWithNewline = `${lineText}\n`
      expectedOffsets.push(Buffer.byteLength(content))
      expectedUuids.push(uuid)
      content += lineWithNewline
    }
    const totalBytes = Buffer.byteLength(content)
    expect(totalBytes).toBeGreaterThan(512 * 1024)
    writeFileSync(f, content)

    const res = await streamRows(f)

    expect(res.rows).toHaveLength(rowCount)
    for (let i = 0; i < rowCount; i++) {
      expect(res.rows[i]!.byteOffset).toBe(expectedOffsets[i])
      expect((res.rows[i]!.row as { uuid: string }).uuid).toBe(expectedUuids[i])
    }
    expect(res.endOffset).toBe(totalBytes)
  })

  it('reads a single line larger than one chunk intact, with correct offsets around it', async () => {
    const f = join(dir, 'g.jsonl')
    const bigContent = 'z'.repeat(70000) // exceeds the 64 KiB default highWaterMark on its own
    const linesBefore = [line('before-1'), line('before-2')]
    const bigLine = rowWithContent('big-row', bigContent)
    const linesAfter = [line('after-1'), line('after-2')]

    let content = ''
    const expectedOffsets: number[] = []
    for (const l of [...linesBefore, bigLine, ...linesAfter]) {
      expectedOffsets.push(Buffer.byteLength(content))
      content += `${l}\n`
    }
    const totalBytes = Buffer.byteLength(content)
    expect(totalBytes).toBeGreaterThan(64 * 1024)
    writeFileSync(f, content)

    const res = await streamRows(f)

    expect(res.rows).toHaveLength(linesBefore.length + 1 + linesAfter.length)
    const bigIndex = linesBefore.length
    const bigRow = res.rows[bigIndex]!
    expect(bigRow.byteOffset).toBe(expectedOffsets[bigIndex])
    expect((bigRow.row as { uuid: string }).uuid).toBe('big-row')
    expect((bigRow.row as { message: { content: string } }).message.content).toBe(bigContent)

    for (let i = 0; i < res.rows.length; i++) {
      expect(res.rows[i]!.byteOffset).toBe(expectedOffsets[i])
    }
    expect(res.endOffset).toBe(totalBytes)
  })

  it('keeps offsets exact when multi-byte characters land near a chunk boundary', async () => {
    const f = join(dir, 'h.jsonl')
    const rowCount = 6000
    const glyphs = ['✅', '🔥', '中', '文', '🚀', 'あ']
    let content = ''
    const expectedOffsets: number[] = []
    const expectedUuids: string[] = []
    for (let i = 0; i < rowCount; i++) {
      const glyph = glyphs[i % glyphs.length]!
      const repeatCount = (i % 11) + 1
      const uuid = `mb-${i}-${glyph.repeat(repeatCount)}`
      const lineText = rowWithContent(uuid, glyph.repeat((i % 7) + 1))
      const lineWithNewline = `${lineText}\n`
      expectedOffsets.push(Buffer.byteLength(content))
      expectedUuids.push(uuid)
      content += lineWithNewline
    }
    const totalBytes = Buffer.byteLength(content)
    expect(totalBytes).toBeGreaterThan(512 * 1024)
    writeFileSync(f, content)

    const res = await streamRows(f)

    expect(res.rows).toHaveLength(rowCount)
    for (let i = 0; i < rowCount; i++) {
      expect(res.rows[i]!.byteOffset).toBe(expectedOffsets[i])
      expect((res.rows[i]!.row as { uuid: string }).uuid).toBe(expectedUuids[i])
    }
    expect(res.endOffset).toBe(totalBytes)
  })

  it('rejects with a descriptive error when a newline-free run exceeds the line-size limit', async () => {
    const f = join(dir, 'i.jsonl')
    const smallLimit = 1024
    const content = 'A'.repeat(smallLimit * 2)
    writeFileSync(f, content)

    await expect(streamRows(f, 0, 0, smallLimit)).rejects.toThrow(
      `Line exceeds maximum size of ${smallLimit} bytes at offset 0 in ${f}`
    )
  })

  it('exports MAX_LINE_BYTES as 64 MiB', () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024)
  })
})

describe('streamRange', () => {
  it('reads only the requested byte range', async () => {
    const f = join(dir, 'range.jsonl')
    const l1 = `${line('u1')}\n`, l2 = `${line('u2')}\n`, l3 = `${line('u3')}\n`
    writeFileSync(f, `${l1}${l2}${l3}`)
    const startOfL2 = Buffer.byteLength(l1)
    const endOfL2 = startOfL2 + Buffer.byteLength(l2) - 1
    const res = await streamRange(f, startOfL2, endOfL2)
    expect(res.rows.map(r => (r.row as { uuid: string }).uuid)).toEqual(['u2'])
    expect(res.rows[0]!.byteOffset).toBe(startOfL2)
  })

  it('reads to end of file when toOffset is omitted', async () => {
    const f = join(dir, 'range-open.jsonl')
    const l1 = `${line('u1')}\n`
    writeFileSync(f, `${l1}${line('u2')}\n`)
    const res = await streamRange(f, Buffer.byteLength(l1))
    expect(res.rows.map(r => (r.row as { uuid: string }).uuid)).toEqual(['u2'])
  })
})
