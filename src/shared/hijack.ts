import type { ExternalLock } from './engine-types'

/** Why a chat held by another process can't be taken over right now, or null when
 *  it can. Only a terminal that says it's idle qualifies: at the prompt, waiting
 *  for you. Any other status (working, running a shell command, or one this
 *  version doesn't know) refuses, so ending a process never interrupts work. */
export function hijackBlock(lock: Pick<ExternalLock, 'entrypoint' | 'status'>): 'not-terminal' | 'working' | null {
  if (lock.entrypoint !== 'cli') return 'not-terminal'
  return lock.status === 'idle' ? null : 'working'
}

export const HIJACK_WORKING_TEXT = 'Claude is still working in that terminal. You can hijack this chat once it’s waiting for you.'
export const HIJACK_NOT_TERMINAL_TEXT = 'This chat is held by another Claude app, not a terminal, so it can’t be hijacked.'
