import { existsSync, promises as fsp } from 'node:fs'
import type { Runner, RunResult } from '../engine/github'
import { cleanOutput } from '../engine/github'

/** The sync repo's local copy, driven by the user's own git. Downloads are partial (only
 *  the file contents a checkout needs) and the checkout only covers this PC's projects,
 *  so a PC never holds chats it hasn't asked for. */

const NETWORK_TIMEOUT_MS = 15 * 60_000
const QUICK_TIMEOUT_MS = 60_000
const PRESENCE_PREFIX = 'refs/heads/presence/'
/** Git's own id for an empty folder; every repo knows it. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export class GitError extends Error {
  constructor(message: string, readonly result: RunResult) {
    super(message)
    this.name = 'GitError'
  }
}

export type PresenceRef = { deviceId: string; sha: string; message: string }

export class SyncGit {
  constructor(
    private readonly run: Runner,
    readonly dir: string,
    private readonly remote: string,
    private readonly credentialArgs: string[]
  ) {}

  private async git(args: string[], opts: { network?: boolean; cwd?: string; allowFail?: boolean; onStderr?: (text: string) => void } = {}): Promise<RunResult> {
    const result = await this.run('git', [
      ...this.credentialArgs,
      '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.hooksPath=NUL',
      '-c', 'user.name=Delegatto Sync', '-c', 'user.email=sync@delegatto.invalid',
      '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false',
      ...args
    ], { cwd: opts.cwd ?? this.dir, timeoutMs: opts.network === true ? NETWORK_TIMEOUT_MS : QUICK_TIMEOUT_MS, onStderr: opts.onStderr })
    if (result.code !== 0 && opts.allowFail !== true) {
      throw new GitError(cleanOutput(result.stderr) || `git ${args[0]} failed.`, result)
    }
    return result
  }

  exists(): boolean {
    return existsSync(`${this.dir}/.git`)
  }

  /** A fresh local copy. An empty remote is fine: `main` is made by the first commit. */
  async clone(parent: string): Promise<void> {
    await fsp.mkdir(parent, { recursive: true })
    await this.git(['clone', '-q', '--filter=blob:none', '--no-checkout', this.remote, this.dir], { network: true, cwd: parent })
    await this.git(['sparse-checkout', 'set', '--cone', 'catalog'])
    if (await this.remoteMain() === null) await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    else await this.git(['checkout', '-q', '-B', 'main', 'origin/main'], { network: true })
  }

  /** `main`'s commit on GitHub, and every PC's presence, in one small request. */
  async listRemote(): Promise<{ main: string | null; presence: Map<string, string> }> {
    const out = await this.git(['ls-remote', 'origin', 'refs/heads/main', `${PRESENCE_PREFIX}*`], { network: true })
    let main: string | null = null
    const presence = new Map<string, string>()
    for (const line of out.stdout.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/)
      if (sha === undefined || ref === undefined) continue
      if (ref === 'refs/heads/main') main = sha
      else if (ref.startsWith(PRESENCE_PREFIX)) presence.set(ref.slice(PRESENCE_PREFIX.length), sha)
    }
    return { main, presence }
  }

  async remoteMain(): Promise<string | null> {
    return (await this.listRemote()).main
  }

  /** Makes the local copy exactly what's on GitHub. Nothing of value lives only here.
   *  `onIncoming` hears which files are about to change, and which PC changed them last, before
   *  their contents download: the fetch only brings what changed, the reset brings the bytes. */
  async pull(onIncoming?: (paths: string[], lastBy: string | null) => void): Promise<string | null> {
    const main = await this.remoteMain()
    if (main === null) return null
    await this.git(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { network: true })
    if (onIncoming !== undefined && await this.currentHead() !== null) {
      const diff = await this.git(['diff', '--name-only', '--no-renames', 'HEAD', 'origin/main'], { allowFail: true })
      const paths = diff.code === 0 ? diff.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0) : []
      if (paths.length > 0) {
        const subject = await this.git(['log', '-1', '--format=%s', 'origin/main'], { allowFail: true })
        onIncoming(paths, subject.code === 0 ? subject.stdout.trim() : null)
      }
    }
    await this.git(['reset', '-q', '--hard', 'origin/main'], { network: true })
    await this.git(['clean', '-fdq'])
    return main
  }

  async setProjects(projectIds: string[]): Promise<void> {
    await this.git(['sparse-checkout', 'set', '--cone', 'catalog', ...projectIds.map(id => `data/${id}`)], { network: true })
  }

  async disableSparse(): Promise<void> {
    await this.git(['sparse-checkout', 'disable'], { network: true })
  }

  async hasChanges(): Promise<boolean> {
    return (await this.git(['status', '--porcelain'])).stdout.trim().length > 0
  }

  async removePath(path: string): Promise<void> {
    await this.git(['rm', '-rqf', '--ignore-unmatch', '--sparse', '--', path])
  }

  /** Commits and pushes. False when another PC got there first; nothing is lost, the caller redoes it.
   *  `onPercent` gets how much of the upload git has sent so far. */
  async commitAndPush(message: string, onPercent?: (percent: number) => void): Promise<boolean> {
    await this.git(['add', '-A', '--sparse'])
    await this.git(['commit', '-q', '-m', message])
    const pushed = onPercent === undefined
      ? await this.git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], { network: true, allowFail: true })
      : await this.git(['push', '--progress', 'origin', 'HEAD:refs/heads/main'], { network: true, allowFail: true, onStderr: pushProgressReader(onPercent) })
    if (pushed.code === 0) return true
    const text = pushed.stderr
    if (/non-fast-forward|fetch first|rejected|cannot lock ref/i.test(text)) return false
    throw new GitError(cleanOutput(text) || 'git push failed.', pushed)
  }

  /** Replaces the repo's history with one commit holding what's there now. */
  async startFresh(message: string): Promise<void> {
    await this.git(['checkout', '-q', '--orphan', 'delegatto-fresh'])
    await this.git(['add', '-A'])
    await this.git(['commit', '-q', '--allow-empty', '-m', message])
    await this.git(['push', '-q', '--force', 'origin', 'HEAD:refs/heads/main'], { network: true })
    await this.git(['branch', '-qM', 'main'])
    await this.git(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { network: true })
    await this.git(['reset', '-q', '--hard', 'origin/main'])
  }

  /** Presence lives on a branch of its own that gets overwritten, so it never grows the repo. */
  async writePresence(deviceId: string, message: string): Promise<void> {
    const made = await this.git(['commit-tree', EMPTY_TREE, '-m', message])
    await this.git(['push', '-q', '--force', 'origin', `${made.stdout.trim()}:${PRESENCE_PREFIX}${deviceId}`], { network: true })
  }

  async readPresence(): Promise<PresenceRef[]> {
    await this.git(['fetch', '-q', '--prune', 'origin', `+${PRESENCE_PREFIX}*:refs/remotes/origin/presence/*`], { network: true })
    const out = await this.git(['for-each-ref', 'refs/remotes/origin/presence', '--format=%(refname:lstrip=4)%00%(objectname)%00%(contents)%00%00'])
    const refs: PresenceRef[] = []
    for (const record of out.stdout.split('\0\0')) {
      const [deviceId, sha, message] = record.replace(/^\s+/, '').split('\0')
      if (deviceId !== undefined && sha !== undefined && message !== undefined) refs.push({ deviceId, sha, message: message.trim() })
    }
    return refs
  }

  async currentHead(): Promise<string | null> {
    const r = await this.git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }
}

