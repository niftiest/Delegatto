import { describe, it, expect, vi } from 'vitest'
import {
  buildPermissionResult,
  parsePermissionArgs,
  allowAlwaysRule,
  PermissionBridge
} from '../src/main/engine/permission-bridge'
import type { PermissionDecision } from '../src/shared/engine-types'

const ask = (bridge: PermissionBridge, args: unknown, key: string) => bridge.handleRequest(args, key).answer

// ---------------------------------------------------------------------------
// buildPermissionResult -- the DOCUMENTED response contract, pinned exactly
// ---------------------------------------------------------------------------

describe('buildPermissionResult', () => {
  it('allow with no updatedInput falls back to the original input', () => {
    const decision: PermissionDecision = { behavior: 'allow' }
    const result = buildPermissionResult(decision, { command: 'ls' })
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  it('allow with updatedInput uses the edited input verbatim', () => {
    const decision: PermissionDecision = { behavior: 'allow', updatedInput: { command: 'ls -la' } }
    const result = buildPermissionResult(decision, { command: 'ls' })
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } })
  })

  it('deny carries behavior+message and no updatedInput field', () => {
    const decision: PermissionDecision = { behavior: 'deny', message: 'not allowed' }
    const result = buildPermissionResult(decision, { command: 'rm -rf /' })
    expect(result).toEqual({ behavior: 'deny', message: 'not allowed' })
    expect('updatedInput' in result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parsePermissionArgs -- tolerant parse of the UNDOCUMENTED request shape
// ---------------------------------------------------------------------------

describe('parsePermissionArgs', () => {
  it('full shape -> full request', () => {
    const req = parsePermissionArgs(
      { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_01' },
      'id-1',
      'session-a'
    )
    expect(req).toEqual({ id: 'id-1', tool: 'Bash', input: { command: 'ls' }, sessionKey: 'session-a', toolUseId: 'toolu_01' })
  })

  it('missing tool_use_id -> field omitted, not undefined-valued', () => {
    const req = parsePermissionArgs({ tool_name: 'Read', input: { file_path: 'a.txt' } }, 'id-2', 'session-a')
    expect('toolUseId' in req).toBe(false)
    expect(req.tool).toBe('Read')
  })

  it('missing tool_name -> defensible fallback, does not throw', () => {
    expect(() => parsePermissionArgs({ input: { command: 'x' } }, 'id-3', 'session-a')).not.toThrow()
    const req = parsePermissionArgs({ input: { command: 'x' } }, 'id-3', 'session-a')
    expect(req.tool).toBe('unknown')
  })

  it('junk / non-object args -> defensible non-throwing result', () => {
    expect(() => parsePermissionArgs(null, 'id-4', 'session-a')).not.toThrow()
    expect(() => parsePermissionArgs('garbage', 'id-5', 'session-a')).not.toThrow()
    expect(() => parsePermissionArgs(42, 'id-6', 'session-a')).not.toThrow()
    expect(() => parsePermissionArgs(undefined, 'id-7', 'session-a')).not.toThrow()

    const req = parsePermissionArgs(null, 'id-4', 'session-a')
    expect(req.id).toBe('id-4')
    expect(req.tool).toBe('unknown')
    expect(req.sessionKey).toBe('session-a')
  })

  it('logs unknown fields but does not fail on them', () => {
    const req = parsePermissionArgs(
      { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_01', some_future_field: 'xyz' },
      'id-8',
      'session-a'
    )
    expect(req.tool).toBe('Bash')
  })
})

// ---------------------------------------------------------------------------
// allowAlwaysRule
// ---------------------------------------------------------------------------

describe('allowAlwaysRule', () => {
  it('Bash command -> Tool(command-prefix *) style rule', () => {
    expect(allowAlwaysRule('Bash', { command: 'npx playwright test' })).toBe('Bash(npx playwright *)')
    expect(allowAlwaysRule('Bash', { command: 'npm run build' })).toBe('Bash(npm run *)')
  })

  it('Bash single-token command still wildcards', () => {
    expect(allowAlwaysRule('Bash', { command: 'ls' })).toBe('Bash(ls *)')
  })

  it('Bash with no command input falls back to bare tool name', () => {
    expect(allowAlwaysRule('Bash', {})).toBe('Bash')
    expect(allowAlwaysRule('Bash', null)).toBe('Bash')
  })

  it('Read/Edit with a path -> path-scoped rule', () => {
    expect(allowAlwaysRule('Read', { file_path: './.env' })).toBe('Read(./.env)')
    expect(allowAlwaysRule('Edit', { file_path: 'src/index.ts' })).toBe('Edit(src/index.ts)')
  })

  it('Read/Edit with no path -> bare tool name', () => {
    expect(allowAlwaysRule('Read', {})).toBe('Read')
  })

  it('unknown tool -> bare tool name', () => {
    expect(allowAlwaysRule('WebFetch', { url: 'https://example.com' })).toBe('WebFetch')
  })
})

// ---------------------------------------------------------------------------
// PermissionBridge -- parking coordinator
// ---------------------------------------------------------------------------

describe('PermissionBridge', () => {
  it('a request parks and does not resolve until resolve() is called', async () => {
    const bridge = new PermissionBridge()
    let settled = false
    const promise = ask(bridge, { tool_name: 'Bash', input: { command: 'ls' } }, 'session-a')
    void promise.then(() => {
      settled = true
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
  })

  it('onRequest fires with the parsed request and a stable id; resolve() completes with the right answer', async () => {
    const bridge = new PermissionBridge()
    let seenId = ''
    bridge.onRequest((req) => {
      expect(req.tool).toBe('Bash')
      expect(req.sessionKey).toBe('session-a')
      seenId = req.id
    })

    const promise = ask(bridge, { tool_name: 'Bash', input: { command: 'ls' } }, 'session-a')
    expect(seenId).not.toBe('')

    bridge.resolve(seenId, { behavior: 'allow' })
    const result = await promise
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  it('deny decision resolves to a deny', async () => {
    const bridge = new PermissionBridge()
    let seenId = ''
    bridge.onRequest((req) => {
      seenId = req.id
    })
    const promise = ask(bridge, { tool_name: 'Bash', input: { command: 'rm -rf /' } }, 'session-a')
    bridge.resolve(seenId, { behavior: 'deny', message: 'nope' })
    const result = await promise
    expect(result).toEqual({ behavior: 'deny', message: 'nope' })
  })

  it('two concurrent requests get distinct ids and resolve independently', async () => {
    const bridge = new PermissionBridge()
    const ids: string[] = []
    bridge.onRequest((req) => ids.push(req.id))

    const p1 = ask(bridge, { tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    const p2 = ask(bridge, { tool_name: 'Bash', input: { command: 'b' } }, 'session-a')

    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])

    bridge.resolve(ids[1] as string, { behavior: 'allow' })
    const r2 = await p2
    expect(r2).toEqual({ behavior: 'allow', updatedInput: { command: 'b' } })

    // p1 still parked -- only resolving p2 must not have resolved it.
    let p1Settled = false
    void p1.then(() => {
      p1Settled = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(p1Settled).toBe(false)

    bridge.resolve(ids[0] as string, { behavior: 'deny', message: 'no' })
    const r1 = await p1
    expect(r1).toEqual({ behavior: 'deny', message: 'no' })
  })

  it('resolving an unknown id is a safe no-op', () => {
    const bridge = new PermissionBridge()
    expect(() => bridge.resolve('never-existed', { behavior: 'allow' })).not.toThrow()
  })

  it('resolving the same id twice is a safe no-op the second time', async () => {
    const bridge = new PermissionBridge()
    let seenId = ''
    bridge.onRequest((req) => {
      seenId = req.id
    })
    const promise = ask(bridge, { tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    bridge.resolve(seenId, { behavior: 'allow' })
    expect(() => bridge.resolve(seenId, { behavior: 'deny', message: 'too late' })).not.toThrow()
    const result = await promise
    // First resolve wins -- the second (unknown-id-by-then) call is a no-op.
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'a' } })
  })

  it('a request unresolved by the configured timeout resolves to deny, not hang', async () => {
    const bridge = new PermissionBridge({ timeoutMs: 20 })
    const promise = ask(bridge, { tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    const result = await promise
    const parsed = result
    expect(parsed.behavior).toBe('deny')
    expect(typeof parsed.message).toBe('string')
  })

  it('shutdown() denies every still-parked request', async () => {
    const bridge = new PermissionBridge()
    const p1 = ask(bridge, { tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    const p2 = ask(bridge, { tool_name: 'Bash', input: { command: 'b' } }, 'session-a')

    bridge.shutdown()

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.behavior).toBe('deny')
    expect(r2.behavior).toBe('deny')
  })

  it('a request after shutdown() denies immediately rather than parking', async () => {
    const bridge = new PermissionBridge()
    bridge.shutdown()
    const result = await ask(bridge, { tool_name: 'Bash', input: { command: 'a' } }, 'session-a')
    expect(result.behavior).toBe('deny')
  })

  it('toolName defaults to approve and is overridable', () => {
    expect(new PermissionBridge().toolName).toBe('approve')
    expect(new PermissionBridge({ toolName: 'custom' }).toolName).toBe('custom')
  })
})

describe('requests from Claude Code', () => {
  it('keeps what Claude Code says about a request', () => {
    const req = parsePermissionArgs({
      tool_name: 'Bash', input: {}, title: 'Run ls', description: 'Lists files', decision_reason: 'Matched an ask rule', blocked_path: 'C:\\x',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' }, 'junk']
    }, 'perm-1', 'session-a')
    expect(req).toMatchObject({ title: 'Run ls', description: 'Lists files', reason: 'Matched an ask rule', blockedPath: 'C:\\x' })
    expect(req.suggestions).toHaveLength(1)
  })

  it('passes on "do not ask again" with an allow', () => {
    const updatedPermissions = [{ type: 'addRules' }]
    expect(buildPermissionResult({ behavior: 'allow', updatedPermissions }, { a: 1 })).toEqual({ behavior: 'allow', updatedInput: { a: 1 }, updatedPermissions })
    expect(buildPermissionResult({ behavior: 'allow', updatedPermissions: [] }, { a: 1 })).toEqual({ behavior: 'allow', updatedInput: { a: 1 } })
  })

  it('can be cancelled once, and an answer after that does nothing', async () => {
    const bridge = new PermissionBridge({ timeoutMs: 0 })
    const { id, answer } = bridge.handleRequest({ tool_name: 'Bash', input: {} }, 'session-a')
    expect(bridge.cancel(id)).toBe(true)
    expect((await answer).behavior).toBe('deny')
    expect(bridge.cancel(id)).toBe(false)
    expect(() => bridge.resolve(id, { behavior: 'allow' })).not.toThrow()
  })
})
