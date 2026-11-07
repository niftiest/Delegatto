import { liveIndicatorState } from '../lib'

/** Minimal streaming-state badge (Plan 2 Task 10): renders nothing while
 *  idle, "Streaming…" while a turn is running with an empty queue, and
 *  "Streaming · N queued" once the Composer has messages parked behind the
 *  current turn. Rendered in the chat header (App.tsx), next to the channel
 *  title -- purely presentational, all the state logic lives in the pure
 *  `liveIndicatorState` helper (tested in tests/renderer-lib.test.ts). */
export function LiveIndicator({ running, queuedCount }: { running: boolean; queuedCount: number }) {
  const state = liveIndicatorState(running, queuedCount)
  // Progress itself is on the working line under the chat; this only counts the queue.
  if (state !== 'queued') return null
  return (
    <span className={`live-indicator live-${state}`} role="status">
      {queuedCount} queued
    </span>
  )
}
