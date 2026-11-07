import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { buildArgs, Transport, type ChildLike, type SpawnSpec } from '../src/main/engine/transport'
import type { LiveEvent } from '../src/shared/engine-types'

// ---------------------------------------------------------------------------
// buildArgs — pure function, TDD'd exhaustively
// ---------------------------------------------------------------------------

function baseSpec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return { cwd: 'C:\\work', skipPermissions: false, ...overrides }
}

describe('buildArgs — always-present flags', () => {
  it('always includes -p, stream-json in/out, partial messages, verbose', () => {
    const args = buildArgs(baseSpec())
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--replay-user-messages',
      '--include-hook-events',
      '--allow-dangerously-skip-permissions'
    ])
  })
})

describe('buildArgs — session identity', () => {
  it('sessionId set adds --session-id <uuid>', () => {
    const args = buildArgs(baseSpec({ sessionId: 'abc-123' }))
    expect(args).toContain('--session-id')
    expect(args[args.indexOf('--session-id') + 1]).toBe('abc-123')
  })

  it('resumeId set adds --resume <id> and never --fork-session', () => {
    const args = buildArgs(baseSpec({ resumeId: 'session-9' }))
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('session-9')
    expect(args).not.toContain('--fork-session')
  })

  it('neither sessionId nor resumeId adds nothing session-related', () => {
    const args = buildArgs(baseSpec())
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain('--resume')
  })

  it('throws when both sessionId and resumeId are set (mutually exclusive)', () => {
    expect(() => buildArgs(baseSpec({ sessionId: 'a', resumeId: 'b' }))).toThrow()
  })
})

describe('buildArgs — permissions', () => {
  it('skipPermissions:true adds --dangerously-skip-permissions', () => {
    const args = buildArgs(baseSpec({ skipPermissions: true }))
    expect(args).toContain('--dangerously-skip-permissions')
  })

  it('skipPermissions:false omits the flag entirely', () => {
    const args = buildArgs(baseSpec({ skipPermissions: false }))
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('permissionPromptTool set adds --permission-prompt-tool <name>', () => {
    const args = buildArgs(baseSpec({ permissionPromptTool: 'approve-bridge' }))
    expect(args).toContain('--permission-prompt-tool')
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('approve-bridge')
  })

  it('permissionPromptTool omitted adds nothing', () => {
    const args = buildArgs(baseSpec())
    expect(args).not.toContain('--permission-prompt-tool')
  })

  it('permissionMode set adds --permission-mode <mode>', () => {
    const args = buildArgs(baseSpec({ permissionMode: 'plan' }))
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  it('permissionMode omitted adds nothing', () => {
    const args = buildArgs(baseSpec())
    expect(args).not.toContain('--permission-mode')
  })
})

describe('buildArgs — model / effort passthrough', () => {
  it('model set adds --model <model>', () => {
    const args = buildArgs(baseSpec({ model: 'opus' }))
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
  })

  it('model omitted adds nothing', () => {
    const args = buildArgs(baseSpec())
    expect(args).not.toContain('--model')
  })

  it('effort set adds --effort <effort>', () => {
    const args = buildArgs(baseSpec({ effort: 'high' }))
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
  })

  it('effort omitted adds nothing', () => {
    const args = buildArgs(baseSpec())
    expect(args).not.toContain('--effort')
  })
})

describe('buildArgs — extraArgs', () => {
  it('extraArgs are appended verbatim at the end', () => {
    const args = buildArgs(baseSpec({ model: 'opus', extraArgs: ['--add-dir', 'C:\\other'] }))
    expect(args.slice(-2)).toEqual(['--add-dir', 'C:\\other'])
  })

  it('extraArgs omitted adds nothing extra', () => {
    const args = buildArgs(baseSpec())
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--replay-user-messages',
      '--include-hook-events',
      '--allow-dangerously-skip-permissions'
    ])
  })
})

describe('buildArgs — full combination', () => {
  it('assembles every flag together in a stable, complete argv', () => {
    const args = buildArgs({
      cwd: 'C:\\work',
      sessionId: 'sess-1',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      skipPermissions: true,
      permissionPromptTool: 'approve-bridge',
      extraArgs: ['--add-dir', 'C:\\other']
    })
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--replay-user-messages',
      '--include-hook-events',
      '--allow-dangerously-skip-permissions',
      '--session-id',
      'sess-1',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'default',
      '--dangerously-skip-permissions',
      '--permission-prompt-tool',
      'approve-bridge',
      '--add-dir',
      'C:\\other'
    ])
  })
})

