import { createReadStream, promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'

/** Reading transcripts for sync. Claude Code appends one JSON row per line, and a
 *  line still being written has no newline yet, so only complete lines are ever taken.
 *  Rows are compared by their ids rather than their text, because path rewriting and
 *  redaction change the text of the same row. */

const NL = 0x0a

export type TranscriptRow = { text: string; endOffset: number }

/** Complete lines from `offset` on, streamed so a large chat doesn't sit in memory. */
export async function* readRows(file: string, offset = 0): AsyncGenerator<TranscriptRow> {
  const stream = createReadStream(file, { start: offset, highWaterMark: 1 << 20 })
  let position = offset
  let held: Buffer[] = []
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(NL, start)
        if (nl < 0) break
        const piece = chunk.subarray(start, nl)
        const line = held.length === 0 ? piece : Buffer.concat([...held, piece])
        held = []
        position += piece.length + 1
        const end = position
        start = nl + 1
        if (line.length > 0) yield { text: line.toString('utf8').replace(/\r$/, ''), endOffset: end }
      }
      if (start < chunk.length) {
        const rest = Buffer.from(chunk.subarray(start))
        held.push(rest)
        position += rest.length
      }
    }
  } finally {
    stream.destroy()
  }
}

/** The same row on any PC gets the same key, whatever its paths say. */
export function rowKey(text: string): string {
  try {
    const row = JSON.parse(text) as Record<string, unknown>
    if (typeof row.uuid === 'string') return row.uuid
    const type = typeof row.type === 'string' ? row.type : ''
    const id = row.messageId ?? row.leafUuid ?? row.timestamp ?? row.customTitle ?? row.aiTitle ?? ''
    return `${type}:${String(id)}`
  } catch {
    return `raw:${createHash('sha1').update(text).digest('hex')}`
  }
}

/** The key of the line that ends at `offset`, without reading the whole file. */
export async function keyEndingAt(file: string, offset: number): Promise<string | null> {
  if (offset <= 0) return null
  const handle = await fsp.open(file, 'r')
  try {
    const size = (await handle.stat()).size
    if (offset > size) return null
    let end = offset - 1 // the newline that closes the line
    const parts: Buffer[] = []
    const step = 1 << 20
    while (end > 0) {
      const start = Math.max(0, end - step)
      const buffer = Buffer.alloc(end - start)
      await handle.read(buffer, 0, buffer.length, start)
      const nl = buffer.lastIndexOf(NL)
      if (nl >= 0) {
        parts.unshift(buffer.subarray(nl + 1))
        break
      }
      parts.unshift(buffer)
      end = start
    }
    return rowKey(Buffer.concat(parts).toString('utf8').replace(/\r$/, ''))
  } finally {
    await handle.close()
  }
}

/** Where row number `rows` ends, if the file really has those rows. */
export async function locateRow(file: string, rows: number, expectedKey: string | null): Promise<number | null> {
  if (rows === 0) return 0
  let count = 0
  for await (const row of readRows(file)) {
    count++
    if (count === rows) return expectedKey === null || rowKey(row.text) === expectedKey ? row.endOffset : null
  }
  return null
}

const TEXT_FILE = /\.(?:jsonl?|txt|md|log|csv|ya?ml|xml|html?)$/i

/** Files whose text can hold paths, and is safe to edit. */
export function isTextFile(name: string): boolean {
  return TEXT_FILE.test(name)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSessionId(id: string): boolean {
  return UUID.test(id)
}
