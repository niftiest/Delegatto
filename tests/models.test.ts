import { describe, it, expect } from 'vitest'
import {
  EFFORTS, sortModels, resolveModelPricing, costOfSession, formatCost, formatCostWhole, contextWindowFor,
  buildAvatarPrompt, formatImagePrice
} from '../src/shared/models'

describe('model catalog', () => {
  it('lists the five effort levels in ascending order', () => {
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('resolveModelPricing', () => {
  it('matches an exact alias', () => {
    expect(resolveModelPricing('opus').input).toBe(4)
    expect(resolveModelPricing('sonnet').input).toBe(2)
    expect(resolveModelPricing('haiku').output).toBe(0.5)
    expect(resolveModelPricing('fable').input).toBe(10)
  })

  it('resolves a dated snapshot id by longest-prefix to its family', () => {
    // claude-opus-4-8-20260101 → the 'claude-opus-4-8' family, not bare opus
    expect(resolveModelPricing('claude-opus-4-8-20260101')).toEqual(resolveModelPricing('claude-opus-4-8'))
    expect(resolveModelPricing('claude-sonnet-4-6-20260101').input).toBe(3)
  })

  it('tells versions of the same name apart', () => {
    expect(resolveModelPricing('claude-opus-5').input).toBe(5)
    expect(resolveModelPricing('claude-opus-5-5').input).toBe(4)
    expect(resolveModelPricing('claude-opus-5-5[1m]').input).toBe(4)
    expect(resolveModelPricing('claude-opus-4-1').input).toBe(15)
    expect(resolveModelPricing('claude-haiku-4-5-20251001').input).toBe(1)
    expect(resolveModelPricing('claude-haiku-5-5').input).toBe(0.1)
    expect(resolveModelPricing('claude-sonnet-5').cacheRead).toBe(0.2)
    expect(resolveModelPricing('claude-sonnet-5-5').cacheRead).toBe(0.1)
  })

  it('prices a version it has never seen as the newest of its name', () => {
    expect(resolveModelPricing('claude-haiku-9')).toEqual(resolveModelPricing('haiku'))
    expect(resolveModelPricing('claude-sonnet-7-2')).toEqual(resolveModelPricing('sonnet'))
    expect(resolveModelPricing('claude-fable-8')).toEqual(resolveModelPricing('fable'))
  })

  it('falls back to Opus rates for unknown/absent models', () => {
    const opus = resolveModelPricing('opus')
    expect(resolveModelPricing(null)).toEqual(opus)
    expect(resolveModelPricing(undefined)).toEqual(opus)
    expect(resolveModelPricing('')).toEqual(opus)
    expect(resolveModelPricing('some-future-model')).toEqual(opus)
  })
})

describe('costOfSession', () => {
  it('sums every token bucket at the model rate (per MTok)', () => {
    // 1M input @ $4 + 1M output @ $20 + 1M cacheRead @ $0.2 + 1M cacheWrite @ $8 = $32.20
    const cost = costOfSession('opus', {
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000
    })
    expect(cost).toBeCloseTo(32.2, 5)
  })

  it('is zero for a session with no tokens', () => {
    expect(costOfSession('sonnet', { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0)
  })

  it('scales linearly and uses the given model rate', () => {
    const half = costOfSession('haiku', { inputTokens: 500_000, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })
    expect(half).toBeCloseTo(0.05, 5) // 0.5M @ $0.10/MTok
  })
})

describe('formatCost', () => {
  it('shows exactly free as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00')
  })
  it('shows sub-cent nonzero as <$0.01', () => {
    expect(formatCost(0.003)).toBe('<$0.01')
  })
  it('shows exact cents', () => {
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(42.007)).toBe('$42.01')
    expect(formatCost(463.54)).toBe('$463.54')
  })
  it('keeps cents and adds thousands separators for large amounts', () => {
    expect(formatCost(1234.56)).toBe('$1,234.56')
  })
})

describe('buildAvatarPrompt', () => {
  it('wraps the subject with format-only styling and avoids the word "icon"', () => {
    const p = buildAvatarPrompt('cute elk standing near a tree')
    expect(p.startsWith('cute elk standing near a tree.')).toBe(true)
    expect(p).toMatch(/fills the frame edge to edge/i)
    expect(p).toMatch(/no border/i)
    expect(p.toLowerCase()).not.toContain('icon') // "icon" triggers inset app-badge renders
    expect(p.toLowerCase()).not.toContain('single') // must not assume one subject (e.g. two playing cards)
  })
  it('trims trailing punctuation/space so the subject reads cleanly', () => {
    expect(buildAvatarPrompt('a red panda...  ')).toMatch(/^a red panda\. /)
  })
})

describe('formatImagePrice', () => {
  it('prefers per-image, else per-million-token, else unavailable', () => {
    expect(formatImagePrice({ imageOutput: 0.04, prompt: null, completion: null })).toBe('$0.04/image')
    expect(formatImagePrice({ imageOutput: null, prompt: 0.00001, completion: 0.00001 })).toBe('$10/M out')
    expect(formatImagePrice({ imageOutput: null, prompt: 0.000005, completion: null })).toBe('$5/M in')
    expect(formatImagePrice({ imageOutput: null, prompt: null, completion: null })).toBe('price unavailable')
    expect(formatImagePrice(null)).toBe('price unavailable')
  })
})

describe('contextWindowFor', () => {
  it('is 1M for opus/sonnet/fable and 200k for haiku, defaulting to 200k', () => {
    expect(contextWindowFor('opus')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000)
    expect(contextWindowFor('fable')).toBe(1_000_000)
    expect(contextWindowFor('haiku')).toBe(200_000)
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000)
    expect(contextWindowFor(null)).toBe(200_000)
  })
})

describe('formatCostWhole', () => {
  it('rounds to whole dollars with thousands separators, no cents', () => {
    expect(formatCostWhole(3232.26)).toBe('$3,232')
    expect(formatCostWhole(3232.99)).toBe('$3,233')
    expect(formatCostWhole(42)).toBe('$42')
  })
  it('shows $0 for zero and <$1 for a tiny nonzero total', () => {
    expect(formatCostWhole(0)).toBe('$0')
    expect(formatCostWhole(0.4)).toBe('<$1')
  })
})

describe('sortModels', () => {
  const labels = (l: string[]) => sortModels(l.map(label => ({ label }))).map(m => m.label)

  it("sorts Claude Code's list by name, newest version first", () => {
    expect(labels(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5', 'Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6']))
      .toEqual(['Fable 5.1', 'Fable 5', 'Haiku 5.5', 'Haiku 4.5', 'Opus 5.5', 'Opus 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 5.5', 'Sonnet 5', 'Sonnet 4.6'])
  })

  it('compares versions as numbers, not text', () => {
    expect(labels(['Opus 4.9', 'Opus 4.10'])).toEqual(['Opus 4.10', 'Opus 4.9'])
  })

  it('keeps a label with extra words beside its version, and copes with none', () => {
    expect(labels(['Opus 5', 'Opus', 'Opus 5.5 (1M context)', 'Custom'])).toEqual(['Custom', 'Opus', 'Opus 5.5 (1M context)', 'Opus 5'])
  })

  it("doesn't change the list it was given", () => {
    const list = [{ label: 'Opus 5' }, { label: 'Fable 5' }]
    sortModels(list)
    expect(list[0]!.label).toBe('Opus 5')
  })
})