// ---------------------------------------------------------------------------
// Transport — wraps an injected fake child (no real process spawned)
// ---------------------------------------------------------------------------

class FakeChild implements ChildLike {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  killCalls: Array<string | undefined> = []
  private emitter = new EventEmitter()

  kill(signal?: string): void {
    this.killCalls.push(signal)
  }

  on(event: 'exit', cb: (code: number | null) => void): void {
    this.emitter.on(event, cb)
  }

  // Test-only helpers -- not part of the ChildLike contract, but the
  // underlying emitter accepts any event name at runtime so Transport's
  // internal `.on('error', ...)` hardening can be exercised too.
  emitExit(code: number | null): void {
    this.emitter.emit('exit', code)
  }

  emitError(err: Error): void {
    this.emitter.emit('error', err)
  }
}

function makeTransport(spec: Partial<SpawnSpec> = {}): { transport: Transport; child: FakeChild; spawnArgs: { bin: string; args: string[]; cwd: string }[] } {
  const child = new FakeChild()
  const spawnArgs: { bin: string; args: string[]; cwd: string }[] = []
  const spawnFn = (bin: string, args: string[], cwd: string): ChildLike => {
    spawnArgs.push({ bin, args, cwd })
    return child
  }
  const transport = new Transport(baseSpec(spec), { claudeBin: 'claude', spawnFn })
  return { transport, child, spawnArgs }
}

const INIT_LINE =
  '{"type":"system","subtype":"init","cwd":"C:\\\\Users\\\\user\\\\.claude\\\\jobs\\\\f7ef5120\\\\tmp","session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41","tools":["Task","Bash"],"mcp_servers":[],"model":"claude-opus-5[1m]","permissionMode":"bypassPermissions","slash_commands":["build"],"agents":["claude"],"skills":["build"]}'

const DELTA_O_LINE =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"o"}},"session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41"}'

const DELTA_K_LINE =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"k"}},"session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41"}'

const RESULT_LINE =
  '{"is_error":false,"duration_api_ms":1334,"num_turns":1,"stop_reason":"end_turn","session_id":"7600a514-8300-4cef-b1c8-8b0cd8123e41","total_cost_usd":0.16828349999999997,"usage":{"input_tokens":2,"output_tokens":4},"result":"ok","type":"result","subtype":"success","duration_ms":1390,"uuid":"ce1033d1-7bd9-4186-ad42-34e7731c976f"}'

describe('Transport — start() spawns via injected spawnFn', () => {
  it('calls spawnFn with buildArgs(spec), claudeBin and cwd', () => {
    const { transport, spawnArgs } = makeTransport({ cwd: 'C:\\proj', model: 'opus' })
    transport.start()
    expect(spawnArgs).toHaveLength(1)
    expect(spawnArgs[0]?.bin).toBe('claude')
    expect(spawnArgs[0]?.cwd).toBe('C:\\proj')
    expect(spawnArgs[0]?.args).toEqual(buildArgs(baseSpec({ cwd: 'C:\\proj', model: 'opus' })))
  })
})

