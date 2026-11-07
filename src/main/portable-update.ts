import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import { once } from 'node:events'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** The portable exe's update, apart from Electron: find the new exe in a release,
 *  download and check it, and hand over to it. A running portable exe is locked,
 *  so it can't replace itself: the new one goes beside it, starts with
 *  `--updated-from=<old path>`, and deletes the old one once that has exited. */

export const UPDATED_FROM_ARG = '--updated-from='
/** The old window was in the tray or minimized, so the new one stays out of the way too. */
export const UPDATED_HIDDEN_ARG = '--updated-hidden'

export type PortableAsset = { name: string; url: string; size: number; sha256: string | null }

const PORTABLE_NAME = /^Delegatto-Portable-[\w.-]+\.exe$/
/** Only a Delegatto exe is ever deleted, whatever the command line says. */
const DELETABLE_NAME = /^Delegatto[^\\/]*\.exe$/i

/** The portable exe in a GitHub release's asset list, or null if it has none. */
export function pickPortableAsset(assets: unknown): PortableAsset | null {
  if (!Array.isArray(assets)) return null
  for (const raw of assets) {
    const a = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }
    if (typeof a.name !== 'string' || !PORTABLE_NAME.test(a.name)) continue
    if (typeof a.browser_download_url !== 'string' || typeof a.size !== 'number') continue
    const digest = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest) : null
    return { name: a.name, url: a.browser_download_url, size: a.size, sha256: digest?.[1]?.toLowerCase() ?? null }
  }
  return null
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('error', reject).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex')))
  })
}

async function isComplete(path: string, asset: PortableAsset): Promise<boolean> {
  try {
    if ((await stat(path)).size !== asset.size) return false
    return asset.sha256 === null || await hashFile(path) === asset.sha256
  } catch {
    return false
  }
}

/** Downloads the exe into `dir` and returns its path. Nothing lands under the real
 *  name until its size and checksum are right, and a copy already there is reused. */
export async function downloadPortable(
  fetchFn: (url: string) => Promise<Response>,
  asset: PortableAsset,
  dir: string,
  onPercent: (percent: number) => void
): Promise<string> {
  const dest = join(dir, asset.name)
  if (await isComplete(dest, asset)) return dest
  const part = `${dest}.download`
  const res = await fetchFn(asset.url)
  if (!res.ok || res.body === null) throw new Error(`The download answered ${res.status}`)
  const out = createWriteStream(part)
  const failed = new Promise<never>((_, reject) => out.once('error', reject))
  try {
    const hash = createHash('sha256')
    const reader = res.body.getReader()
    let received = 0
    let shown = -1
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed])
      if (done) break
      hash.update(value)
      received += value.length
      if (!out.write(value)) await Promise.race([once(out, 'drain'), failed])
      const percent = asset.size > 0 ? Math.min(100, Math.floor(received / asset.size * 100)) : 0
      if (percent !== shown) { shown = percent; onPercent(percent) }
    }
    out.end()
    await Promise.race([once(out, 'finish'), failed])
    if (received !== asset.size) throw new Error(`The download was incomplete (${received} of ${asset.size} bytes)`)
    if (asset.sha256 !== null && hash.digest('hex') !== asset.sha256) throw new Error('The download failed its checksum')
    // 'finish' is the data being flushed; the handle is only free to rename after 'close'.
    await new Promise<void>(resolve => { if (out.closed) resolve(); else out.once('close', () => resolve()) })
    await rename(part, dest)
    return dest
  } catch (err) {
    out.destroy()
    await unlink(part).catch(() => {})
    throw err
  }
}

/** The arguments for the new exe: this launch's own (such as --user-data-dir), plus
 *  the handover. A handover left from an earlier update is replaced. */
export function handoffArgs(argv: string[], previous: string, hidden: boolean): string[] {
  const kept = argv.filter(a => !a.startsWith(UPDATED_FROM_ARG) && a !== UPDATED_HIDDEN_ARG)
  return [...kept, `${UPDATED_FROM_ARG}${previous}`, ...(hidden ? [UPDATED_HIDDEN_ARG] : [])]
}

export function previousFromArgv(argv: string[]): string | null {
  const arg = argv.find(a => a.startsWith(UPDATED_FROM_ARG))
  return arg === undefined ? null : arg.slice(UPDATED_FROM_ARG.length)
}

/** Whether a path from the command line is a previous version it's safe to delete:
 *  a different Delegatto exe in the folder this one runs from. */
export function isDeletablePrevious(previous: string, current: string): boolean {
  if (!isAbsolute(previous) || !DELETABLE_NAME.test(basename(previous))) return false
  if (previous.toLowerCase() === current.toLowerCase()) return false
  return dirname(previous).toLowerCase() === dirname(current).toLowerCase()
}

/** Waits for the old exe to exit (it stays locked until then) and deletes it. If that
 *  takes too long the file is left behind: a stray exe, not a failed update. */
export async function removePrevious(previous: string, timeoutMs = 30_000, retryMs = 500): Promise<boolean> {
  const giveUpAt = Date.now() + timeoutMs
  for (;;) {
    try {
      await unlink(previous)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
      if (Date.now() >= giveUpAt) return false
    }
    await new Promise(r => setTimeout(r, retryMs))
  }
}

/** The file to start this app from: a portable build runs from a temporary folder,
 *  so its own exe path is gone once it exits. */
export function launchExePath(runningExe: string): string {
  return process.env.PORTABLE_EXECUTABLE_FILE ?? runningExe
}
