import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { resolve, sep, dirname } from 'node:path'

/** Saving an AI-generated image into the open project's working directory.
 *  Pure helpers (data-URL decode + path containment) are split out so the
 *  security-critical bits unit-test without touching disk. */

export type SaveResult = { ok: true; path: string } | { ok: false; error: string }

/** Decode a base64 image data URL into its bytes + media type, or null if it
 *  isn't a base64 image data URL. */
export function parseImageDataUrl(dataUrl: string): { mediaType: string; bytes: Buffer } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl)
  if (m === null) return null
  try {
    return { mediaType: m[1]!, bytes: Buffer.from(m[2]!, 'base64') }
  } catch { return null }
}

/** Resolve `rel` against `baseDir` and return the absolute path ONLY if it
 *  stays inside `baseDir` (blocks `..` escapes and absolute paths that would
 *  land outside). Null when the target escapes or `rel` is empty. */
export function resolveWithinDir(baseDir: string, rel: string): string | null {
  if (rel.trim().length === 0) return null
  const base = resolve(baseDir)
  const target = resolve(base, rel)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** Write an image data URL to `relPath` inside `cwd`. Refuses to escape the
 *  working directory or overwrite an existing file. Never throws. */
export function saveImage(opts: { cwd: string | null | undefined; relPath: string; dataUrl: string }): SaveResult {
  if (typeof opts.cwd !== 'string' || opts.cwd.length === 0) return { ok: false, error: 'No working directory for this chat.' }
  const target = resolveWithinDir(opts.cwd, opts.relPath)
  if (target === null) return { ok: false, error: 'Invalid path — it must stay inside the project directory.' }
  const parsed = parseImageDataUrl(opts.dataUrl)
  if (parsed === null) return { ok: false, error: 'Not a valid image.' }
  if (existsSync(target)) return { ok: false, error: 'A file with that name already exists.' }
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, parsed.bytes)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: `Could not save: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** True when `cwd` is an existing directory (used to gate the Create-Image
 *  tool on a real working dir). */
export function isRealDir(cwd: string | null | undefined): boolean {
  try { return typeof cwd === 'string' && cwd.length > 0 && statSync(cwd).isDirectory() } catch { return false }
}
