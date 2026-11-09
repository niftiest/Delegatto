import { vi, type Mock } from 'vitest'
import type { DelegattoApi } from '../../src/shared/ipc'
import type { EngineApi } from '../../src/shared/engine-ipc-contract'
import type { ManageApi } from '../../src/shared/manage-types'
import type { UpdateApi } from '../../src/shared/update-types'
import type { ClaudeSettingsApi } from '../../src/shared/claude-settings-types'
import type { SyncApi, SyncStatus } from '../../src/shared/sync-types'
import { DEFAULT_SETTINGS } from '../../src/main/catalog/settings'
import { NO_PLAN_USAGE } from '../../src/shared/plan-usage'

/** Everything the preload puts on window.delegatto, as the renderer sees it (src/renderer/api.ts). */
export type FullApi = DelegattoApi & EngineApi & ManageApi & UpdateApi & ClaudeSettingsApi & SyncApi
type Name = keyof FullApi & string
type Fn = (...args: never[]) => unknown
/** The subscriptions: each takes a callback and returns its unsubscribe. */
export type EventName = { [K in Name]: K extends `on${infer C}` ? (C extends Capitalize<C> ? K : never) : never }[Name]
type ListenerArgs<K extends EventName> = FullApi[K] extends (cb: (...args: infer A) => void) => unknown ? A : never

const isSubscription = (name: string): boolean => /^on[A-Z]/.test(name)

/** Sync never set up on this PC. */
const SYNC_OFF: SyncStatus = {
  github: { state: 'signed_out', account: null }, configured: false, discoveredRepos: [], leftSync: false, repo: null,
  encrypted: false, auto: false, deviceName: 'Test PC', hostname: 'test-pc', busy: false, activity: null,
  lastSyncAt: null, lastCheckAt: null, lastError: null, repoSizeBytes: null, hasRecoveryKey: false,
  syncedRepos: [], projects: [], remoteProjects: [], conflicts: [], devices: []
}

/** What a method answers with when a test hasn't said. Anything not here resolves to
 *  undefined, apart from list-like names, which resolve to an empty list. Values are built
 *  fresh for each call, so no test can change another's. */
const DEFAULTS: { [K in Name]?: () => FullApi[K] extends (...args: never[]) => infer R ? Awaited<R> : never } = {
  getSettings: () => ({ ...DEFAULT_SETTINGS }),
  planUsage: () => NO_PLAN_USAGE,
  syncIncoming: () => [],
  syncStatus: () => SYNC_OFF,
  syncChatInfo: () => ({ synced: false, elsewhere: null, conflict: null, pendingSecrets: 0, codeNote: null }),
  getProjectSettings: () => ({}),
  folderSettings: () => ({}),
  contextUsage: () => null,
  turnInfo: () => null,
  mcpStatus: () => null,
  modelPrices: () => null,
  totalCost: () => 0,
  chatMode: () => 'default',
  backgroundTasks: () => [],
  shellList: () => [],
  claudeFound: () => true,
  fsTree: () => [],
  getUpdateStatus: () => ({ state: 'idle', currentVersion: '1.0.0', channel: 'dev', justUpdated: false, restartWaiting: null, restartAfterDownload: false }),
  splitViewGet: () => null,
  loadTranscript: () => ({ items: [], oldestSeq: null, hasMore: false }),
  promptHistory: () => [],
  withdrawQueued: () => true,
  isSessionLive: () => false,
  getLock: () => null,
  rewindPoints: () => [],
  taskOutput: () => ({ output: '', truncated: false }),
  claudeInfo: () => ({ ok: false, error: 'not in tests' }),
  isElevated: () => false
}
/** Methods the preload sends without waiting for an answer: they return nothing. */
const SYNC_METHODS = new Set<string>(['appReady', 'appLog', 'setVisibleChats', 'appDialogShown', 'appDialogAnswer', 'textMenuAction', 'focusMain', 'resolvePermission'])

function defaultImpl(name: string): (...args: unknown[]) => unknown {
  const make = DEFAULTS[name as Name]
  if (SYNC_METHODS.has(name)) return () => undefined
  if (make !== undefined) return () => Promise.resolve(make())
  if (/^(list|pending)[A-Z]/.test(name)) return () => Promise.resolve([])
  return () => Promise.resolve(undefined)
}

/** A stand-in for the preload bridge. Every method is a vi.fn that does something harmless by
 *  default; `on*` subscriptions keep their callbacks so a test can fire them with `emit`. */
export class ApiFake {
  private readonly fns = new Map<string, Mock>()
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  /** The object installed as window.delegatto. */
  readonly api: FullApi = new Proxy({} as FullApi, {
    get: (_target, prop) => (typeof prop === 'string' ? this.fn(prop as Name) : undefined),
    has: (_target, prop) => typeof prop === 'string'
  })

  /** The mock behind one method, made on first use. */
  fn<K extends Name>(name: K): Mock<FullApi[K] extends Fn ? FullApi[K] : Fn> {
    let fn = this.fns.get(name)
    if (fn === undefined) {
      fn = isSubscription(name) ? vi.fn((cb: (...args: unknown[]) => void) => this.subscribe(name, cb)) : vi.fn(defaultImpl(name))
      this.fns.set(name, fn)
    }
    return fn as never
  }

  /** Replaces what some methods do. Calls are still recorded on their mocks. */
  override(impls: { [K in Name]?: FullApi[K] }): void {
    for (const [name, impl] of Object.entries(impls)) this.fn(name as Name).mockImplementation(impl as never)
  }

  /** Fires a subscription's callbacks, as main sending that event would. */
  emit<K extends EventName>(name: K, ...args: ListenerArgs<K>): void {
    for (const cb of [...(this.listeners.get(name) ?? [])]) cb(...args)
  }

  /** How many callbacks are subscribed to an event right now. */
  listenerCount(name: EventName): number {
    return this.listeners.get(name)?.size ?? 0
  }

  /** The methods called so far, by name. */
  called(): string[] {
    return [...this.fns].filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name)
  }

  /** Back to the defaults, with no calls recorded and nobody subscribed. */
  reset(): void {
    this.fns.clear()
    this.listeners.clear()
  }

  private subscribe(name: string, cb: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(name)
    if (set === undefined) { set = new Set(); this.listeners.set(name, set) }
    set.add(cb)
    return () => { this.listeners.get(name)?.delete(cb) }
  }
}

/** The one fake for this test file, installed as window.delegatto by tests/dom/setup.ts. */
export const fake = new ApiFake()
