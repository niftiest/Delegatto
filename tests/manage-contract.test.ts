import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGE_IPC } from '../src/shared/manage-types'

const root = join(__dirname, '..')
// Normalised: a Windows checkout (core.autocrlf) has CRLF line endings.
const preloadSrc = readFileSync(join(root, 'src/preload/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const manageIpcSrc = readFileSync(join(root, 'src/main/manage-ipc.ts'), 'utf8')

/** Top-level method names of an object literal `const <name>: ... = { ... }` in the preload. */
function keysOf(name: string): string[] {
  const start = preloadSrc.indexOf(`const ${name}:`)
  expect(start).toBeGreaterThanOrEqual(0)
  const body = preloadSrc.slice(start, preloadSrc.indexOf('\n}\n', start))
  return [...body.matchAll(/^ {2}(\w+):/gm)].map(m => m[1]!)
}

describe('Manage IPC contract', () => {
  it('the preload and main both use every MANAGE_IPC channel', () => {
    const referenced = new Set([...preloadSrc.matchAll(/\bMANAGE_IPC\.(\w+)/g)].map(m => m[1]))
    expect(referenced).toEqual(new Set(Object.keys(MANAGE_IPC)))
    for (const key of Object.keys(MANAGE_IPC)) {
      if (key === 'searchEvent') {
        expect(manageIpcSrc).toMatch(/sender\.send\(\s*MANAGE_IPC\.searchEvent\b/)
        continue
      }
      expect(manageIpcSrc).toMatch(new RegExp(`\\[MANAGE_IPC\\.${key}\\]:`))
    }
  })

  it("the Manage API never shadows a Delegatto / engine method (window.delegatto = {...api, ...manage})", () => {
    const api = new Set(keysOf('api'))
    const clashes = keysOf('manage').filter(k => api.has(k))
    expect(clashes).toEqual([])
  })
})
