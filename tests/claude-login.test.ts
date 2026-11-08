import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ClaudeLogin } from '../src/main/engine/claude-login'
import type { ChildLike } from '../src/main/engine/transport'
import { isSignedOutError, splitAuthCode, type LoginState } from '../src/shared/login-types'

/** A Claude process that answers sign-in requests the way Claude Code 2.1.319 does. */
class FakeClaude implements ChildLike {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  requests: Array<{ id: string; subtype: string; body: Record<string, unknown> }> = []
  private emitter = new EventEmitter()
  private waiting: string[] = []
  ended = false

  constructor(private readonly opts: { refuseCode?: string } = {}) {
    let buf = ''
    this.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let i: number
      while ((i = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i)) as { request_id: string; request: { subtype: string } & Record<string, unknown> }
        buf = buf.slice(i + 1)
        this.handle(msg.request_id, msg.request)
      }
    })
    this.stdin.on('finish', () => { this.ended = true })
  }

  private reply(id: string, ok: boolean, body: unknown): void {
    const response = ok ? { subtype: 'success', request_id: id, response: body } : { subtype: 'error', request_id: id, error: body }
    this.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\n')
  }

  private handle(id: string, req: { subtype: string } & Record<string, unknown>): void {
    const { subtype, ...body } = req
    this.requests.push({ id, subtype, body })
    if (subtype === 'claude_authenticate') this.reply(id, true, { manualUrl: 'https://claude.ai/manual', automaticUrl: 'https://claude.ai/auto' })
    else if (subtype === 'claude_oauth_wait_for_completion') this.waiting.push(id)
    else if (subtype === 'claude_oauth_callback') {
      if (body.authorizationCode === this.opts.refuseCode) { this.reply(id, false, 'Invalid code'); return }
      this.signedIn(id)
    }
  }

  /** The browser handing back, or a good code: every waiting request gets the account. */
  signedIn(alsoId?: string): void {
    const account = { account: { email: 'me@example.com', subscriptionType: 'max' } }
    for (const id of [...this.waiting, ...(alsoId === undefined ? [] : [alsoId])]) this.reply(id, true, account)
    this.waiting = []
  }

  kill(): void { this.emitter.emit('exit', null) }
  on(event: 'exit', cb: (code: number | null) => void): void { this.emitter.on(event, cb) }
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 20))

function setup(child: FakeClaude) {
  const opened: string[] = []
  const states: LoginState[] = []
  let signedIn = 0
  const login = new ClaudeLogin({
    claudeBin: () => 'claude', cwd: () => 'C:\\Users\\me', openUrl: u => opened.push(u),
    onChange: s => states.push(s), onSignedIn: () => { signedIn++ }, spawnFn: () => child
  })
  return { login, opened, states, signedIn: () => signedIn }
}

describe('signing in to Claude Code from the app', () => {
  it('opens the browser, and finishes when the browser hands back', async () => {
    const child = new FakeClaude()
    const t = setup(child)
    const started = await t.login.start()
    expect(started).toMatchObject({ state: 'waiting', automaticUrl: 'https://claude.ai/auto', manualUrl: 'https://claude.ai/manual' })
    expect(t.opened).toEqual(['https://claude.ai/auto'])
    expect(child.requests.map(r => r.subtype)).toEqual(['claude_authenticate', 'claude_oauth_wait_for_completion'])
    expect(child.requests[0]!.body).toEqual({ loginWithClaudeAi: true })
    child.signedIn()
    await tick()
    expect(t.login.state).toEqual({ state: 'done', email: 'me@example.com', plan: 'max' })
    expect(t.signedIn()).toBe(1)
    expect(child.ended).toBe(true)
  })

  it('takes a pasted code, split into its two parts', async () => {
    const child = new FakeClaude()
    const t = setup(child)
    await t.login.start()
    const after = await t.login.submitCode('  abc123#xyz789 ')
    expect(child.requests.find(r => r.subtype === 'claude_oauth_callback')!.body).toEqual({ authorizationCode: 'abc123', state: 'xyz789' })
    expect(after).toMatchObject({ state: 'done', email: 'me@example.com' })
    await tick()
    expect(t.signedIn()).toBe(1)
  })

  it('keeps waiting, with a reason, when a code is wrong or incomplete', async () => {
    const child = new FakeClaude({ refuseCode: 'bad' })
    const t = setup(child)
    await t.login.start()
    expect(await t.login.submitCode('nohash')).toMatchObject({ state: 'waiting', submitting: false, error: expect.stringContaining('whole code') })
    expect(await t.login.submitCode('bad#state')).toMatchObject({ state: 'waiting', submitting: false, error: 'Invalid code' })
    expect(t.signedIn()).toBe(0)
  })

  it('reopens the same page rather than starting over when asked again', async () => {
    const child = new FakeClaude()
    const t = setup(child)
    await t.login.start()
    await t.login.start()
    expect(child.requests.filter(r => r.subtype === 'claude_authenticate')).toHaveLength(1)
    expect(t.opened).toEqual(['https://claude.ai/auto', 'https://claude.ai/auto'])
  })

  it('closes the process when cancelled', async () => {
    const child = new FakeClaude()
    const t = setup(child)
    await t.login.start()
    t.login.cancel()
    await tick()
    expect(t.login.state).toEqual({ state: 'idle' })
    expect(child.ended).toBe(true)
  })
})

describe('telling a signed-out failure apart', () => {
  it('recognizes Claude Code’s sign-in errors', () => {
    expect(isSignedOutError('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true)
    expect(isSignedOutError('Invalid API key · Please run /login')).toBe(true)
    expect(isSignedOutError('API Error: 401 {"type":"error"}')).toBe(true)
    expect(isSignedOutError('Not logged in · Please run /login')).toBe(true)
  })
  it('leaves other failures alone', () => {
    expect(isSignedOutError('API Error: 529 Overloaded')).toBe(false)
    expect(isSignedOutError('Claude stopped because of an error (max turns).')).toBe(false)
  })
  it('splits a code only when both parts are there', () => {
    expect(splitAuthCode('a#b')).toEqual({ authorizationCode: 'a', state: 'b' })
    expect(splitAuthCode('#b')).toBeNull()
    expect(splitAuthCode('a#')).toBeNull()
  })
})
