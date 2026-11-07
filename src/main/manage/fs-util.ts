import { promises as fsp, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FileRemover } from './types'

/** Total bytes under `dir`; never follows symlinks/junctions; unreadable parts count as 0. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(p)
    else if (e.isFile()) { try { total += (await fsp.stat(p)).size } catch { /* vanished */ } }
  }
  return total
}

export function fileSize(f: string): number {
  try { return statSync(f).size } catch { return 0 }
}

export async function isDir(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isDirectory() } catch { return false }
}

export async function isFile(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isFile() } catch { return false }
}

export async function listDir(dir: string): Promise<string[]> {
  try { return await fsp.readdir(dir) } catch { return [] }
}

/** Deletes for good (tests + the fallback when a drive has no Recycle Bin).
 *  A link/junction is removed itself; its target is never walked. */
export const permanentRemover: FileRemover = {
  async removeDirectory(path) {
    const st = await fsp.lstat(path)
    if (st.isSymbolicLink()) { await fsp.rm(path, { force: false }); return }
    await clearReadOnly(path)
    await fsp.rm(path, { recursive: true, force: false })
  },
  async removeFile(path) {
    try { await fsp.chmod(path, 0o666) } catch { /* not found surfaces below */ }
    await fsp.unlink(path)
  },
  recyclable: () => false
}

async function clearReadOnly(dir: string): Promise<void> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) await clearReadOnly(p)
    else { try { await fsp.chmod(p, 0o666) } catch { /* ignore */ } }
  }
}
