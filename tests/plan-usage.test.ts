import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEvent } from '../src/main/engine/events'
import { PlanUsageTracker } from '../src/main/engine/plan-usage'
import { currentWindow, planLabel, showsPlan, NO_PLAN_USAGE } from '../src/shared/plan-usage'

// Shapes copied from Claude Code 2.1.316's real output on a Max plan.
const realEvent = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1793665800, rateLimitType: 'five_hour', overageStatus: 'allowed', isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.3, resetsAt: 1793665800, status: 'allowed' },
      seven_day: { utilization: 0.03, resetsAt: 1794254400, status: 'allowed' }
    }
  }
}
const realAnswer = {
  session: { total_cost_usd: 0 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 30, resets_at: '2026-11-03T00:30:00.000Z' }, seven_day: { utilization: 3, resets_at: '2026-11-09T20:00:00.000Z' } },
  behaviors: null
}
const beforeAnyReply = { ...realAnswer, rate_limits: null }
const apiKeyAnswer = { ...realAnswer, subscription_type: null, rate_limits_available: false, rate_limits: null }

describe('rate_limit_event', () => {
  it('reads both windows, as percents and epoch ms', () => {
    const e = parseEvent(JSON.stringify(realEvent))
    expect(e).toEqual({
      kind: 'rate_limit', status: 'allowed', resetsAt: 1793665800,
      reading: {
        fiveHour: { percent: 30, resetsAt: 1793665800000 },
        sevenDay: { percent: 3, resetsAt: 1794254400000 },
        usingExtra: false
      }
    })
  })

  it('falls back to the plain fields without unifiedWindows', () => {
    const e = parseEvent(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1000, rateLimitType: 'seven_day', utilization: 0.85 } }))
    expect(e).toMatchObject({ reading: { sevenDay: { percent: 85, resetsAt: 1000000 } } })
  })

  it('has no reading when it says nothing about usage', () => {
    const e = parseEvent(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 5 } }))
    expect(e).toEqual({ kind: 'rate_limit', status: 'allowed', resetsAt: 5 })
  })
})

describe('PlanUsageTracker', () => {
  it('takes the plan and windows from get_usage', () => {
    const t = new PlanUsageTracker(null, () => 77)
    t.applyAnswer(realAnswer)
    expect(t.get()).toMatchObject({ plan: 'max', limitsApply: true, updatedAt: 77, fiveHour: { percent: 30, resetsAt: Date.parse('2026-11-03T00:30:00.000Z') } })
  })

  it('keeps earlier readings when get_usage has no limits to give', () => {
    const t = new PlanUsageTracker(null)
    t.applyReading({ fiveHour: { percent: 42, resetsAt: 9 } })
    t.applyAnswer(beforeAnyReply)
    expect(t.get().plan).toBe('max')
    expect(t.get().fiveHour?.percent).toBe(42)
  })

  it('drops plan readings once the account turns out to be on an API key', () => {
    const t = new PlanUsageTracker(null)
    t.applyReading({ fiveHour: { percent: 42, resetsAt: 9 } })
    t.applyAnswer(apiKeyAnswer)
    expect(t.get()).toMatchObject({ plan: null, limitsApply: false, fiveHour: null })
    expect(showsPlan(t.get())).toBe(false)
  })

  it('tells listeners, and remembers across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-usage-'))
    try {
      const file = join(dir, 'plan.json')
      const t = new PlanUsageTracker(file)
      let told = 0
      t.onChange(() => { told++ })
      t.applyAnswer(realAnswer)
      expect(told).toBe(1)
      expect(new PlanUsageTracker(file).get().plan).toBe('max')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts empty when the saved file is missing or broken', () => {
    expect(new PlanUsageTracker(join(tmpdir(), 'no-such-plan-usage.json')).get()).toEqual(NO_PLAN_USAGE)
  })
})

describe('footer helpers', () => {
  it('a window past its reset time has started over', () => {
    expect(currentWindow({ percent: 90, resetsAt: 100 }, 100)).toEqual({ percent: 0, resetsAt: null })
    expect(currentWindow({ percent: 90, resetsAt: 100 }, 99)?.percent).toBe(90)
    expect(currentWindow(null, 0)).toBeNull()
  })

  it('names the plan', () => {
    expect(planLabel('max')).toBe('Max plan')
    expect(planLabel(null)).toBe('Plan usage')
  })

  it('shows the plan view on a plan or with readings, not otherwise', () => {
    expect(showsPlan(NO_PLAN_USAGE)).toBe(false)
    expect(showsPlan({ ...NO_PLAN_USAGE, plan: 'pro' })).toBe(true)
    expect(showsPlan({ ...NO_PLAN_USAGE, sevenDay: { percent: 1, resetsAt: null } })).toBe(true)
    expect(showsPlan({ ...NO_PLAN_USAGE, plan: null, limitsApply: false })).toBe(false)
  })
})
