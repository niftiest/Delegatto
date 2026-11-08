/** Signing in to Claude Code from inside the app, for when its login has expired or is missing.
 *  Uses Claude Code's own sign-in, so the result is the same as `claude auth login`. */

export type LoginState =
  | { state: 'idle' }
  | { state: 'starting' }
  /** The browser was sent to `automaticUrl`, which finishes by itself. `manualUrl` is for
   *  signing in somewhere else: it ends with a code to paste back here. */
  | { state: 'waiting'; automaticUrl: string; manualUrl: string; submitting: boolean; error: string | null }
  | { state: 'done'; email: string | null; plan: string | null }
  | { state: 'failed'; error: string }

/** Whether a failed reply means Claude Code isn't signed in, or its sign-in has expired. */
export function isSignedOutError(text: string): boolean {
  return /authentication_failed|OAuth (session|token)[^.]*(expired|revoked|refreshed)|Failed to authenticate|Please run \/login|Invalid API key|Not logged in|API Error: 401/i.test(text)
}

/** The code the sign-in page shows is `code#state`; Claude Code wants them apart. */
export function splitAuthCode(pasted: string): { authorizationCode: string; state: string } | null {
  const text = pasted.trim()
  const hash = text.indexOf('#')
  if (hash <= 0 || hash === text.length - 1) return null
  return { authorizationCode: text.slice(0, hash), state: text.slice(hash + 1) }
}
