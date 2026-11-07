import { createHash } from 'node:crypto'
import type { SecretConfidence, SecretFinding } from '../../shared/sync-types'

/** Finds likely keys and passwords in chat text. Known key formats are reliable. A
 *  random-looking value next to a word like "password" is only "possible". A key in a
 *  screenshot, or a password that looks like an ordinary word, can't be found at all,
 *  which is why sync also encrypts. */

type Rule = { name: string; confidence: SecretConfidence; pattern: RegExp; group?: number; minEntropy: number }

const RULES: Rule[] = [
  { name: 'Anthropic API key', confidence: 'definite', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, minEntropy: 3 },
  { name: 'OpenRouter API key', confidence: 'definite', pattern: /\bsk-or-v\d-[A-Za-z0-9]{20,}/g, minEntropy: 3 },
  { name: 'OpenAI API key', confidence: 'definite', pattern: /\bsk-(?:proj-|svcacct-)?(?!ant-|or-)[A-Za-z0-9_-]{32,}/g, minEntropy: 3.2 },
  { name: 'GitHub token', confidence: 'definite', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g, minEntropy: 3 },
  { name: 'AWS access key', confidence: 'definite', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, minEntropy: 2.5 },
  { name: 'Slack token', confidence: 'definite', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g, minEntropy: 3 },
  { name: 'Google API key', confidence: 'definite', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, minEntropy: 3 },
  { name: 'Stripe key', confidence: 'definite', pattern: /\b[sr]k_live_[0-9A-Za-z]{20,}/g, minEntropy: 3 },
  { name: 'Private key', confidence: 'definite', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g, minEntropy: 0 },
  { name: 'Login token (JWT)', confidence: 'definite', pattern: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g, minEntropy: 3.5 },
  { name: 'Password in a web address', confidence: 'possible', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'\\]+:([^\s@/"'\\]{6,})@/gi, group: 1, minEntropy: 2.5 },
  {
    name: 'Password or key',
    confidence: 'possible',
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|access[_-]?key|client[_-]?secret)\b(?:\\*["'])?\s*(?:[:=]|=>)\s*(?:\\*["'])?([A-Za-z0-9+/_.!@#$%^&*~-]{12,})/gi,
    group: 1,
    minEntropy: 3.4
  }
]

/** Words that mark an example rather than a real value. */
const PLACEHOLDER = /(?:xxx|\.\.\.|\*\*\*|example|sample|placeholder|changeme|your[_-]?|<|>|\$\{|process\.env|undefined|null\b|true\b|false\b|redacted|dummy|fake|test[_-]?key|abcdef|123456)/i

/** Longer than any key. Pictures are base64 inside a transcript, can run to many megabytes
 *  in a single row, and could match by accident. */
const LONG_RUN = 2048
const IMAGE_MARK = /"type"\s*:\s*"image"/g

export type RawFinding = {
  fingerprint: string
  rule: string
  confidence: SecretConfidence
  masked: string
  context: string
  secret: string
}

function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

export function fingerprintOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 24)
}

function mask(secret: string): string {
  if (secret.length <= 8) return '•'.repeat(secret.length)
  return `${secret.slice(0, 4)}…${secret.slice(-2)}`
}

function isTokenChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 43 || code === 47 || code === 61 || code === 95 || code === 45
}

/** The text without its very long unbroken runs. A plain loop, because a pattern
 *  matching a run this long overflows the stack. */
function withoutLongRuns(text: string): string {
  if (text.length < LONG_RUN) return text
  const parts: string[] = []
  let kept = 0
  let run = 0
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && isTokenChar(text.charCodeAt(i))) { run++; continue }
    if (run >= LONG_RUN) {
      parts.push(text.slice(kept, i - run))
      kept = i
    }
    run = 0
  }
  if (kept === 0) return text
  parts.push(text.slice(kept))
  return parts.join('')
}

/** Every likely secret in one line of text. */
export function scanText(text: string): RawFinding[] {
  const clean = withoutLongRuns(text)
  const found: RawFinding[] = []
  const seen = new Set<string>()
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    for (const match of clean.matchAll(rule.pattern)) {
      const secret = rule.group === undefined ? match[0] : match[rule.group]
      if (secret === undefined) continue
      if (rule.minEntropy > 0 && (entropy(secret) < rule.minEntropy || PLACEHOLDER.test(secret))) continue
      if (seen.has(secret)) continue
      seen.add(secret)
      const at = match.index ?? 0
      found.push({
        fingerprint: fingerprintOf(secret),
        rule: rule.name,
        confidence: rule.confidence,
        masked: mask(secret),
        context: contextOf(clean, at, match[0].length, secret),
        secret
      })
    }
  }
  return found
}

function contextOf(text: string, at: number, length: number, secret: string): string {
  const from = Math.max(0, at - 40)
  const to = Math.min(text.length, at + length + 40)
  let snippet = text.slice(from, to).split(secret).join(mask(secret))
  // Whatever else is close by could be a secret too.
  for (const rule of RULES) {
    if (rule.confidence === 'definite') snippet = snippet.replace(rule.pattern, '•••')
  }
  return snippet.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function countImages(text: string): number {
  if (!text.includes('"image"')) return 0
  return text.match(IMAGE_MARK)?.length ?? 0
}

/** The text with these secrets replaced. Safe inside JSON: the replacement needs no escaping. */
export function redactSecrets(text: string, secrets: Iterable<RawFinding>): string {
  let out = text
  for (const f of secrets) out = out.split(f.secret).join(`[REDACTED ${f.rule}]`)
  return out
}

/** Adds what a scan found to a running list, one entry per secret. */
export function mergeFinding(list: Map<string, SecretFinding>, f: RawFinding, where: { sessionId?: string; file?: string }): void {
  const existing = list.get(f.fingerprint)
  if (existing === undefined) {
    list.set(f.fingerprint, {
      fingerprint: f.fingerprint, rule: f.rule, confidence: f.confidence, masked: f.masked, context: f.context,
      sessionIds: where.sessionId === undefined ? [] : [where.sessionId],
      files: where.file === undefined ? [] : [where.file],
      count: 1
    })
    return
  }
  existing.count++
  if (where.sessionId !== undefined && !existing.sessionIds.includes(where.sessionId)) existing.sessionIds.push(where.sessionId)
  if (where.file !== undefined && !existing.files.includes(where.file)) existing.files.push(where.file)
}