describe('Transport — stdout framing and event emission', () => {
  it('emits LiveEvents in order for whole-line chunks', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    transport.on((e) => events.push(e))
    transport.start()

    child.stdout.write(INIT_LINE + '\n')
    child.stdout.write(DELTA_O_LINE + '\n')
    child.stdout.write(DELTA_K_LINE + '\n')
    child.stdout.write(RESULT_LINE + '\n')

    expect(events).toEqual([
      {
        kind: 'init',
        sessionId: '7600a514-8300-4cef-b1c8-8b0cd8123e41',
        cwd: 'C:\\Users\\user\\.claude\\jobs\\f7ef5120\\tmp',
        model: 'claude-opus-5[1m]',
        permissionMode: 'bypassPermissions'
      },
      { kind: 'delta', text: 'o' },
      { kind: 'delta', text: 'k' },
      { kind: 'result', isError: false, costUsd: 0.16828349999999997, text: 'ok' }
    ])
  })

  it('reassembles a line split across two stdout chunks', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    transport.on((e) => events.push(e))
    transport.start()

    const splitPoint = Math.floor(RESULT_LINE.length / 2)
    child.stdout.write(RESULT_LINE.slice(0, splitPoint))
    // nothing should have parsed yet -- no newline seen
    expect(events).toEqual([])
    child.stdout.write(RESULT_LINE.slice(splitPoint) + '\n')

    expect(events).toEqual([{ kind: 'result', isError: false, costUsd: 0.16828349999999997, text: 'ok' }])
  })

  it('holds a trailing partial line without a newline and never emits it', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    transport.on((e) => events.push(e))
    transport.start()

    child.stdout.write(INIT_LINE + '\n')
    child.stdout.write(RESULT_LINE.slice(0, 10)) // no trailing newline, ever
    child.emitExit(0)

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('init')
  })

  it('drains multiple complete lines delivered in a single stdout chunk', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    transport.on((e) => events.push(e))
    transport.start()

    // One .write() call carrying two whole, newline-terminated lines --
    // exercises the `while (indexOf(NEWLINE) !== -1)` drain loop's ability
    // to emit more than one event per chunk, not just one per chunk.
    child.stdout.write(INIT_LINE + '\n' + DELTA_O_LINE + '\n')

    expect(events).toEqual([
      {
        kind: 'init',
        sessionId: '7600a514-8300-4cef-b1c8-8b0cd8123e41',
        cwd: 'C:\\Users\\user\\.claude\\jobs\\f7ef5120\\tmp',
        model: 'claude-opus-5[1m]',
        permissionMode: 'bypassPermissions'
      },
      { kind: 'delta', text: 'o' }
    ])
  })

  it('skips a malformed line but keeps framing subsequent lines', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    transport.on((e) => events.push(e))
    transport.start()

    child.stdout.write('not json at all\n')
    child.stdout.write(INIT_LINE + '\n')

    expect(events).toEqual([
      {
        kind: 'init',
        sessionId: '7600a514-8300-4cef-b1c8-8b0cd8123e41',
        cwd: 'C:\\Users\\user\\.claude\\jobs\\f7ef5120\\tmp',
        model: 'claude-opus-5[1m]',
        permissionMode: 'bypassPermissions'
      }
    ])
  })
})

describe('Transport — send()', () => {
  it('writes JSON.stringify(userMessage) + newline to stdin', () => {
    const { transport, child } = makeTransport()
    transport.start()
    const written: string[] = []
    child.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))

    transport.send({ type: 'user', message: { role: 'user', content: 'hello' } })

    expect(written.join('')).toBe(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n')
  })

  it('throws if send() is called before start()', () => {
    const { transport } = makeTransport()
    expect(() => transport.send({ type: 'user', message: { role: 'user', content: 'hi' } })).toThrow()
  })
})

describe('Transport — interrupt()', () => {
  const stdoutLine = (child: FakeChild, o: object): void => { child.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n')) }
  const stopped = { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }

  it('asks the process to stop instead of killing it', () => {
    const { transport, child } = makeTransport()
    transport.start()
    const written: string[] = []
    child.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))
    transport.interrupt()
    const sent = JSON.parse(written.join('')) as { type: string; request: { subtype: string } }
    expect(sent).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    expect(child.killCalls).toEqual([])
  })

  it("reports the stopped turn as interrupted, not as Claude Code's error", () => {
    const { transport, child } = makeTransport()
    transport.start()
    const events: LiveEvent[] = []
    transport.on(e => events.push(e))
    transport.interrupt()
    stdoutLine(child, stopped)
    expect(events).toEqual([{ kind: 'result', isError: false, costUsd: 0, text: '', interrupted: true }])
  })

  it('leaves a real error alone when nothing was interrupted', () => {
    const { transport, child } = makeTransport()
    transport.start()
    const events: LiveEvent[] = []
    transport.on(e => events.push(e))
    stdoutLine(child, stopped)
    expect(events[0]).toMatchObject({ kind: 'result', isError: true })
    expect(events[0]).not.toHaveProperty('interrupted')
  })

  it('only counts the next result: the turn after is back to normal', () => {
    const { transport, child } = makeTransport()
    transport.start()
    const events: LiveEvent[] = []
    transport.on(e => events.push(e))
    transport.interrupt()
    stdoutLine(child, stopped)
    stdoutLine(child, stopped)
    expect(events[1]).toMatchObject({ isError: true })
  })

  describe('a process that does not stop', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('is killed after a few seconds', () => {
      const { transport, child } = makeTransport()
      transport.start()
      transport.interrupt()
      vi.advanceTimersByTime(4999)
      expect(child.killCalls).toEqual([])
      vi.advanceTimersByTime(1)
      expect(child.killCalls).toHaveLength(1)
    })

    it('is left alone once the turn has stopped', () => {
      const { transport, child } = makeTransport()
      transport.start()
      transport.interrupt()
      stdoutLine(child, stopped)
      vi.advanceTimersByTime(60_000)
      expect(child.killCalls).toEqual([])
    })

    it('gets one deadline however many times Esc is pressed', () => {
      const { transport, child } = makeTransport()
      transport.start()
      transport.interrupt()
      vi.advanceTimersByTime(3000)
      transport.interrupt()
      vi.advanceTimersByTime(2000)
      expect(child.killCalls).toHaveLength(1)
    })
  })

  it('throws if interrupt() is called before start()', () => {
    const { transport } = makeTransport()
    expect(() => transport.interrupt()).toThrow()
  })
})