/** Turns git's push progress into one percent for the whole upload. Git prints
 *  "Writing objects:  42% (21/50)" lines; the chunks can split a line anywhere. */
export function pushProgressReader(onPercent: (percent: number) => void): (text: string) => void {
  let buffer = ''
  let last = -1
  return text => {
    buffer += text
    const parts = buffer.split(/[\r\n]/)
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const m = /Writing objects:\s+(\d+)%/.exec(line)
      if (m === null) continue
      const percent = Math.min(100, Number(m[1]))
      if (percent !== last) { last = percent; onPercent(percent) }
    }
  }
}

/** Where a project folder's code stands, for warnings about what a clone won't have. */
export async function codeState(run: Runner, cwd: string): Promise<{ branch: string | null; head: string | null; uncommitted: number; unpushed: number }> {
  const none = { branch: null, head: null, uncommitted: 0, unpushed: 0 }
  try {
    const head = await run('git', ['rev-parse', 'HEAD'], { cwd })
    if (head.code !== 0) return none
    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    const status = await run('git', ['status', '--porcelain'], { cwd })
    const ahead = await run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd })
    return {
      branch: branch.code === 0 ? branch.stdout.trim() : null,
      head: head.stdout.trim(),
      uncommitted: status.code === 0 ? status.stdout.split('\n').filter(l => l.trim().length > 0).length : 0,
      unpushed: ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0
    }
  } catch {
    return none
  }
}
