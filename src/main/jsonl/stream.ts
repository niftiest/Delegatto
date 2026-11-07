import { createReadStream } from 'node:fs'
import { parseLine } from './parse'
import type { RawRow } from './rows'

export type StreamedRow = { row: RawRow; byteOffset: number; seq: number }
export type StreamResult = { rows: StreamedRow[]; endOffset: number; seqEnd: number }

const NEWLINE = 0x0a

export const MAX_LINE_BYTES = 64 * 1024 * 1024

export function streamRows(
  filePath: string,
  fromOffset = 0,
  seqStart = 0,
  maxLineBytes = MAX_LINE_BYTES
): Promise<StreamResult> {
  return readLines(filePath, fromOffset, seqStart, maxLineBytes)
}

/**
 * Read complete lines from a byte range. `toOffset` is inclusive, matching
 * createReadStream's `end`. Omit it to read to end of file.
 */
export function streamRange(
  filePath: string,
  fromOffset: number,
  toOffset?: number,
  seqStart = 0,
  maxLineBytes = MAX_LINE_BYTES
): Promise<StreamResult> {
  return readLines(filePath, fromOffset, seqStart, maxLineBytes, toOffset)
}

function readLines(
  filePath: string,
  fromOffset: number,
  seqStart: number,
  maxLineBytes: number,
  toOffset?: number
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const rows: StreamedRow[] = []
    let pending: Buffer = Buffer.alloc(0)
    let cursor = fromOffset
    let seq = seqStart
    let settled = false

    const stream = createReadStream(
      filePath,
      toOffset === undefined ? { start: fromOffset } : { start: fromOffset, end: toOffset }
    )

    stream.on('data', (chunk: string | Buffer) => {
      if (settled) return
      pending = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      let index: number
      while ((index = pending.indexOf(NEWLINE)) !== -1) {
        const lineBuf = pending.subarray(0, index)
        const row = parseLine(lineBuf.toString('utf8'))
        if (row !== null) rows.push({ row, byteOffset: cursor, seq: seq++ })
        cursor += lineBuf.length + 1
        pending = pending.subarray(index + 1)
      }
      if (pending.length > maxLineBytes) {
        settled = true
        stream.destroy()
        reject(new Error(`Line exceeds maximum size of ${maxLineBytes} bytes at offset ${cursor} in ${filePath}`))
      }
    })

    stream.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve({ rows, endOffset: cursor, seqEnd: seq })
    })
  })
}
