import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

/** Copies the main process's console output into `<dir>/main.log`, so what it did can be read
 *  afterwards. Kept small: past MAX_BYTES the file becomes main.old.log and a new one starts. */

const MAX_BYTES = 5 * 1024 * 1024

export function installFileLog(dir: string): void {
  const file = join(dir, 'main.log')
  try { mkdirSync(dir, { recursive: true }) } catch { return }
  let size = 0
  try { size = statSync(file).size } catch { /* new file */ }
  const write = (level: string, args: unknown[]): void => {
    try {
      const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`
      if (size + line.length > MAX_BYTES) {
        rmSync(join(dir, 'main.old.log'), { force: true })
        renameSync(file, join(dir, 'main.old.log'))
        size = 0
      }
      appendFileSync(file, line)
      size += line.length
    } catch { /* logging must never break the app */ }
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => { original(...args); write(level.toUpperCase(), args) }
  }
  write('INFO', ['--- started'])
}
