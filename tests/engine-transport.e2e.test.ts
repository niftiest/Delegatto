import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transport } from '../src/main/engine/transport'
import type { LiveEvent } from '../src/shared/engine-types'

// Opt-in real-CLI smoke test. Spawns the actual `claude` binary, costs real
// money, and needs local auth -- gated behind DELEGATTO_E2E=1 so CI (and
// everyday `npm test`) never runs it. Run manually with:
//   DELEGATTO_E2E=1 npx vitest run tests/engine-transport.e2e.test.ts
const RUN_E2E = process.env.DELEGATTO_E2E === '1'

describe.skipIf(!RUN_E2E)('Transport — real CLI smoke (DELEGATTO_E2E=1)', () => {
  it(
    'spawns real claude, sends a trivial prompt, and observes init -> result',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'delegatto-e2e-'))
      try {
        const transport = new Transport(
          {
            cwd,
            sessionId: randomUUID(),
            skipPermissions: true,
            extraArgs: []
          },
          { claudeBin: 'claude' }
        )

        const events: LiveEvent[] = []
        let exitCode: number | null | undefined
        const done = new Promise<void>((resolve) => {
          transport.on((e) => {
            events.push(e)
            if (e.kind === 'result') {
              // Ask the process to exit once we have what we need -- the
              // smoke test only needs one turn's worth of events.
              transport.close()
            }
          })
          transport.onExit((code) => {
            exitCode = code
            resolve()
          })
        })

        transport.start()
        transport.send({
          type: 'user',
          message: { role: 'user', content: 'Reply with exactly: ok' }
        })

        const timeout = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('e2e smoke timed out waiting for claude to exit')), 55_000)
        )
        await Promise.race([done, timeout])

        const init = events.find((e) => e.kind === 'init')
        const result = events.find((e) => e.kind === 'result')

        console.log(
          '[e2e smoke] exitCode=%s costUsd=%s events=%s',
          exitCode,
          result?.kind === 'result' ? result.costUsd : undefined,
          events.map((e) => e.kind).join(',')
        )

        expect(init).toBeDefined()
        expect(result).toBeDefined()
        if (result?.kind === 'result') {
          expect(result.costUsd).toBeGreaterThanOrEqual(0)
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    },
    60_000
  )
})
