import { ControlSession, PLAN_USAGE_ARGS } from './claude-info'
import { defaultSpawn, type SpawnFn } from './transport'
import { splitAuthCode, type LoginState } from '../../shared/login-types'

/** Claude Code's own sign-in, driven from the app. A short-lived Claude process starts the
 *  flow and stays open until it ends: it listens for the browser to hand back, or takes a
 *  pasted code. The new login is saved where `claude auth login` saves it. */

const START_TIMEOUT_MS = 60_000
/** Long enough to sign in, including a password reset or a second factor. */
const WAIT_TIMEOUT_MS = 15 * 60_000

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function accountOf(answer: unknown): { email: string | null; plan: string | null } {
  const account = isObj(answer) && isObj(answer.account) ? answer.account : {}
  return {
    email: typeof account.email === 'string' ? account.email : null,
    plan: typeof account.subscriptionType === 'string' ? account.subscriptionType : null
  }
}

export class ClaudeLogin {
  private session: ControlSession | null = null
  private current: LoginState = { state: 'idle' }
  private readonly spawnFn: SpawnFn

  constructor(private readonly opts: {
    claudeBin: () => string
    cwd: () => string
    openUrl: (url: string) => void
    onChange: (state: LoginState) => void
    /** Signed in: chats running on the old login should start again on the new one. */
    onSignedIn: () => void
    spawnFn?: SpawnFn
  }) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn
  }

  get state(): LoginState {
    return this.current
  }

  private set(next: LoginState): void {
    this.current = next
    this.opts.onChange(next)
  }

  /** Starts signing in and opens the browser. Starting again while one is open reopens it. */
  async start(): Promise<LoginState> {
    if (this.current.state === 'waiting') { this.opts.openUrl(this.current.automaticUrl); return this.current }
    if (this.current.state === 'starting') return this.current
    this.close()
    this.set({ state: 'starting' })
    const session = new ControlSession(this.spawnFn, this.opts.claudeBin(), PLAN_USAGE_ARGS, this.opts.cwd())
    this.session = session
    try {
      const urls = await session.request('claude_authenticate', { loginWithClaudeAi: true }, START_TIMEOUT_MS)
      if (this.session !== session) return this.current
      if (!isObj(urls) || typeof urls.automaticUrl !== 'string' || typeof urls.manualUrl !== 'string') throw new Error("Claude Code didn't give a sign-in link.")
      this.set({ state: 'waiting', automaticUrl: urls.automaticUrl, manualUrl: urls.manualUrl, submitting: false, error: null })
      this.opts.openUrl(urls.automaticUrl)
      void this.waitForBrowser(session)
      return this.current
    } catch (err) {
      if (this.session === session) this.fail(err)
      return this.current
    }
  }

  /** The browser finishing by itself. */
  private async waitForBrowser(session: ControlSession): Promise<void> {
    try {
      const answer = await session.request('claude_oauth_wait_for_completion', {}, WAIT_TIMEOUT_MS)
      if (this.session === session) this.finish(answer)
    } catch (err) {
      if (this.session === session) this.fail(err)
    }
  }

  /** A code pasted from the sign-in page. */
  async submitCode(pasted: string): Promise<LoginState> {
    const cur = this.current
    const session = this.session
    if (cur.state !== 'waiting' || session === null) return cur
    const code = splitAuthCode(pasted)
    if (code === null) {
      this.set({ ...cur, error: 'That isn’t the whole code. Copy all of it from the sign-in page, including the part after the #.' })
      return this.current
    }
    this.set({ ...cur, submitting: true, error: null })
    try {
      const answer = await session.request('claude_oauth_callback', code, WAIT_TIMEOUT_MS)
      if (this.session === session) this.finish(answer)
    } catch (err) {
      if (this.session === session && this.current.state === 'waiting') {
        this.set({ ...this.current, submitting: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return this.current
  }

  cancel(): void {
    this.close()
    this.set({ state: 'idle' })
  }

  private finish(answer: unknown): void {
    this.close()
    this.set({ state: 'done', ...accountOf(answer) })
    this.opts.onSignedIn()
  }

  private fail(err: unknown): void {
    this.close()
    this.set({ state: 'failed', error: err instanceof Error ? err.message : String(err) })
  }

  private close(): void {
    const session = this.session
    this.session = null
    session?.close()
  }
}
