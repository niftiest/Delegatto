import { readFileSync } from 'node:fs'
import { atomicWriteText } from './safe-file'

/** `~/.claude.json` loaded as a mutable object; `save` writes it back atomically
 *  in Claude's style (2-space indent, '\n', non-ASCII unescaped, trailing newline
 *  kept). Port of ClaudeMemoryTool's ClaudeJsonFile.
 *
 *  JavaScript numbers can't hold integers past 2^53 exactly, and a silent
 *  rounding would corrupt the file on save -- so `load` refuses (leaving the
 *  file untouched) when the text contains such a number. */
export type ClaudeJson = { root: Record<string, unknown>; trailingNewline: boolean }

export class ClaudeJsonError extends Error {}

export function loadClaudeJson(path: string): ClaudeJson {
  const bytes = readFileSync(path) // fs errors (missing, locked) propagate as-is
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ClaudeJsonError('.claude.json is not valid UTF-8; left unchanged.')
  }
  if (text.startsWith('﻿')) text = text.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new ClaudeJsonError(`.claude.json could not be parsed; left unchanged. ${(e as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ClaudeJsonError('.claude.json is not a JSON object; left unchanged.')
  }
  if (hasUnsafeNumber(text)) {
    throw new ClaudeJsonError('.claude.json holds a number too large to rewrite exactly; left unchanged.')
  }
  return { root: parsed as Record<string, unknown>, trailingNewline: text.endsWith('\n') }
}

export function saveClaudeJson(path: string, f: ClaudeJson): void {
  atomicWriteText(path, JSON.stringify(f.root, null, 2) + (f.trailingNewline ? '\n' : ''))
}

/** True when the JSON text has a numeric literal that wouldn't round-trip
 *  through a JS number (an integer part past 2^53, or more than 15 significant
 *  digits). Skips string contents. */
export function hasUnsafeNumber(text: string): boolean {
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]!
    if (c === '"') {
      i++
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(\d+)(?:\.(\d+))?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400))
      if (m) {
        const digits = (m[1]! + (m[2] ?? '')).replace(/^0+/, '')
        if (digits.length > 15) {
          // Exact if JS formats it back to the same literal.
          if (String(Number(m[0])) !== m[0]) return true
        }
        i += m[0].length
        continue
      }
    }
    i++
  }
  return false
}
