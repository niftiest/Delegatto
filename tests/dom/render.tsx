import type { ReactElement } from 'react'
import { act, render, type RenderResult } from '@testing-library/react'
import type { ChannelRow, SessionSummary } from '../../src/shared/types'
import type { ChannelMeta } from '../../src/shared/shell-types'

/** A project as the nav lists it. */
export function channel(id: number, name: string, extra: Partial<ChannelRow> = {}, meta: Partial<ChannelMeta> = {}): ChannelRow {
  const dirName = `D--GIT-${name}`
  return {
    id, dirName, cwd: `D:\\GIT\\${name}`, sessionCount: 1, lastActivity: null, preview: null,
    meta: { dirName, friendlyName: null, starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false, ...meta },
    ...extra
  }
}

/** A chat as a project's chat list has it. */
export function session(id: number, title: string | null = `Chat ${id}`): SessionSummary {
  return {
    id, sessionId: `0000000${id}-aaaa-bbbb-cccc-dddddddddddd`.slice(-36), title, messageCount: 2,
    lastTs: '2026-11-08T12:00:00Z', model: null, gitBranch: null, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0
  }
}

/** Lets resolved promises and the state updates they cause run, inside act. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve() })
}

/** Renders, then lets the mount's own requests (to the fake api) settle. */
export async function renderSettled(ui: ReactElement): Promise<RenderResult> {
  let result: RenderResult | undefined
  await act(async () => { result = render(ui) })
  await flush()
  return result!
}

/** A mouse move as Chromium sends it: screenX/screenY say where the pointer is on screen. */
export function mouseMoveInit(screenX: number, screenY: number): MouseEventInit {
  return { bubbles: true, cancelable: true, screenX, screenY, clientX: screenX, clientY: screenY }
}
