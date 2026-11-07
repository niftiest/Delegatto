import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EngineCoordinator, type SessionInfo } from '../src/main/engine/coordinator'
import { SessionPool } from '../src/main/engine/pool'
import { SessionWatcher } from '../src/main/engine/watcher'
import { Transport } from '../src/main/engine/transport'
import { PermissionBridge } from '../src/main/engine/permission-bridge'
import { cwdToProjectDir, claudeHome } from '../src/main/indexer/discover'
import type { LiveEvent } from '../src/shared/engine-types'
import type { StreamedRow } from '../src/main/jsonl/stream'

// Opt-in real-CLI smoke test -- the FULL write-path round trip (Plan 2 Task
// 10's payoff), one level up from engine-transport.e2e.test.ts's bare
// Transport smoke: a real SessionPool spawning a real Transport, a real
// SessionWatcher tailing the durable file, and the real EngineCoordinator
// wiring them together -- exactly the object graph engine-ipc.ts builds in
// production, minus the electron IPC boundary itself. Costs real money,
// needs local auth -- gated behind DELEGATTO_E2E=1, same as Task 2's smoke.
//
// IMPORTANT (a finding from getting this test working): do NOT redirect
// CLAUDE_CONFIG_DIR to a scratch directory to keep this test's session file
// away from the real ~/.claude/projects -- the CLI's stored login credentials
// live under the REAL config dir, so overriding it produces a real spawn that
// immediately fails auth ("Not logged in - Please run /login": an
// authentication_failed assistant row, is_error result, costUsd 0, and no
// delta/stream_event traffic at all -- the CLI short-circuits straight to a
// synthetic error message instead of a real model turn). This test therefore
// uses the REAL claudeHome() -- exactly what engine-ipc.ts does in production
// -- and cleans up only the one freshly-created project directory (a fresh
// tmp cwd's slug is guaranteed not to collide with any real project) it wrote
// under it afterward.
//
// Run manually with:
//   DELEGATTO_E2E=1 npx vitest run tests/engine-coordinator.e2e.test.ts
const RUN_E2E = process.env.DELEGATTO_E2E === '1'

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 50))
  }
}

describe.skipIf(!RUN_E2E)('EngineCoordinator — real CLI round trip (DELEGATTO_E2E=1)', () => {
  it(
    'sends through pool+watcher+coordinator, observes delta/assistant/result, and writes the durable session file',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'delegatto-e2e-cwd-'))
      const sessionId = randomUUID()
      const dirName = cwdToProjectDir(cwd)
      const filePath = join(claudeHome(), 'projects', dirName, `${sessionId}.jsonl`)
      const sessionPk = 1

      try {
        const sessionInfo: SessionInfo = {
          sessionPk,
          sessionKey: filePath,
          filePath,
          cwd,
          resumeId: sessionId,
          indexedOffset: 0,
          isNew: true // brand-new chat -- never spawned against before, so the coordinator uses --session-id
        }

        let capturedTransport: Transport | null = null
        const pool = new SessionPool({
          idleReapMs: 5 * 60 * 1000,
          transportFactory: (spec) => {
            const t = new Transport(spec, { claudeBin: 'claude' })
            capturedTransport = t
            return t
          },
          isExternallyLive: () => false
        })

        const bridge = new PermissionBridge({ toolName: 'mcp__delegatto__approve' })

        const coordinator = new EngineCoordinator({
          pool,
          makeWatcher: () => new SessionWatcher(),
          bridge,
          lookupSession: (pk) => (pk === sessionPk ? sessionInfo : null),
          rulesStore: { add: () => {}, get: () => [] },
          defaults: {
            skipPermissions: true,
            claudeBin: 'claude'
          },
          isExternallyLive: () => false
        })

        const events: LiveEvent[] = []
        const rowBatches: StreamedRow[][] = []
        coordinator.onEvent((pk, e) => { if (pk === sessionPk) events.push(e) })
        coordinator.onRows((pk, rows) => { if (pk === sessionPk) rowBatches.push(rows) })

        const resultSeen = new Promise<void>((resolve) => {
          coordinator.onEvent((pk, e) => { if (pk === sessionPk && e.kind === 'result') resolve() })
        })

        coordinator.send(sessionPk, 'reply with exactly: pong')

        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('coordinator e2e timed out waiting for result')), 55_000)
        )
        await Promise.race([resultSeen, timeout])

        // Let the watcher's debounce (50ms default) and chokidar's own fs
        // latency catch up to whatever the CLI has already flushed to disk
        // by the time `result` fired -- the file write and the stdout event
        // are two independent I/O paths that don't complete in lockstep.
        await waitUntil(() => existsSync(filePath), 5_000)
        await new Promise(r => setTimeout(r, 1500))

        // Clean shutdown: interrupt the still-open stream-json process (it
        // does not exit on its own after one turn -- same as Task 2's smoke)
        // and wait for its real exit before the test ends.
        const exited = new Promise<void>((resolve) => { capturedTransport?.onExit(() => resolve()) })
        coordinator.interrupt(sessionPk)
        await Promise.race([exited, new Promise(r => setTimeout(r, 5000))])

        const kinds = events.map(e => e.kind)
        const result = events.find((e): e is Extract<LiveEvent, { kind: 'result' }> => e.kind === 'result')
        const fileExists = existsSync(filePath)
        const totalRows = rowBatches.reduce((n, b) => n + b.length, 0)

        console.log(
          '[coordinator e2e] events=%s costUsd=%s fileExists=%s rowBatches=%d totalRows=%d',
          kinds.join(','), result?.costUsd, fileExists, rowBatches.length, totalRows
        )

        expect(kinds).toContain('delta')
        expect(kinds).toContain('assistant')
        expect(result).toBeDefined()
        expect(result!.costUsd).toBeGreaterThan(0)
        expect(fileExists).toBe(true)
        // The watcher (via the coordinator's onRows) must have tailed at
        // least one durable row out of the very file it was pointed at --
        // proving the pool/watcher/coordinator wiring, not just the bare
        // Transport, sees the real turn end to end.
        expect(totalRows).toBeGreaterThan(0)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
        // Only the one freshly-created project directory this test's own
        // brand-new tmp cwd mapped to -- never anything else under the real
        // ~/.claude/projects.
        rmSync(dirname(filePath), { recursive: true, force: true })
      }
    },
    60_000
  )
})
