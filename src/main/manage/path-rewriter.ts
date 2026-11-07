import { normalizePath } from './paths'

/** Port of ClaudeMemoryTool's PathRewriter. Replaces every textual reference to
 *  `oldDir` (and anything under it) with `newDir`, keeping the spelling of each
 *  occurrence: JSON-escaped backslashes (once or twice), raw backslashes,
 *  forward slashes and MSYS (`/d/...`). A match only counts when the next char
 *  is not a letter, digit, '.', '_' or '-', so `D:\X` never hits `D:\X.com`,
 *  `D:\Xy` or `D:\Xé`. Known sibling folders whose name continues with other
 *  chars (e.g. "X Stuff", "X (copy)") are passed as `siblingSuffixes` and are
 *  excluded too. Case-insensitive. All forms are matched in a single pass, so
 *  replaced text is never rewritten again. */
export class PathRewriter {
  private readonly global: RegExp
  private readonly test: RegExp
  private readonly replacements: string[]

  /** @param siblingSuffixes Name tails of existing siblings of oldDir, e.g. " Stuff" for
   *  `D:\GIT\Old Stuff`. A hit followed by one of them (and then a non-name char) is left alone. */
  constructor(oldDir: string, newDir: string, siblingSuffixes: readonly string[] = []) {
    const oldForms = forms(normalizePath(oldDir))
    const newForms = forms(normalizePath(newDir))
    if (oldForms[2]!.length === 0) throw new Error('Old path is empty.')
    if (newForms[2]!.length === 0) throw new Error('New path is empty.')
    // New path has no drive letter (UNC): MSYS hits become forward-slash paths.
    newForms[MSYS_FORM] ??= newForms[3]!

    let boundary = `(?!${NAME_CHAR})`
    const seen = new Set<string>()
    const suffixes: string[] = []
    for (const s of siblingSuffixes) {
      if (s.length === 0 || seen.has(s.toLowerCase())) continue
      seen.add(s.toLowerCase())
      suffixes.push(s)
    }
    suffixes.sort((a, b) => b.length - a.length)
    if (suffixes.length > 0) boundary += `(?!(?:${suffixes.map(escapeRegex).join('|')})(?!${NAME_CHAR}))`

    // Most-escaped form first so a longer spelling wins over a shorter one at the same position.
    const parts: string[] = []
    const used = new Set<string>()
    const repl: string[] = []
    for (let i = 0; i < oldForms.length; i++) {
      const o = oldForms[i]
      const n = newForms[i]
      if (o == null || n == null) continue
      if (used.has(o)) continue
      used.add(o)
      const lookbehind = i === MSYS_FORM ? '(?<![A-Za-z0-9])' : ''
      parts.push(`${lookbehind}(?<f${repl.length}>${escapeRegex(o)})${boundary}`)
      repl.push(n)
    }
    this.replacements = repl
    const source = parts.join('|')
    this.global = new RegExp(source, 'giu')
    this.test = new RegExp(source, 'iu')
  }

  touches(text: string): boolean {
    return this.test.test(text)
  }

  rewrite = (text: string): string => {
    this.global.lastIndex = 0
    return text.replace(this.global, (...args: unknown[]) => {
      const groups = args[args.length - 1] as Record<string, string | undefined>
      for (let i = 0; i < this.replacements.length; i++) {
        if (groups[`f${i}`] !== undefined) return this.replacements[i]!
      }
      return args[0] as string
    })
  }
}

const NAME_CHAR = '[\\p{L}\\p{N}._\\-]'
const MSYS_FORM = 4

/** Escapes for a `u`-flag regex (where escaping a non-syntax char is an error). */
function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

/** [json-escaped twice, json-escaped once, raw backslash, forward slash, MSYS or null]. */
function forms(p: string): (string | null)[] {
  const fwd = p.replace(/\\/g, '/')
  const msys = p.length >= 2 && p[1] === ':' && /^[A-Za-z]$/.test(p[0]!)
    ? '/' + p[0]!.toLowerCase() + fwd.slice(2)
    : null
  return [
    p.replace(/\\/g, '\\\\\\\\'),
    p.replace(/\\/g, '\\\\'),
    p,
    fwd,
    msys
  ]
}
