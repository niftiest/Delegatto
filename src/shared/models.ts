// Effort levels, cost estimates and image models. The Claude models the app offers aren't
// here: they come from Claude Code itself (see renderer/components/useClaudeModels.ts).

export type ModelOption = { value: string; label: string; hint: string }

/** For showing a model list: by name, newest version first within each. A label
 *  with no version comes first in its name. Claude Code's own order isn't either. */
export function sortModels<T extends { label: string }>(models: readonly T[]): T[] {
  const parts = (label: string): { name: string; version: number[] } => {
    const m = /^(.*?)\s+(\d+(?:\.\d+)*)/.exec(label)
    return { name: (m?.[1] ?? label).toLowerCase(), version: m?.[2]?.split('.').map(Number) ?? [Infinity] }
  }
  return [...models].sort((a, b) => {
    const x = parts(a.label), y = parts(b.label)
    if (x.name !== y.name) return x.name.localeCompare(y.name)
    for (let i = 0; i < Math.max(x.version.length, y.version.length); i++) {
      const diff = (y.version[i] ?? 0) - (x.version[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** What settings.json's effortLevel accepts. Claude Code silently drops 'max' there: it
 *  can only be chosen for a chat (--effort). */
export const SAVED_EFFORTS = EFFORTS.filter(e => e !== 'max')
export type Effort = (typeof EFFORTS)[number]

/** Wraps a user's plain subject description ("cute elk standing near a tree",
 *  "two playing cards") with only the FORMAT/SIZE requirements an avatar needs
 *  -- never any assumption about the content (no "single subject" etc.).
 *  Deliberately AVOIDS the word "icon", which nudges image models into drawing
 *  a small inset badge on a backdrop that then shows as a ring in the round
 *  avatar. It just demands a full-bleed square whose art reaches every edge. */
export function buildAvatarPrompt(subject: string): string {
  const s = subject.trim().replace(/[.\s]+$/, '')
  return `${s}. Square image that completely fills the frame edge to edge, with the artwork ` +
    `reaching all four corners. No border, no frame, no padding, no rounded corners, ` +
    `no transparent background, no text or watermark.`
}

/** A human price line for an image model from its live OpenRouter pricing:
 *  per-image when it prices that way, else per-million tokens. Shared by the
 *  settings panel and the at-generation model dropdowns. `info` is the
 *  ImageModelInfo shape (id/name + imageOutput/prompt/completion USD, any
 *  null). Kept here (not in a component) so it's one formatter, unit-tested. */
export function formatImagePrice(info: {
  imageOutput: number | null; prompt: number | null; completion: number | null
} | null): string {
  if (info === null) return 'price unavailable'
  const trim = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 })
  const parts: string[] = []
  if (info.imageOutput !== null && info.imageOutput > 0) parts.push(`$${trim(info.imageOutput)}/image`)
  if (info.completion !== null && info.completion > 0) parts.push(`$${trim(info.completion * 1_000_000)}/M out`)
  if (parts.length === 0 && info.prompt !== null && info.prompt > 0) parts.push(`$${trim(info.prompt * 1_000_000)}/M in`)
  return parts.length > 0 ? parts.join(' · ') : 'price unavailable'
}

/** OpenRouter image-generation models offered for AI chat avatars. NOTE: chat
 *  GPT models can't generate images -- these are the image-output models
 *  OpenRouter exposes (GPT image first, since that's the requested default). */
export const IMAGE_MODELS: ModelOption[] = [
  { value: 'openai/gpt-image-1', label: 'GPT Image 1', hint: 'OpenAI image model (recommended)' },
  { value: 'openai/gpt-image-2', label: 'GPT Image 2', hint: 'Newer OpenAI image model' },
  { value: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', hint: 'Fast + very cheap' },
  { value: 'black-forest-labs/flux.2-pro', label: 'FLUX.2 Pro', hint: 'High-quality diffusion' },
  { value: 'bytedance-seed/seedream-4.5', label: 'Seedream 4.5', hint: 'Alternative image model' }
]

/** Per-million-token USD list prices, for a rough in-app estimate rather than billing truth.
 *  `cacheWrite` is the one-hour rate, which is what Claude Code's own recorded costs match. */
export type Pricing = { input: number; output: number; cacheRead: number; cacheWrite: number }

const rates = (input: number, output: number, cacheRead: number, cacheWrite: number): Pricing => ({ input, output, cacheRead, cacheWrite })
const OPUS_4_5_TO_5 = rates(5, 25, 0.5, 10)
const OPUS_5_5 = rates(4, 20, 0.2, 8)
const OLD_OPUS = rates(15, 75, 1.5, 30)
const OLD_SONNET = rates(3, 15, 0.3, 6)
const SONNET_5 = rates(2, 10, 0.2, 4)
const SONNET_5_5 = rates(2, 10, 0.1, 4)
const HAIKU_5_5 = rates(0.1, 0.5, 0.01, 0.2)
const FABLE_5 = rates(10, 50, 1, 20)
const FABLE_5_1 = rates(10, 50, 0.25, 20)

/** Prices read from the installed Claude Code (main/engine/model-prices.ts). */
export type ModelPrices = { models: Record<string, Pricing>; newest: Record<string, Pricing> }

let livePrices: ModelPrices | null = null
/** Each process sets this once it has them. Until then, or if they can't be found, the table
 *  below is used: it's from Claude Code 2.1.318. */
export function setModelPrices(prices: ModelPrices | null): void {
  livePrices = prices
}

/** The newest of each name, which its alias means. A version with no price of its own is priced
 *  as this. */
const NEWEST: Record<string, Pricing> = { opus: OPUS_5_5, sonnet: SONNET_5_5, haiku: HAIKU_5_5, fable: FABLE_5_1 }

const PRICING: Record<string, Pricing> = {
  ...NEWEST,
  'claude-opus-4-0': OLD_OPUS,
  'claude-opus-4-1': OLD_OPUS,
  'claude-opus-4-5': OPUS_4_5_TO_5,
  'claude-opus-4-6': OPUS_4_5_TO_5,
  'claude-opus-4-7': OPUS_4_5_TO_5,
  'claude-opus-4-8': OPUS_4_5_TO_5,
  'claude-opus-5': OPUS_4_5_TO_5,
  'claude-opus-5-5': OPUS_5_5,
  'claude-3-5-sonnet': OLD_SONNET,
  'claude-3-7-sonnet': OLD_SONNET,
  'claude-sonnet-4-0': OLD_SONNET,
  'claude-sonnet-4-5': OLD_SONNET,
  'claude-sonnet-4-6': OLD_SONNET,
  'claude-sonnet-5': SONNET_5,
  'claude-sonnet-5-5': SONNET_5_5,
  'claude-3-5-haiku': rates(0.8, 4, 0.08, 1.6),
  'claude-haiku-4-5': rates(1, 5, 0.1, 2),
  'claude-haiku-5-5': HAIKU_5_5,
  'claude-fable-5': FABLE_5,
  'claude-fable-5-1': FABLE_5_1
}

/** A model's prices: its own, then its name's newest, then Opus for a name never seen. A dated
 *  or suffixed id ("claude-opus-5-5[1m]") counts as the longest id it starts with. */
export function resolveModelPricing(model: string | null | undefined): Pricing {
  const newest = livePrices?.newest ?? NEWEST
  const table = livePrices === null ? PRICING : { ...newest, ...livePrices.models }
  const opus = newest.opus ?? OPUS_5_5
  if (typeof model !== 'string' || model.length === 0) return opus
  if (table[model] !== undefined) return table[model]
  let best: Pricing | null = null
  let bestLen = -1
  for (const key of Object.keys(table)) {
    const p = table[key]
    if (p !== undefined && model.startsWith(key) && key.length > bestLen) { best = p; bestLen = key.length }
  }
  if (best !== null) return best
  const name = Object.keys(newest).find(n => model.includes(n))
  return name !== undefined ? newest[name]! : opus
}

/** Context-window size (tokens) for a model, for the context rail's fill bar.
 *  Haiku is 200k; the Opus/Sonnet/Fable generations are 1M. Longest-prefix
 *  match like pricing, defaulting to 200k (the conservative floor). */
export function contextWindowFor(model: string | null | undefined): number {
  if (typeof model === 'string') {
    if (model.startsWith('haiku') || model.startsWith('claude-haiku')) return 200_000
    if (/opus|sonnet|fable/.test(model)) return 1_000_000
  }
  return 200_000
}

export type SessionTokens = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

/** Approximate USD cost of a session's token usage at the given model's list
 *  price. Returns a plain number of dollars; the caller formats it. */
export function costOfSession(model: string | null | undefined, tokens: SessionTokens): number {
  const p = resolveModelPricing(model)
  const per = 1_000_000
  return (
    (tokens.inputTokens * p.input +
      tokens.outputTokens * p.output +
      tokens.cacheRead * p.cacheRead +
      tokens.cacheWrite * p.cacheWrite) /
    per
  )
}

/** Format a dollar amount for the header chip. Sub-cent costs read as
 *  "<$0.01" rather than "$0.00" so a cheap-but-nonzero chat isn't shown as
 *  free; every other amount shows exact cents with thousands separators
 *  (e.g. "$463.54", "$1,234.56") -- never rounded to whole dollars. */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Whole-dollar format for a headline TOTAL (no cents): "$3,232". A tiny but
 *  nonzero total shows "<$1" rather than "$0" so it doesn't read as free. */
export function formatCostWhole(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 1) return '<$1'
  return '$' + Math.round(usd).toLocaleString('en-US')
}