describe('Transport — close() (graceful shutdown)', () => {
  it('closes stdin (EOF) rather than hard-killing, so the CLI can clean up its lock', () => {
    const { transport, child } = makeTransport()
    transport.start()
    transport.close(50)
    expect(child.stdin.writableEnded).toBe(true) // stdin.end() called -> EOF to the child
    expect(child.killCalls).toEqual([]) // no kill yet -- the process is given a chance to exit
  })

  it('force-kills as a fallback if the process has not exited within graceMs', async () => {
    const { transport, child } = makeTransport()
    transport.start()
    transport.close(10)
    await new Promise(r => setTimeout(r, 30))
    expect(child.killCalls).toEqual([undefined]) // default signal (TerminateProcess on Windows)
  })

  it('does not force-kill if the process exits within graceMs', async () => {
    const { transport, child } = makeTransport()
    transport.start()
    transport.close(50)
    child.emitExit(0) // exits cleanly before the fallback fires
    await new Promise(r => setTimeout(r, 80))
    expect(child.killCalls).toEqual([]) // fallback timer was cleared on exit
  })

  it('is a safe no-op before start() and after exit', () => {
    const { transport, child } = makeTransport()
    expect(() => transport.close()).not.toThrow() // before start
    transport.start()
    child.emitExit(0)
    expect(() => transport.close()).not.toThrow() // after exit
    expect(child.killCalls).toEqual([])
  })
})

describe('Transport — onExit()', () => {
  it('fires with the exit code from the child', () => {
    const { transport, child } = makeTransport()
    const codes: Array<number | null> = []
    transport.onExit((code) => codes.push(code))
    transport.start()

    child.emitExit(0)

    expect(codes).toEqual([0])
  })

  it('fires with null when the child exits without a code', () => {
    const { transport, child } = makeTransport()
    const codes: Array<number | null> = []
    transport.onExit((code) => codes.push(code))
    transport.start()

    child.emitExit(null)

    expect(codes).toEqual([null])
  })
})

describe('Transport — hardening', () => {
  it('surfaces a spawn error (e.g. ENOENT) as an event and fires onExit(null), without throwing', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    const codes: Array<number | null> = []
    transport.on((e) => events.push(e))
    transport.onExit((code) => codes.push(code))

    expect(() => transport.start()).not.toThrow()
    expect(() => child.emitError(new Error('spawn claude ENOENT'))).not.toThrow()

    expect(codes).toEqual([null])
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('other')
  })

  it('does not double-fire onExit if both an error and an exit event arrive', () => {
    const { transport, child } = makeTransport()
    const codes: Array<number | null> = []
    transport.onExit((code) => codes.push(code))
    transport.start()

    child.emitError(new Error('boom'))
    child.emitExit(1)

    expect(codes).toEqual([null])
  })

  it('surfaces recent stderr on a non-zero exit via an emitted other event', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    transport.on((e) => events.push(e))
    transport.start()

    child.stderr.write('fatal: something broke\n')
    child.emitExit(1)

    const other = events.find((e) => e.kind === 'other')
    expect(other).toBeDefined()
  })

  it('does not emit a stderr-surfacing event on a clean zero exit with no stderr', () => {
    const { transport, child } = makeTransport()
    const events: LiveEvent[] = []
    transport.on((e) => events.push(e))
    transport.start()

    child.emitExit(0)

    expect(events).toEqual([])
  })
})

describe('Transport — does not import electron', () => {
  it('has no electron import in the module source', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../src/main/engine/transport.ts', import.meta.url), 'utf8')
    expect(/from\s+['"]electron/.test(src)).toBe(false)
  })
})
