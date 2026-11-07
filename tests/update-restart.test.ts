import { describe, expect, it } from 'vitest'
import { AWAY_SECONDS, RESTART_SETTLE_MS, canRestartForUpdate, describeRestartWait, nothingToInterrupt, settleForRestart } from '../src/shared/update-types'

describe('canRestartForUpdate', () => {
  const clear = { autoInstall: true, ready: true, unsent: false, activeWork: 0, idleSeconds: AWAY_SECONDS }

  it('restarts when a downloaded update has nothing to interrupt', () => {
    expect(canRestartForUpdate(clear)).toBe(true)
  })

  it.each([
    ['installing automatically is off', { autoInstall: false }],
    ['nothing has downloaded', { ready: false }],
    ['a message is unsent', { unsent: true }],
    ['a chat is working', { activeWork: 1 }],
    ['someone is at the computer', { idleSeconds: AWAY_SECONDS - 1 }]
  ])('waits when %s', (_why, change) => {
    expect(canRestartForUpdate({ ...clear, ...change })).toBe(false)
  })
})

describe('restarting when finished', () => {
  const quiet = { chats: [], unsent: false }
  const T0 = 1_000_000

  it('counts running chats and unsent messages as work', () => {
    expect(nothingToInterrupt(quiet)).toBe(true)
    expect(nothingToInterrupt({ chats: ['A'], unsent: false })).toBe(false)
    expect(nothingToInterrupt({ chats: [], unsent: true })).toBe(false)
  })

  it('does not restart the moment things go quiet', () => {
    expect(settleForRestart(quiet, null, T0)).toEqual({ quietSince: T0, restart: false })
    expect(settleForRestart(quiet, T0, T0 + RESTART_SETTLE_MS - 1).restart).toBe(false)
  })

  it('restarts once it has stayed quiet long enough', () => {
    expect(settleForRestart(quiet, T0, T0 + RESTART_SETTLE_MS).restart).toBe(true)
  })

  it('starts the wait over if work comes back, such as a queued message going out', () => {
    expect(settleForRestart({ chats: ['A'], unsent: false }, T0, T0 + RESTART_SETTLE_MS)).toEqual({ quietSince: null, restart: false })
  })

  it('says what it is waiting for', () => {
    expect(describeRestartWait({ chats: ['A'], unsent: false })).toBe('Restarts once 1 chat finishes')
    expect(describeRestartWait({ chats: ['A', 'B'], unsent: true })).toBe('Restarts once 2 chats finish and your unsent message is sent or cleared')
    expect(describeRestartWait(quiet)).toBe('Restarting in a moment')
  })
})
