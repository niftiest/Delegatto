// Pure helpers shared by renderer components. No React, no window, no
// electron imports -- kept unit-testable under plain vitest and safe to
// import from any renderer module without pulling in DOM or IPC concerns.
// (Task 10 adds two value imports from src/main/jsonl -- isMessageRow and
// buildRenderItems -- to reuse the read path's render model for live rows.
// Both modules are electron- AND node-free (no fs/path/etc at module level,
// unlike their sibling stream.ts), so this stays a pure, renderer-safe file;
// tests/architecture.test.ts's electron-free check covers src/main/jsonl too.)
import type { RenderItem, ChannelRow, SearchHit } from '../shared/types'
import type { ContentBlock } from '../shared/types'
import type { ChannelMeta, ChannelGroup } from '../shared/shell-types'
import type { GithubRepoOption } from '../shared/github-types'
import type { RemoteProject } from '../shared/sync-types'
// Type-only import: NewProjectOptions' canonical home is the IPC contract (both
// the New-Chat dialog and the main process's startNewChat cross that
// boundary with it) -- erased at compile time, so re-exporting it here adds
// no runtime/electron/node dependency, same rationale as engine-ipc-
// contract.ts's own type-only StreamedRow import.
import type { NewProjectOptions } from '../shared/engine-ipc-contract'
import { FOLDER_MISSING, PERMISSION_MODES, type BackgroundTask, type LiveEvent, type PermissionRequest, type PermissionSuggestion } from '../shared/engine-types'
// Type-only: StreamedRow's home module (src/main/jsonl/stream.ts) reads real
// files, but importing just its *type* is erased at compile time -- same
// pattern engine-ipc-contract.ts already uses.
import type { StreamedRow } from '../main/jsonl/stream'
import { isDisplayRow } from '../main/jsonl/parse'
import { rewoundUuids } from '../main/jsonl/rewound'
import { CLEAR_COMMANDS, TERMINAL_ONLY_COMMANDS, type ClaudeAgent, type ClaudeCommand, type CommandSource, type McpServerStatus } from '../shared/claude-info-types'
import { buildRenderItems, collectToolResults } from '../main/jsonl/render'
import { EFFORTS } from '../shared/models'

export type { NewProjectOptions }

/** Derives the display name for a project/channel: the last non-empty path
 *  segment of `cwd`, or `dirName` when `cwd` is null, empty, a bare root
 *  ('/'), a bare drive root ('C:\\'), or otherwise reduces to no segments.
 *  filter(Boolean) before pop() matters: a cwd with a trailing separator
 *  splits to a trailing empty segment, which would otherwise win over the
 *  real folder name and produce a blank label. */
export function channelName(cwd: string | null, dirName: string): string {
  if (cwd === null || cwd === '') return dirName
  const segments = cwd.split(/[\\/]/).filter(Boolean)
  return segments.pop() ?? dirName
}

/** True when an async response's captured request id no longer matches the
 *  latest request id -- i.e. a newer request has since superseded it and the
 *  response must be discarded rather than applied. */
export function isStaleResponse(requestId: number, currentId: number): boolean {
  return requestId !== currentId
}

/** Whether an in-flight `onIndexed` reload (App.tsx) is still authoritative
 *  by the time its `loadTranscript` resolves, i.e. safe to wholesale-replace
 *  `items` with (Task 10 fix pass 2). Two independent guards must BOTH hold:
 *  - `capturedSessionReqId`/`currentSessionReqId`: the existing
 *    `isStaleResponse` session-switch guard -- the user navigated away from
 *    the session this reload was for.
 *  - `capturedGen`/`currentGen`: a NEW guard for a newer turn starting on the
 *    SAME still-open session while the reload was in flight -- e.g. a queued
 *    message dispatched the instant turn A's `result` fires, whose own
 *    `onRows` may already have appended durable rows into `items` before turn
 *    A's reload resolves. Applying that stale reload would wholesale-replace
 *    `items` with the pre-turn-B page, dropping turn B's already-appended
 *    rows from view (self-healing on turn B's own settle, but a real,
 *    avoidable clobber in between). App bumps its `reloadGenRef` at the same
 *    place it flips `running` true for a new turn, so a bumped generation
 *    here means exactly that: a newer turn has since claimed authority over
 *    `items`, and this reload must bail without touching it. */
export function shouldApplyReload(
  capturedSessionReqId: number,
  currentSessionReqId: number,
  capturedGen: number,
  currentGen: number
): boolean {
  return !isStaleResponse(capturedSessionReqId, currentSessionReqId) && capturedGen === currentGen
}

/** Builds a unique, prepend-stable React key per render item. A single
 *  message (uuid) can produce multiple RenderItems (e.g. a text item and a
 *  tool item from the same assistant turn), so the uuid alone is not unique
 *  -- react-virtual requires unique keys. Appending a running per-uuid
 *  counter (reset on each call, computed fresh from the full items array)
 *  makes every key unique while keeping it STABLE across a prepend: when
 *  loadOlder adds older items (with uuids disjoint from every existing
 *  item) before the current array, each existing item keeps the same uuid
 *  and the same position within its own uuid's run, so it is assigned the
 *  same counter value and therefore the same key as before -- only its
 *  array index changed, and the key does not depend on index. */
export function stableItemKeys(items: RenderItem[]): string[] {
  const counts = new Map<string, number>()
  return items.map(item => {
    const n = counts.get(item.uuid) ?? 0
    counts.set(item.uuid, n + 1)
    return `${item.uuid}:${n}`
  })
}

/** Fits a freshly loaded newest page into what's on screen. The page takes over from its
 *  first message on, and everything above stays. Dropping it would change which message
 *  starts the first turn, and a turn is keyed by that message, so a turn longer than a
 *  page would be rebuilt on every reload. `keptAbove` is 0 when the page starts the view
 *  or shares nothing with it, and the page's own paging position then applies. */
export function mergeReloadedPage(current: RenderItem[], page: RenderItem[]): { items: RenderItem[]; keptAbove: number } {
  const first = page[0]
  if (first === undefined) return { items: page, keptAbove: 0 }
  const at = current.findIndex(item => item.uuid === first.uuid)
  if (at <= 0) return { items: page, keptAbove: 0 }
  return { items: [...current.slice(0, at), ...page], keptAbove: at }
}

/** The chat once a message stopped before any reply has been taken back: nothing can
 *  follow it but the note that it was interrupted. */
export function dropCancelledMessage(items: RenderItem[], uuid: string): RenderItem[] {
  const at = items.findIndex(item => item.uuid === uuid)
  return at === -1 ? items : items.slice(0, at)
}

export const CLAUDE_SETUP_URL = 'https://code.claude.com/docs/en/setup'

/** What to say when Claude Code won't start. */
export function spawnErrorNotice(detail: string): string {
  if (detail.startsWith('folder-missing ')) {
    const folder = detail.slice('folder-missing '.length)
    return `This chat's folder, ${folder}, isn't on this PC, so Claude can't run there. It may have been moved, renamed or deleted, or the chat came from another PC. Put the folder back, or for a synced project, set it up on this PC from New chat.`
  }
  return /ENOENT/.test(detail)
    ? `Claude Code isn't installed, or Delegatto can't find it. Install it from ${CLAUDE_SETUP_URL}, or set its path in Settings under Engine.`
    : `Claude couldn't start: ${detail}`
}

/** A message as plain text and web addresses, in order. An address ends before punctuation
 *  that closes the sentence around it, and keeps a bracket that opened inside it. */
export type TextPart = { text: string; url: boolean }

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let at = 0
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let url = match[0]
    for (;;) {
      const trimmed = url.replace(/[.,;:!?*_~]+$/, '')
      const closes = /[)\]}]$/.test(trimmed)
      const opens = closes ? { ')': '(', ']': '[', '}': '{' }[trimmed.at(-1)!]! : ''
      const unmatched = closes && trimmed.split(trimmed.at(-1)!).length > trimmed.split(opens).length
      const next = unmatched ? trimmed.slice(0, -1) : trimmed
      if (next === url) break
      url = next
    }
    if (url.length <= 'https://'.length) continue
    if (match.index > at) parts.push({ text: text.slice(at, match.index), url: false })
    parts.push({ text: url, url: true })
    at = match.index + url.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), url: false })
  return parts
}

/** One message of the user's, as positions in a turn's items: its pictures, which show
 *  above it, and its text. A turn can hold several messages, and each keeps its own. */
export type UserMessageParts = { first: number; images: number[]; texts: number[] }

export function userMessageParts(items: RenderItem[]): UserMessageParts[] {
  const parts: UserMessageParts[] = []
  let uuid: string | null = null
  items.forEach((item, i) => {
    if (item.kind !== 'image' && item.kind !== 'text') return
    if (item.uuid !== uuid || parts.length === 0) { parts.push({ first: i, images: [], texts: [] }); uuid = item.uuid }
    const part = parts[parts.length - 1]!
    if (item.kind === 'image') part.images.push(i)
    else part.texts.push(i)
  })
  return parts
}

/** A contiguous run of render items belonging to one side of the conversation:
 *  a user turn (their text + any pasted images) or a Claude turn (assistant
 *  text, thinking, tool cards, images). `startIndex` is the item's position in
 *  the flat list, so the caller can pull each item's stable key from the same
 *  `stableItemKeys(items)` array and keep prepend-safe reconciliation. */
export type Turn = { role: 'user' | 'assistant' | 'notice'; items: RenderItem[]; startIndex: number }

/** The conversation side an item renders on. text/image carry their own role;
 *  a notice (background-task ping) stands on its own centered lane, attributed
 *  to neither side; thinking and tool are always Claude's (a tool_use is
 *  assistant-initiated, its tool_result is folded into the same tool item by
 *  buildRenderItems). */
function itemRole(item: RenderItem): 'user' | 'assistant' | 'notice' {
  if (item.kind === 'notice') return 'notice'
  return item.kind === 'text' || item.kind === 'image' ? item.role : 'assistant'
}

/** Groups the flat render list into turns so the transcript reads as a
 *  back-and-forth: consecutive same-side items collapse into one turn (so a
 *  Claude turn's text + thinking + tool cards render as a single unit, and a
 *  user turn's text + images stay together). Order is preserved; a single uuid
 *  emitting several items (text + tool) lands them in the same turn. */
/** Drops a slash command as typed when its reply comes right after it ("/model x"
 *  then "Set model to x"): the reply says what happened. A command with no reply
 *  of its own stays, so the chat still shows it ran. */
export function hideAnsweredCommands(items: RenderItem[]): RenderItem[] {
  const answered = (i: number): boolean => {
    const it = items[i]!, next = items[i + 1]
    return it.kind === 'text' && it.command === 'echo' && next?.kind === 'text' && next.command === 'output'
  }
  return items.some((_, i) => answered(i)) ? items.filter((_, i) => !answered(i)) : items
}

export function groupIntoTurns(items: RenderItem[]): Turn[] {
  const turns: Turn[] = []
  items.forEach((item, i) => {
    const role = itemRole(item)
    const last = turns[turns.length - 1]
    if (last !== undefined && last.role === role) last.items.push(item)
    else turns.push({ role, items: [item], startIndex: i })
  })
  return turns
}

/** Clamps `n` into the inclusive [min, max] range. Used to bound resizable
 *  panel widths to sane limits while dragging. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** The first pending permission request that belongs to a chat OTHER than the
 *  one currently open -- what the app-wide blocked-turn banner surfaces. A
 *  request in the OPEN session is handled by its own inline card and must NOT
 *  raise the banner. `dismissed` request ids are skipped so a dismissed banner
 *  stays gone until a new request arrives. */
export function firstBlockedElsewhere(
  byPk: Map<number, PermissionRequest[]>,
  openSessionPk: number | null,
  dismissed?: Set<string>
): { sessionPk: number; req: PermissionRequest } | null {
  for (const [pk, reqs] of byPk) {
    if (pk === openSessionPk) continue
    const req = reqs.find(r => dismissed === undefined || !dismissed.has(r.id))
    if (req !== undefined) return { sessionPk: pk, req }
  }
  return null
}

/** The project directory name embedded in a session file path
 *  (`…/projects/<projectDir>/<sessionId>.jsonl`) -- lets the blocked banner name
 *  the waiting chat by matching it against the channel list's dirName. */
export function projectDirFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(/[\\/]/).filter(p => p.length > 0)
  return parts.length >= 2 ? parts[parts.length - 2]! : null
}

/** Default-avatar initials for a channel name: the first letter
 *  of each word, up to 3 ("Delegatto" -> "CC", "LuckyElkMonitor" -> "LEM").
 *  Words are split on separators (- _ . space /) and camelCase / acronym
 *  boundaries. A single-word name falls back to its first two letters
 *  ("Sheets" -> "SH"). Returns "?" for a name with no alphanumerics. */
export function channelInitials(name: string): string {
  const spaced = name
    .replace(/[^a-zA-Z0-9]+/g, ' ')          // separators -> spaces
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')  // camelCase boundary: "aC" -> "a C"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronym boundary: "CLBox" -> "CL Box"
    .trim()
  const words = spaced.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return words.slice(0, 3).map(w => w[0]!).join('').toUpperCase()
}

/** Paper's, for when there's no page to ask (tests) or a theme sets none. */
const DEFAULT_AVATAR_COLORS = ['#2350D0', '#1F8A4C', '#B7590D', '#B23A48', '#6A4FC2', '#0B7A8A', '#8A5A2B', '#4F6B1F']
let avatarColorsCache: { key: string; colors: string[] } | null = null

/** The current theme's avatar colours: its `--avatar-colors` variable, a comma-separated
 *  list, so a theme file on this PC can set its own too. */
export function themeAvatarColors(): string[] {
  if (typeof document === 'undefined') return DEFAULT_AVATAR_COLORS
  const key = `${document.documentElement.dataset.theme ?? ''}|${document.getElementById('local-theme')?.textContent ?? ''}`
  if (avatarColorsCache?.key !== key) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--avatar-colors')
    const colors = raw.split(',').map(c => c.trim()).filter(c => /^#[0-9a-f]{6}$/i.test(c))
    avatarColorsCache = { key, colors: colors.length > 0 ? colors : DEFAULT_AVATAR_COLORS }
  }
  return avatarColorsCache.colors
}

/** Deterministic avatar background color for a seed (the channel name), so a
 *  channel keeps the same color across renders and launches, within a theme. */
export function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const colors = themeAvatarColors()
  return colors[h % colors.length]!
}

/** Compact relative timestamp for the nav preview line, Google-Messages style:
 *  under a minute -> "now"; under an hour -> "5m"; under a day -> "3h"; under a
 *  week -> the weekday ("Mon"); otherwise a short date ("Jul 17", adding the
 *  year only when it differs from the reference year). `nowMs` is injectable so
 *  the function is deterministic under test. Returns '' for a null/unparseable
 *  timestamp. */
export function relativeTime(iso: string | null, nowMs: number = Date.now()): string {
  if (iso === null) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diffMs = nowMs - then
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const days = Math.floor(hr / 24)
  const d = new Date(then)
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear()
  return d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** A message clock in the viewer's locale and timezone: "5:34 PM" (or 24h
 *  where the locale prefers it). The stored ts is UTC ISO; toLocaleTimeString
 *  renders it in local time. Returns '' for a null/unparseable timestamp. */
export function formatClock(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A stable per-local-calendar-day key (YYYYMMDD in the viewer's timezone), or
 *  null for a null/unparseable timestamp. Two timestamps share a key iff they
 *  fall on the same local day -- what the transcript's day dividers group by. */
export function localDayKey(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
}

/** Day-divider label: "Today" / "Yesterday" for the two most
 *  recent local days, otherwise a full localized date ("August 2, 2026").
 *  `nowMs` is injectable so the function is deterministic under test. */
export function dayDividerLabel(iso: string | null | undefined, nowMs: number = Date.now()): string {
  const key = localDayKey(iso)
  if (key === null) return ''
  const now = new Date(nowMs)
  const todayKey = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate()
  if (key === todayKey) return 'Today'
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const yesterdayKey = y.getFullYear() * 10000 + (y.getMonth() + 1) * 100 + y.getDate()
  if (key === yesterdayKey) return 'Yesterday'
  return new Date(Date.parse(iso as string)).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

// ── Composer (Plan 2 Task 7) ────────────────────────────────────────────────

/** Threshold above which a paste collapses into a removable chip instead of
 *  flooding the textarea. Either condition alone is enough: a single 4000-
 *  char line with no newlines would otherwise sail through the line-count
 *  check, and 40 one-word lines would sail through the char-count check. */
const PASTE_CHAR_THRESHOLD = 800
const PASTE_LINE_THRESHOLD = 10

/** Decides whether a just-pasted string is "large" enough to collapse into a
 *  `[Pasted text #N · L lines]` chip rather than being inserted verbatim into
 *  the composer textarea (a multi-thousand-line paste otherwise freezes the
 *  box measuring/reflowing that much text on every keystroke). `lineCount`
 *  counts `\n`-separated segments, so an empty string is 1 (empty) line, not
 *  0 -- matching how a textarea would display it. */
export function collapsePastedText(text: string): { isLarge: boolean; lineCount: number; charCount: number } {
  const lineCount = text.split('\n').length
  const charCount = text.length
  const isLarge = charCount > PASTE_CHAR_THRESHOLD || lineCount > PASTE_LINE_THRESHOLD
  return { isLarge, lineCount, charCount }
}

/** A pasted-text chip queued alongside the box text, combined into the
 *  outgoing message by buildOutgoingText at send time. */
export type PastedTextChip = { id: string; text: string; lineCount: number }

/** An image attached to the composer (pasted or dropped), already decoded
 *  from its data URL. `id` is a local key for chip rendering/removal only --
 *  it is never sent to the engine (see EngineImageInput, which is just
 *  `{mediaType, dataBase64}`). */
export type ComposerImage = { id: string; mediaType: string; dataBase64: string; name?: string }

/** A message composed while a turn is running, parked in the send queue
 *  until the turn ends. `text` is already the fully combined outgoing text
 *  (box text + any pasted chips folded in via buildOutgoingText at enqueue
 *  time) -- the queue itself has no notion of separate pasted chips. */
/** `uuid` means it's already in Claude Code's queue under that name, to be taken in at
 *  Claude's next step. Without one it's held here until the turn ends: slash commands,
 *  which have to run on their own, and anything whose process died. */
/** `typed: false` for one that mustn't go as typed by the user (see sendsAsTyped). */
export type QueuedMessage = { id: string; text: string; images: ComposerImage[]; uuid?: string | null; typed?: boolean }

export type QueueAction =
  | { type: 'add'; msg: QueuedMessage }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; dir: 'up' | 'down' }
  | { type: 'clear' }
  | { type: 'set'; items: QueuedMessage[] }
  /** Claude Code took this one in. */
  | { type: 'removeUuid'; uuid: string }
  /** Claude Code dropped this one, so it now waits here. */
  | { type: 'holdUuid'; uuid: string }
  /** The process is gone, and what it held with it: all of it has to be sent again. */
  | { type: 'holdAll' }

/** Reducer for the composer's queued-message list. `move` swaps a message
 *  with its immediate neighbor; moving the top item up (or the bottom item
 *  down) is a no-op rather than clamping/wrapping, since there is nowhere
 *  sensible for it to go. Every branch returns a fresh array except the
 *  documented no-ops, which return `state` unchanged (so callers -- e.g. a
 *  React reducer's identity-based re-render skip -- can compare by
 *  reference). */
export function queueReducer(state: QueuedMessage[], action: QueueAction): QueuedMessage[] {
  switch (action.type) {
    case 'add':
      return [...state, action.msg]
    case 'remove':
      return state.filter(m => m.id !== action.id)
    case 'move': {
      const idx = state.findIndex(m => m.id === action.id)
      if (idx === -1) return state
      const swapWith = action.dir === 'up' ? idx - 1 : idx + 1
      if (swapWith < 0 || swapWith >= state.length) return state
      const next = state.slice()
      const tmp = next[idx]!
      next[idx] = next[swapWith]!
      next[swapWith] = tmp
      return next
    }
    case 'clear':
      return []
    case 'set':
      return action.items
    case 'removeUuid':
      return state.filter(m => m.uuid !== action.uuid)
    case 'holdUuid':
      return state.map(m => m.uuid === action.uuid ? { ...m, uuid: null } : m)
    case 'holdAll':
      return state.map(m => ({ ...m, uuid: null }))
  }
}

const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/

/** Parses a `data:<mediaType>;base64,<payload>` URL (what `FileReader.
 *  readAsDataURL` produces for a pasted/dropped image) into the shape the
 *  engine's image blocks need. Returns null for anything that isn't a
 *  base64 data URL -- a bare URL, a non-base64 data URL, or a malformed one
 *  missing its payload -- so callers can silently drop what they can't use
 *  rather than sending a garbage block to the engine. */
export function imageFromDataUrl(dataUrl: string, id: string, name?: string): ComposerImage | null {
  const m = DATA_URL_RE.exec(dataUrl)
  if (m === null) return null
  const mediaType = m[1]!
  const dataBase64 = m[2]!
  return name === undefined ? { id, mediaType, dataBase64 } : { id, mediaType, dataBase64, name }
}

/** Combines the composer's box text with any pasted-text chips into the
 *  final outgoing message: the box text first, then each chip as its own
 *  labeled block ("[Pasted text #N · L lines]") in the order it was pasted.
 *  A whitespace-only box text is dropped entirely (rather than leaving a
 *  leading blank line) when there's at least one chip to carry the message;
 *  with no chips at all the box text is returned exactly as given. */
export function buildOutgoingText(boxText: string, pastedTexts: PastedTextChip[]): string {
  if (pastedTexts.length === 0) return boxText
  const blocks = pastedTexts.map((c, i) => `[Pasted text #${i + 1} · ${c.lineCount} lines]\n${c.text}`)
  const parts = boxText.trim().length === 0 ? blocks : [boxText, ...blocks]
  return parts.join('\n\n')
}

/** Pure decision for Transcript's scroll behavior: a session's first page of
 *  items should land the view at the BOTTOM (the newest message, matching
 *  every chat app's default), while every subsequent items change for the
 *  same session -- a `loadOlder` prepend -- must instead preserve the
 *  reading position rather than re-snapping to the bottom.
 *
 *  `alreadyScrolledToBottom` is true once the initial scroll-to-bottom has
 *  already happened for the currently-open session (Transcript tracks this
 *  in a ref that starts false and is set true right after the scroll). This
 *  returns true only for the single moment items go from empty to non-empty
 *  for a freshly opened/switched session. */
export function shouldScrollToBottom(alreadyScrolledToBottom: boolean, itemCount: number): boolean {
  return !alreadyScrolledToBottom && itemCount > 0
}

/** Whether a chat still follows its end after a scroll. Any move up, however small, is
 *  the reader leaving, and is the only thing that does. A move down comes back once
 *  it's near the end. At the very end it's always following, which also covers the
 *  browser pulling the position up because the content got shorter. */
export function followAfterScroll(following: boolean, top: number, lastTop: number, gap: number, margin: number): boolean {
  if (gap <= 1) return true
  if (top < lastTop) return false
  return following || gap < margin
}

// ── New-chat dialog (Plan 2 Task 8) ─────────────────────────────────────────

/** The New-Chat dialog's own last-used values, merged UNDER whatever the
 *  dialog's form fields currently hold. `cwd` is optional here (unlike
 *  NewProjectOptions, where it is required post-resolution) since there may be
 *  no last-used directory yet on a fresh install. */
export type NewChatDefaults = { cwd?: string; skipPermissions: boolean; model?: string; effort?: string }

/** Merges the New-Chat dialog's (possibly partial) form input over its
 *  defaults into a validated NewProjectOptions, or an error string.
 *
 *  - `cwd`: input wins over `defaults.cwd`; trimmed; empty (or whitespace-
 *    only, or omitted from both) is the one hard validation failure -- there
 *    is nowhere to run `claude` without a working directory.
 *  - `skipPermissions`: input wins when present, else falls back to the
 *    default (never silently coerced to a fixed value -- a checkbox's
 *    current state always IS present in practice, but the fallback keeps
 *    this pure function correct for a dialog that hasn't touched the field
 *    yet, e.g. before the user's first interaction).
 *  - `model`/`effort`: input wins over the default, else undefined -- the
 *    CLI's own default when neither is set.
 *  - `name`: trimmed; empty (or whitespace-only) becomes undefined rather
 *    than an empty-string title. Has no default -- a session name is always
 *    either what the user typed or nothing. */
export function resolveNewProjectOptions(
  input: Partial<NewProjectOptions>,
  defaults: NewChatDefaults
): { ok: true; options: NewProjectOptions } | { ok: false; error: string } {
  const cwd = (input.cwd ?? defaults.cwd ?? '').trim()
  if (cwd.length === 0) return { ok: false, error: 'Choose a working directory' }

  const skipPermissions = input.skipPermissions ?? defaults.skipPermissions
  const model = input.model ?? defaults.model
  const effort = input.effort ?? defaults.effort
  const trimmedName = input.name?.trim()

  const options: NewProjectOptions = { cwd, skipPermissions }
  if (model !== undefined) options.model = model
  if (effort !== undefined) options.effort = effort
  if (trimmedName !== undefined && trimmedName.length > 0) options.name = trimmedName

  return { ok: true, options }
}

// ── Permission + plan-approval cards (Plan 2 Task 9) ────────────────────────

/** Guarded field lookup shared by the summarizer/rule-preview below: `input`
 *  is `unknown` end-to-end (it's whatever the CLI's tool call carried across
 *  the wire, tolerantly parsed by the main-process bridge -- see
 *  permission-bridge.ts's own `firstStringField`, which this deliberately
 *  mirrors so the renderer never has to import a main-process module to stay
 *  in sync). Non-object/array input (a bare string, a number, null,
 *  undefined) returns null rather than throwing, so summarize/preview never
 *  crash on a malformed request. */
function firstStringField(input: unknown, keys: string[]): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const obj = input as Record<string, unknown>
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

const SUMMARY_MAX = 80

/** A concise, human-readable one-line summary of a tool request for a
 *  PermissionCard's header: `Bash + {command}` shows the command verbatim
 *  (truncated), `Read`/`Edit`/`Write` show the path, anything else falls back
 *  to the tool name plus a couple of `key=value` pairs (same shape ToolCard
 *  already uses for its own summary line, for a consistent look). Never
 *  throws on non-object input. */
export function summarizePermissionRequest(tool: string, input: unknown): string {
  if (tool === 'Bash') {
    const command = firstStringField(input, ['command'])
    if (command === null) return 'Bash'
    const shown = command.length > SUMMARY_MAX ? `${command.slice(0, SUMMARY_MAX)}…` : command
    return `Bash: ${shown}`
  }

  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    const path = firstStringField(input, ['file_path', 'path'])
    return path === null ? tool : `${tool}: ${path}`
  }

  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
      .join(' ')
    return entries.length > 0 ? `${tool}: ${entries}` : tool
  }

  return tool
}

/** The next mode Shift+Tab goes to. From a mode outside the list, it starts again. */
/** A mode's name for people. A mode we don't list goes by what Claude Code calls it. */
export function permissionModeLabel(mode: string): string {
  return PERMISSION_MODES.find(m => m.value === mode)?.label ?? mode
}

export function nextPermissionMode(mode: string): string {
  const at = PERMISSION_MODES.findIndex(m => m.value === mode)
  return PERMISSION_MODES[(at + 1) % PERMISSION_MODES.length]!.value
}

/** What "don't ask again" would do, in words, from what Claude Code offers. */
export function suggestionLabel(suggestions: PermissionSuggestion[]): string | null {
  const parts = suggestions.flatMap((s): string[] => {
    if (s.type === 'addRules' || s.type === 'replaceRules') {
      return (s.rules ?? []).map(r => (r.ruleContent !== undefined && r.ruleContent.length > 0 ? `${r.toolName ?? 'tool'}(${r.ruleContent})` : r.toolName ?? 'this tool'))
    }
    if (s.type === 'addDirectories') return (s.directories ?? []).map(d => `access to ${d}`)
    return []
  })
  return parts.length > 0 ? parts.join(', ') : null
}

export type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string }
export type PermissionDiff = { path: string | null; lines: DiffLine[]; hiddenLines: number }

const MAX_DIFF_LINES = 400

/** The lines an Edit or Write would change, or null for any other tool or an input without them.
 *  Lines both sides share at the start and end stay as context, and the middle shows as removed
 *  then added. */
export function permissionDiff(tool: string, input: unknown): PermissionDiff | null {
  if (typeof input !== 'object' || input === null) return null
  const i = input as Record<string, unknown>
  const path = typeof i.file_path === 'string' ? i.file_path : null
  let lines: DiffLine[]
  if (tool === 'Write' && typeof i.content === 'string') {
    lines = i.content.split('\n').map(text => ({ kind: 'added' as const, text }))
  } else if (tool === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    const before = i.old_string.split('\n')
    const after = i.new_string.split('\n')
    let start = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    let end = 0
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
    lines = [
      ...before.slice(0, start).map(text => ({ kind: 'same' as const, text })),
      ...before.slice(start, before.length - end).map(text => ({ kind: 'removed' as const, text })),
      ...after.slice(start, after.length - end).map(text => ({ kind: 'added' as const, text })),
      ...before.slice(before.length - end).map(text => ({ kind: 'same' as const, text }))
    ]
  } else {
    return null
  }
  return { path, lines: lines.slice(0, MAX_DIFF_LINES), hiddenLines: Math.max(0, lines.length - MAX_DIFF_LINES) }
}

/** Claude asking the user something, with its own card rather than a permission's. */
export function isQuestion(tool: string): boolean {
  return tool === 'AskUserQuestion'
}

/** What to say about a failed API call being retried. */
export function retryLabel(r: { attempt: number; maxRetries: number; error: string | null }): string {
  const count = r.maxRetries > 0 ? `attempt ${r.attempt} of ${r.maxRetries}` : `attempt ${r.attempt}`
  return `Retrying after an API error (${count}${r.error !== null ? `: ${r.error}` : ''})`
}

/** Plan mode surfaces as a specific tool request, `ExitPlanMode` -- treat that
 *  as a plan-approval card (accept/reject the plan) rather than an ordinary
 *  permission card (allow/allow-always/deny/edit). */
export function isPlanApproval(tool: string): boolean {
  return tool === 'ExitPlanMode'
}

/** Bash rule heuristic -- MUST match permission-bridge.ts's own `bashRule`
 *  exactly (see the parity test in tests/renderer-lib.test.ts, which imports
 *  the real main-process `allowAlwaysRule` and asserts equality against this
 *  module's preview for several tool/input pairs). Keep the two in sync by
 *  hand if either ever changes -- the parity test is what catches drift. */
function bashRulePreview(input: unknown): string {
  const command = firstStringField(input, ['command'])
  if (command === null) return 'Bash'
  const tokens = command.trim().split(/\s+/).filter(t => t.length > 0)
  if (tokens.length === 0) return 'Bash'
  if (tokens.length === 1) return `Bash(${tokens[0]} *)`
  return `Bash(${tokens.slice(0, -1).join(' ')} *)`
}

/** Renderer-side PREVIEW of the rule `allow_always` will persist (the real
 *  derivation, `allowAlwaysRule`, lives in the main-process permission-bridge
 *  and actually gets stored -- this function only needs to show the user what
 *  they're about to grant, matching that logic exactly so the preview never
 *  lies). Never throws on non-object input. */
export function previewAllowAlwaysRule(tool: string, input: unknown): string {
  if (tool === 'Bash') return bashRulePreview(input)

  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') {
    const path = firstStringField(input, ['file_path', 'path'])
    if (path !== null) return `${tool}(${path})`
  }

  return tool
}

/** Extracts the plan text a PlanApprovalCard displays. ExitPlanMode's request
 *  input is commonly `{ plan: string }`; anything else (a differently-shaped
 *  payload, or no object at all) falls back to the raw JSON so the card never
 *  renders blank. Never throws on non-object input. */
export function planTextFromInput(input: unknown): string {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const plan = (input as Record<string, unknown>).plan
    if (typeof plan === 'string') return plan
  }
  return JSON.stringify(input, null, 2) ?? ''
}

/** Parses a PermissionCard's edited-JSON textarea into the `editedInput`
 *  `resolvePermission` expects, or a human-readable error to show inline
 *  instead of submitting. Never throws -- `JSON.parse` failures are caught
 *  and turned into the error branch. */
export function parseEditedInput(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' }
  }
}

// ── Live streaming reconciliation (Plan 2 Task 10) ──────────────────────────
//
// Two streams describe the same turn: `engine:event` LiveEvents (delta/
// assistant/result -- fast, transient, arrive before the file catches up) and
// `engine:rows` StreamedRows (the durable JSONL rows the watcher tails --
// slower, the source of truth). The model App.tsx wires these into:
//   - livePreview accumulates delta/assistant text into a transient "Claude
//     is typing" bubble, rendered at the bottom of Transcript while running.
//   - appendRowsToItems appends the durable rows' render items (built via the
//     SAME buildRenderItems the read path uses) to the transcript.
//   - on `result`, livePreview clears -- the durable rows (already appended
//     as they arrived, or about to) are trusted from then on. No token-by-
//     token diffing against the file is attempted; that would be fragile.

/** Transient "assistant is typing" preview built from accumulating engine
 *  LiveEvents while a turn streams. Not the durable render -- cleared on
 *  `result`, at which point the durable `engine:rows` delivery (already
 *  reconciled into the transcript via appendRowsToItems) is trusted.
 *
 *  `sealed` fixes a cross-message run-on bug (Task 10 review Finding 2): a
 *  tool-calling turn emits multiple assistant messages in sequence (text ->
 *  tool_use -> text again), but `delta` carries no message-boundary
 *  information of its own -- it's just a token-level chunk. Without a seal, a
 *  second message's deltas would append onto the first message's
 *  already-finished text, garbling the two together until the next
 *  `assistant` event replaced the mess wholesale. `sealed` tracks whether the
 *  CURRENT preview text is a finished, complete message (set by an
 *  `assistant` event that carried text) -- the next `delta` checks this flag
 *  to decide whether to append (mid-message, unsealed) or start fresh
 *  (a new message's first delta, arriving right after a sealed one). */
export type LivePreview = { text: string; sealed: boolean }

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** Reduces one LiveEvent into the next livePreview state (or null to clear).
 *  - `delta`: a token-level chunk. Appends to the current preview's text when
 *    it isn't sealed (still mid-message, or nothing accumulated yet -- `prev
 *    === null` behaves like an unsealed empty preview). When the current
 *    preview IS sealed (the previous message finished via an `assistant`
 *    event), this delta belongs to a NEW message -- starts a fresh, unsealed
 *    preview from just this delta's text instead of appending onto the
 *    finished one.
 *  - `assistant`: a COMPLETE message snapshot, not an incremental delta --
 *    replaces the preview wholesale rather than appending, and SEALS it (so
 *    the next delta, if this turn has another message coming, starts fresh
 *    rather than running on). Only replaces when it actually carries text: a
 *    tool-only assistant message (no text blocks -- e.g. a message that's
 *    purely a tool_use) leaves whatever text preview is already accumulating
 *    alone, rather than blanking it.
 *  - `result`: the turn is done -- clear the preview. The durable
 *    `engine:rows` delivery is the source of truth from here on.
 *  - `init`/`rate_limit`/`other`: carry no preview-relevant text; the
 *    preview passes through unchanged. */
export function reduceLivePreview(prev: LivePreview | null, event: LiveEvent): LivePreview | null {
  switch (event.kind) {
    case 'delta':
      if (prev === null || prev.sealed) return { text: event.text, sealed: false }
      return { text: prev.text + event.text, sealed: false }
    case 'assistant': {
      const text = textFromBlocks(event.blocks)
      return text.length > 0 ? { text, sealed: true } : prev
    }
    case 'result':
      // A finished bubble stays until its saved row replaces it, which can land a moment
      // after the result. Clearing it here makes the reply blink out and back.
      return prev !== null && prev.sealed ? prev : null
    case 'exit':
      // Task 10 review Fix 1: an `exit` LiveEvent means the transport's
      // process is gone -- whether or not it ever sent its own `result` --
      // so there is no more streaming to preview. Same clear as `result`.
      return null
    case 'init':
    case 'rate_limit':
    case 'status':
    case 'usage':
    case 'suggestion':
    case 'background':
    case 'taskProgress':
    case 'commandLifecycle':
    case 'permissionAsked':
    case 'permissionCancelled':
    case 'permissionGone':
    case 'elicitation':
    case 'elicitationGone':
    case 'retry':
    case 'hook':
    case 'informational':
    case 'writesLost':
    case 'thinkingDelta':
    case 'taskStarted':
    case 'subagentStep':
    case 'taskEnded':
    case 'other':
      return prev
  }
}

/** Whether these items include something the user sent, as opposed to Claude's reply. */
export function hasUserRenderItem(items: RenderItem[]): boolean {
  return items.some(it => (it.kind === 'text' || it.kind === 'image') && it.role === 'user')
}

/** Whether `event` marks the definitive end of a turn for App's `running`
 *  flag (Task 10 review Fix 1). `result` always did (App's onEvent handler
 *  checked it inline before this fix existed); this widens that to every
 *  other way a turn can end without ever producing a `result`:
 *   - `exit`: the transport's process terminated on its own -- a spawn
 *     failure (claude not on PATH), an Esc-triggered SIGINT, or a mid-turn
 *     crash. Synthesized by SessionPool (see engine-types.ts), never parsed
 *     off the wire.
 *   - `other` with type `refused-external-live` / `unknown-session`: the
 *     pool/coordinator refused to even attempt the send -- no transport was
 *     ever spawned, so no `result`/`exit` will ever follow either.
 *  Without this, any of the above left `running` stuck true forever: the
 *  composer stayed wedged in "streaming" mode, unable to un-queue messages
 *  or accept a retry. */
export function clearsRunning(event: LiveEvent): boolean {
  if (event.kind === 'result' || event.kind === 'exit') return true
  return event.kind === 'other' && (event.type === 'refused-external-live' || event.type === 'unknown-session' || event.type === FOLDER_MISSING)
}

/** Computes a stable identity per item in `list`, independently for that list
 *  (the counter always restarts at 0) -- shared by appendRowsToItems' two
 *  passes below. A tool item with a real toolUseId keys on that alone (stable
 *  regardless of position: the same tool_use id always means the same
 *  logical tool call, however many batches it takes to arrive). Every other
 *  item keys on uuid + kind + "which occurrence of this uuid+kind is this,
 *  within THIS list" -- mirroring stableItemKeys' own scheme. Since a JSONL
 *  row's uuid is unique to that one line, the only way the same uuid+kind
 *  pair can recur at the same occurrence-within-its-own-list position across
 *  two independently-keyed lists is a genuine re-delivery of the identical
 *  row (not a coincidence) -- which is exactly the case appendRowsToItems
 *  needs to detect and drop. */
function keysOf(list: RenderItem[]): string[] {
  const seen = new Map<string, number>()
  return list.map(item => {
    if (item.kind === 'tool' && item.toolUseId.length > 0) return `tool:${item.toolUseId}`
    const base = `${item.uuid}:${item.kind}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return `${base}:${n}`
  })
}

/** Appends durable render items (from `engine:rows`, already converted
 *  through buildRenderItems -- see renderItemsFromStreamedRows below) to the
 *  transcript's current items, de-duping by stable item identity so a
 *  re-delivered row (a session re-open racing the watcher's live tail, or a
 *  restarted watcher re-emitting from an earlier offset) never double-
 *  renders. Returns `items` BY REFERENCE, unchanged, when every candidate
 *  turns out to be a duplicate -- lets a caller skip a state update entirely
 *  on a no-op batch. */
export function appendRowsToItems(items: RenderItem[], newItems: RenderItem[]): RenderItem[] {
  const existingKeys = new Set(keysOf(items))
  const newKeys = keysOf(newItems)
  const appendedKeys = new Set<string>()
  const toAppend: RenderItem[] = []
  for (let i = 0; i < newItems.length; i++) {
    const key = newKeys[i]!
    if (existingKeys.has(key) || appendedKeys.has(key)) continue
    appendedKeys.add(key)
    toAppend.push(newItems[i]!)
  }
  return toAppend.length === 0 ? items : [...items, ...toAppend]
}

/** True when `items` contains at least one render item durably authored by
 *  the assistant: a text message with `role: 'assistant'`, or any `tool`
 *  item (a tool_use is always assistant-initiated -- RenderItem's `tool`
 *  variant carries no separate `role` field because there is only ever one
 *  possible owner). Used by App's onRows handler (Task 10 review Fix 5) to
 *  decide whether a batch of just-appended durable rows should seal off the
 *  transient livePreview bubble for the message they belong to. */
export function hasAssistantRenderItem(items: RenderItem[]): boolean {
  return items.some(item => (item.kind === 'text' && item.role === 'assistant') || item.kind === 'tool')
}

/** Decides the next livePreview once a batch of durable rows has landed in
 *  `items` (Task 10 review Fix 5 -- double-render during tool-using turns):
 *  a tool-calling turn's first message SEALS its livePreview bubble (via
 *  reduceLivePreview's `assistant` case) the instant its own `assistant`
 *  LiveEvent arrives -- which can be well before the watcher's durable tail
 *  catches up, since a tool call in between can take arbitrarily long. Left
 *  alone, that sealed bubble and the durable row it duplicates BOTH render
 *  for the whole intervening tool call. Once the durable row for that same
 *  message has actually landed (`hasDurableAssistantRow` true), the durable
 *  item is authoritative and the sealed bubble must go -- but ONLY a sealed
 *  one: an UNSEALED preview is the CURRENT in-progress message still
 *  streaming, and must be left alone, or a live turn's own typing indicator
 *  would flicker out mid-message every time an unrelated durable row (e.g.
 *  the user's own echoed message) lands. */
export function suppressSealedPreview(prev: LivePreview | null, hasDurableAssistantRow: boolean): LivePreview | null {
  if (!hasDurableAssistantRow) return prev
  return prev !== null && prev.sealed ? null : prev
}

/** Converts newly-tailed durable JSONL rows (from `engine:rows`) into render
 *  items via the SAME model the read path's loadTranscript uses
 *  (buildRenderItems) -- these are the durable, source-of-truth version of
 *  whatever the livePreview was approximating live. Non-message rows
 *  (file-history-snapshot, summary, attachment, ...) are filtered out first,
 *  matching loadTranscript's own isMessageRow filter.
 *
 *  buildRenderItems only pairs a tool_result with a tool_use when both are in
 *  the SAME `rows` array. A result normally lands in a later batch than its
 *  call: applyStreamedToolResults fills those in. */
export function renderItemsFromStreamedRows(rows: StreamedRow[]): RenderItem[] {
  const all = rows.map(r => r.row)
  const rewound = rewoundUuids(all)
  return buildRenderItems(all.filter(isDisplayRow).filter(row => !rewound.has(row.uuid)))
}

/** Fills in results that arrived after their tool call was already showing.
 *  Returns the same array when there's nothing to change. */
export function applyStreamedToolResults(items: RenderItem[], rows: StreamedRow[]): RenderItem[] {
  const results = collectToolResults(rows.map(r => r.row).filter(isDisplayRow))
  if (results.size === 0) return items
  let changed = false
  const next = items.map(item => {
    if (item.kind !== 'tool' || item.result !== null) return item
    const result = results.get(item.toolUseId)
    if (result === undefined) return item
    changed = true
    return { ...item, result }
  })
  return changed ? next : items
}

export type PendingTool = { toolUseId: string; name: string; ts: string | null }

/** The current turn's tool calls still waiting for a result, oldest first. Only
 *  looks back to the last thing the user said: an older call with no result
 *  belongs to a turn that was interrupted, not to anything still running. */
export function pendingTools(items: RenderItem[], running: boolean): PendingTool[] {
  if (!running) return []
  const pending: PendingTool[] = []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'text' && item.role === 'user') break
    if (item.kind === 'tool' && item.result === null && item.toolUseId.length > 0) {
      pending.unshift({ toolUseId: item.toolUseId, name: item.name, ts: item.ts ?? null })
    }
  }
  return pending
}

/** After this long without a word from Claude Code, the working line says so. */
export const SILENCE_NOTICE_MS = 120_000

/** The bracketed details on the working line. The step timer covers a running
 *  tool, so "no output" only appears while no tool is running: it's the case
 *  (a stalled reply) nothing else on the line would reveal. */
export function workingDetails(d: {
  now: number; startedAt: number; tokens: number; pending: PendingTool[]; lastActivity: number; quiet: boolean
}): string[] {
  const out: string[] = []
  const oldest = d.pending[0]
  if (!d.quiet && oldest !== undefined) {
    const others = d.pending.length > 1 ? ` +${d.pending.length - 1}` : ''
    const since = oldest.ts !== null ? Date.parse(oldest.ts) : NaN
    out.push(`${oldest.name}${others} running${Number.isNaN(since) ? '' : ` ${elapsedLabel(d.now - since)}`}`)
  }
  out.push(`turn ${elapsedLabel(d.now - d.startedAt)}`)
  if (d.tokens > 0) out.push(`↓ ${tokenLabel(d.tokens)} tokens`)
  if (!d.quiet && oldest === undefined && d.now - d.lastActivity >= SILENCE_NOTICE_MS) {
    out.push(`no output for ${elapsedLabel(d.now - d.lastActivity)}`)
  }
  return out
}

/** One line about a background task: what it is, what it's doing, how long it's taken. */
export function backgroundTaskLabel(task: BackgroundTask, now: number): { title: string; details: string[] } {
  const kind = task.type === 'local_bash' ? 'Bash' : task.type === 'local_agent' ? (task.agent ?? 'Agent') : task.type.replace(/^local_/, '')
  const details = [elapsedLabel(now - task.startedAt)]
  if (task.lastTool !== null) details.push(task.lastTool)
  if (task.tokens !== null && task.tokens > 0) details.push(`${tokenLabel(task.tokens)} context`)
  return { title: task.description.length > 0 ? `${kind}: ${task.description}` : kind, details }
}

/** Live-turn state for the LiveIndicator badge: 'idle' when no turn is
 *  running, 'streaming' while one is running with nothing queued behind it,
 *  'queued' once the Composer has parked messages waiting for this turn to
 *  finish. `queuedCount` is meaningless while not running (the Composer only
 *  ever queues while `running` is true), so it's ignored in that case rather
 *  than trusted -- a stale nonzero count from a component that hasn't yet
 *  reset for a new session can't leak a spurious 'queued' state. */
export function liveIndicatorState(running: boolean, queuedCount: number): 'idle' | 'streaming' | 'queued' {
  if (!running) return 'idle'
  return queuedCount > 0 ? 'queued' : 'streaming'
}

// ── Nav metadata: rename / favorite / group / icon (Plan 3 Task 2) ─────────
//
// The nav's display data source is ChannelRow (ProjectSummary + ChannelMeta,
// declared in shared/types.ts). These helpers are pure so the precedence/
// grouping/positioning rules are fully unit-tested without any DOM.

/** The channel's display name: the app-owned `friendlyName` wins over the
 *  derived `channelName(cwd, dirName)`. `friendlyName` is already normalized
 *  by the metadata store (setFriendlyName trims and stores empty/whitespace
 *  as null), so this is a simple nullish-coalesce -- no re-trimming needed
 *  here. */
export function resolveChannelName(meta: ChannelMeta, cwd: string | null, dirName: string): string {
  return meta.friendlyName ?? channelName(cwd, dirName)
}

/** The icon a nav row (or IconPicker preview) actually renders: the user's
 *  custom icon verbatim (emoji/color/image), or -- for the `initials` kind,
 *  which carries no data of its own -- the same deterministic
 *  initials-avatar default the pre-metadata nav always used
 *  (channelInitials/avatarColor, seeded off the resolved display `name` so
 *  two channels with the same name keep the same look, and a renamed channel
 *  gets a fresh deterministic color/initials rather than keeping stale ones
 *  seeded off its old name). */
export type ResolvedIcon =
  | { kind: 'initials'; text: string; color: string }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'color'; color: string }
  | { kind: 'image'; dataUrl: string }

/** Resolve any ChannelIcon against a display name into what actually renders
 *  (initials get deterministic text+color seeded off the name). Shared by
 *  channels and groups. */
export function resolveIconValue(icon: ChannelMeta['icon'], name: string): ResolvedIcon {
  switch (icon.kind) {
    case 'emoji': return { kind: 'emoji', emoji: icon.emoji }
    case 'color': return { kind: 'color', color: icon.color }
    case 'image': return { kind: 'image', dataUrl: icon.dataUrl }
    case 'initials': return { kind: 'initials', text: channelInitials(name), color: avatarColor(name) }
  }
}

export function resolveChannelIcon(meta: ChannelMeta, name: string): ResolvedIcon {
  return resolveIconValue(meta.icon, name)
}

/** A group's rendered icon: its custom icon, or initials of the group name. */
export function resolveGroupIcon(group: ChannelGroup): ResolvedIcon {
  return resolveIconValue(group.icon, group.name)
}

/** One rendered section of the nav: a header + its member channels.
 *  `groupId` is only present on `kind: 'group'` sections (the group's own
 *  id, for "move to group"/right-click targeting and React keys). */
export type NavSection =
  | { kind: 'starred'; title: string; channels: ChannelRow[] }
  | { kind: 'group'; groupId: number; title: string; icon: ChannelMeta['icon']; channels: ChannelRow[] }
  | { kind: 'time'; bucket: TimeBucket; title: string; channels: ChannelRow[] }
  | { kind: 'hidden'; title: string; channels: ChannelRow[] }
  | { kind: 'archived'; title: string; channels: ChannelRow[] }

/** Recency buckets the ungrouped channels fall into, most-recent first, so the
 *  chats you touched lately sit at the top without scrolling. */
export type TimeBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older'
const TIME_BUCKETS: { bucket: TimeBucket; title: string }[] = [
  { bucket: 'today', title: 'Today' },
  { bucket: 'yesterday', title: 'Yesterday' },
  { bucket: 'week', title: 'This Week' },
  { bucket: 'month', title: 'This Month' },
  { bucket: 'older', title: 'Older' }
]

/** Which recency bucket a lastActivity timestamp falls into, relative to `now`.
 *  Today/Yesterday are calendar-day based (local); the rest are rolling
 *  windows. Null/unparseable timestamps sink to 'older'. */
export function timeBucket(lastActivity: string | null, now: number = Date.now()): TimeBucket {
  if (lastActivity === null) return 'older'
  const t = Date.parse(lastActivity)
  if (Number.isNaN(t)) return 'older'
  const d = new Date(now)
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (t >= startToday) return 'today'
  if (t >= startToday - 86_400_000) return 'yesterday'
  if (t >= now - 7 * 86_400_000) return 'week'
  if (t >= now - 30 * 86_400_000) return 'month'
  return 'older'
}

/** Builds the nav's sectioned model from the flat channel + group lists.
 *
 *  DESIGN DECISION (starred vs. group membership): Starred is an EXCLUSIVE
 *  bucket -- a starred channel is ELEVATED into the Starred section and appears
 *  there ONLY, never also under a group or Ungrouped (which would double-list
 *  it). Its `groupId` is preserved, so unstarring drops it straight back to its
 *  group (or Ungrouped, if it has none) -- nothing is lost, it just isn't shown
 *  in two places at once. Starring is "move to the top", not "pin a copy".
 *
 *  Section order: Starred first (if non-empty), then every user group in
 *  `sortOrder`, then the remaining ungrouped channels split into recency
 *  buckets (Today / Yesterday / This Week / This Month / Older, most-recent
 *  first) so the chats you touched lately sit at the top. Hidden last.
 *
 *  Empty-section visibility, decided and tested:
 *   - Starred: omitted entirely when no channel is starred.
 *   - group sections: ALWAYS shown, even with zero member channels, so a
 *     freshly created (or fully emptied) group stays a visible move target.
 *   - time buckets: only shown when they have members (no empty "Yesterday").
 *
 *  A channel's `groupId` pointing at a group id not present in `groups` (a
 *  dangling reference) is treated exactly like `groupId: null`: it falls into
 *  the recency buckets rather than vanishing or throwing. */
export function groupChannels(channels: ChannelRow[], groups: ChannelGroup[], now: number = Date.now()): NavSection[] {
  const sections: NavSection[] = []

  // Hidden channels are excluded from every normal section and collected into
  // their own section at the very bottom, so a "hidden" channel truly leaves
  // the main list but stays recoverable (Unhide).
  // Archived ones have a section of their own, whatever they're marked as.
  const current = channels.filter(c => c.archived !== true)
  const archived = channels.filter(c => c.archived === true)
  const visible = current.filter(c => !c.meta.hidden)
  const hidden = current.filter(c => c.meta.hidden)

  const starred = visible.filter(c => c.meta.starred)
  if (starred.length > 0) sections.push({ kind: 'starred', title: 'Starred', channels: starred })

  // Starred channels are elevated exclusively into the Starred section above,
  // so every other section (groups, Ungrouped) excludes them -- otherwise a
  // starred channel would appear twice. Its groupId is untouched, so unstarring
  // returns it here.
  const unstarred = visible.filter(c => !c.meta.starred)

  const sortedGroups = [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  const validGroupIds = new Set(groups.map(g => g.id))
  for (const g of sortedGroups) {
    const members = unstarred.filter(c => c.meta.groupId === g.id)
    sections.push({ kind: 'group', groupId: g.id, title: g.name, icon: g.icon, channels: members })
  }

  // Everything not starred and not in a user group: split into recency buckets.
  const ungrouped = unstarred.filter(c => c.meta.groupId === null || !validGroupIds.has(c.meta.groupId))
  const activityMs = (c: ChannelRow): number => (c.lastActivity !== null ? Date.parse(c.lastActivity) : -Infinity)
  const byBucket = new Map<TimeBucket, ChannelRow[]>()
  for (const c of ungrouped) {
    const key = timeBucket(c.lastActivity, now)
    const list = byBucket.get(key)
    if (list === undefined) byBucket.set(key, [c])
    else list.push(c)
  }
  for (const { bucket, title } of TIME_BUCKETS) {
    const members = byBucket.get(bucket)
    if (members !== undefined && members.length > 0) {
      members.sort((a, b) => activityMs(b) - activityMs(a)) // most recent first within the bucket
      sections.push({ kind: 'time', bucket, title, channels: members })
    }
  }

  if (hidden.length > 0) sections.push({ kind: 'hidden', title: 'Hidden', channels: hidden })
  if (archived.length > 0) {
    archived.sort((a, b) => activityMs(b) - activityMs(a))
    sections.push({ kind: 'archived', title: 'Archived', channels: archived })
  }

  return sections
}

/** Clamps a context menu's top-left corner so it stays fully on screen,
 *  given its own measured size and the viewport size. Used by
 *  ChannelContextMenu: the initial position is the right-click's cursor
 *  coordinates, which -- unclamped -- would let a menu opened near the
 *  right/bottom edge render partially (or entirely) off-screen. Clamps into
 *  the top-left corner (0,0) rather than going negative when the menu is
 *  larger than the viewport itself (a degenerate case, but one a naive
 *  `viewport - menuSize` subtraction would otherwise turn negative). */
export function clampMenuPosition(
  x: number, y: number, menuWidth: number, menuHeight: number, viewportWidth: number, viewportHeight: number
): { x: number; y: number } {
  const maxX = Math.max(0, viewportWidth - menuWidth)
  const maxY = Math.max(0, viewportHeight - menuHeight)
  return { x: clamp(x, 0, maxX), y: clamp(y, 0, maxY) }
}

/** Default cap on a custom channel icon's image size (Task 2 guard): a
 *  multi-megabyte image icon stored as a base64 `dataUrl` in `channel_meta`
 *  would bloat the SQLite catalog for a purely cosmetic avatar. 256 KiB is
 *  generous for a small circular avatar (which is typically downscaled
 *  before encoding by IconPicker) while keeping the DB light. */
export const MAX_ICON_IMAGE_BYTES = 256 * 1024

/** Whether a `data:...;base64,<payload>` URL decodes to no more than
 *  `maxBytes`. Computes the decoded size from the base64 payload's length
 *  (accounting for `=` padding) rather than actually decoding it, so a
 *  multi-MB image can be rejected without ever allocating the decoded
 *  buffer. Returns false for anything that isn't a data URL with a `,`
 *  separator (defensive -- IconPicker only ever calls this with a real
 *  `FileReader.readAsDataURL` result, but a malformed value must fail
 *  closed, not silently pass as "small enough"). */
export function dataUrlSizeOk(dataUrl: string, maxBytes: number = MAX_ICON_IMAGE_BYTES): boolean {
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx === -1) return false
  const base64 = dataUrl.slice(commaIdx + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const bytes = (base64.length * 3) / 4 - padding
  return bytes <= maxBytes
}

// ── Search overlay (Plan 3 Task 3) ──────────────────────────────────────────

/** One piece of an FTS snippet: `marked` segments are the matched terms
 *  (wrapped in <mark> by the FTS query) and render highlighted; plain segments
 *  render as ordinary text. */
export type SnippetSegment = { text: string; marked: boolean }

/** Parse an FTS5 snippet containing `<mark>…</mark>` spans into safe segments.
 *  CRITICAL: the message text is untrusted, so the renderer must build React
 *  text nodes from these segments and NEVER dangerouslySetInnerHTML the raw
 *  snippet. This splitter only recognises the literal `<mark>`/`</mark>`
 *  delimiters the FTS query itself inserts; any other `<`/`>` in the message
 *  (e.g. `<script>`) stays inside a plain segment and is rendered verbatim by
 *  React's own escaping. An unbalanced/stray `<mark>` with no close is treated
 *  as plain text rather than swallowing the rest as a match. */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const OPEN = '<mark>', CLOSE = '</mark>'
  const out: SnippetSegment[] = []
  let i = 0
  while (i < snippet.length) {
    const open = snippet.indexOf(OPEN, i)
    if (open === -1) { out.push({ text: snippet.slice(i), marked: false }); break }
    if (open > i) out.push({ text: snippet.slice(i, open), marked: false })
    const close = snippet.indexOf(CLOSE, open + OPEN.length)
    if (close === -1) { out.push({ text: snippet.slice(open), marked: false }); break }
    out.push({ text: snippet.slice(open + OPEN.length, close), marked: true })
    i = close + CLOSE.length
  }
  return out.filter(s => s.text.length > 0)
}

/** A session's search hits, with the channel's display name resolved for the
 *  group header. */
export type SearchResultGroup = { sessionPk: number; sessionId: string; channelName: string; projectDir: string; hits: SearchHit[] }

/** Group flat FTS hits by session (preserving the backend's rank order — first
 *  seen wins), attach each session's channel display name via the channel map
 *  (falling back to the raw project slug when the channel isn't loaded), and
 *  cap both the number of groups and the hits per group. */
export function groupSearchHits(
  hits: SearchHit[],
  channelsByDir: Map<string, { cwd: string | null; dirName: string; meta: ChannelMeta }>,
  maxGroups = 20,
  maxPerGroup = 5
): SearchResultGroup[] {
  const order: number[] = []
  const byPk = new Map<number, SearchResultGroup>()
  for (const h of hits) {
    let g = byPk.get(h.sessionPk)
    if (g === undefined) {
      const ch = channelsByDir.get(h.projectDir)
      const channelName = ch ? resolveChannelName(ch.meta, ch.cwd, ch.dirName) : h.projectDir
      g = { sessionPk: h.sessionPk, sessionId: h.sessionId, channelName, projectDir: h.projectDir, hits: [] }
      byPk.set(h.sessionPk, g)
      order.push(h.sessionPk)
    }
    if (g.hits.length < maxPerGroup) g.hits.push(h)
  }
  return order.slice(0, maxGroups).map(pk => byPk.get(pk)!)
}

/** Flatten grouped results into a single ordered list of (groupIndex, hitIndex)
 *  positions for ↑/↓ keyboard navigation, and clamp an index into range. */
export function flattenSearchPositions(groups: SearchResultGroup[]): { group: number; hit: number }[] {
  const pos: { group: number; hit: number }[] = []
  groups.forEach((g, gi) => g.hits.forEach((_, hi) => pos.push({ group: gi, hit: hi })))
  return pos
}

/** The command a message starts with, lowercased and without its slash, or null.
 *  A path such as "/usr/bin" isn't one. */
function leadingCommand(text: string): string | null {
  const m = /^\s*\/([a-z][a-z0-9:_-]*)(?:\s|$)/i.exec(text)
  return m === null ? null : m[1]!.toLowerCase()
}

/** The terminal-only command a message starts with ("/login"), or null. */
export function terminalOnlyCommand(text: string): string | null {
  const name = leadingCommand(text)
  return name !== null && TERMINAL_ONLY_COMMANDS.has(name) ? `/${name}` : null
}

/** True for /clear and its aliases, which Delegatto handles itself. */
/** The question in `/btw question`, or null. */
export function sideQuestionOf(text: string): string | null {
  const m = /^\s*\/btw\s+([\s\S]+)$/.exec(text)
  return m === null ? null : m[1]!.trim()
}

/** The name in `/rename name`, or null. A bare `/rename` is left to Claude Code, which picks one. */
export function renameCommandOf(text: string): string | null {
  const m = /^\s*\/rename\s+([\s\S]+)$/.exec(text)
  return m === null ? null : m[1]!.trim()
}

/** Terminal commands Delegatto answers with its own screens or actions, because Claude
 *  Code can't run them headless ("isn't available in this environment") or only prints a
 *  summary pointing back to the terminal. Checked against 2.1.318. */
export type AppCommand =
  | { kind: 'settings'; section: 'appearance' | 'skills' | 'claude' | 'engine' | 'plugins' }
  | { kind: 'hooks' }
  | { kind: 'diff' }
  | { kind: 'tasks' }
  /** Bare opens the choice of copy or save; with a name it saves to the chat's folder. */
  | { kind: 'export'; fileName: string }
  /** `claude plugin <args>`, run at once, as `/plugin install x` does in the terminal. */
  | { kind: 'pluginAction'; args: string[] }
  | { kind: 'memory' }
  | { kind: 'search' }
  | { kind: 'copy'; nth: number }
  | { kind: 'help' }
  | { kind: 'plan'; text: string }
  | { kind: 'usage' }
  | { kind: 'status' }
  | { kind: 'releaseNotes' }
  | { kind: 'exit' }
  /** Claude Code's focus view: just your prompt and the replies. Here, this project's
   *  tool calls and thoughts switched off (or back on). Null `on` toggles. */
  | { kind: 'focus'; on: boolean | null }
  /** Only changes the terminal's own look: says so, and what does the job here. */
  | { kind: 'note'; text: string }
  /** What the header's pickers do, so the choice lasts past this chat's process. '' is the default. */
  | { kind: 'model'; value: string }
  | { kind: 'effort'; value: string }

export function appCommandOf(text: string): AppCommand | null {
  const m = /^\s*\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text)
  if (m === null) return null
  const name = m[1]!.toLowerCase(), args = (m[2] ?? '').trim()
  switch (name) {
    case 'theme': return { kind: 'settings', section: 'appearance' }
    case 'skills': return { kind: 'settings', section: 'skills' }
    case 'permissions': case 'allowed-tools': return { kind: 'settings', section: 'claude' }
    // With key=value, Claude Code sets it itself; bare, it only prints usage.
    case 'config': case 'settings': return args === '' ? { kind: 'settings', section: 'claude' } : null
    case 'chrome': return { kind: 'settings', section: 'engine' }
    case 'memory': return { kind: 'memory' }
    case 'resume': case 'continue': return { kind: 'search' }
    case 'copy': {
      const n = args === '' ? 1 : Number(args)
      return Number.isInteger(n) && n >= 1 ? { kind: 'copy', nth: n } : { kind: 'copy', nth: 1 }
    }
    case 'help': return { kind: 'help' }
    case 'plan': return { kind: 'plan', text: args.toLowerCase() === 'open' ? '' : args }
    case 'usage': case 'cost': case 'stats': return { kind: 'usage' }
    case 'status': return { kind: 'status' }
    case 'release-notes': return { kind: 'releaseNotes' }
    case 'exit': case 'quit': return { kind: 'exit' }
    case 'color': return { kind: 'note', text: '/color only colors the prompt bar in Claude Code’s terminal. To tell chats apart here, right-click a project in the chat list and choose Change icon.' }
    // Bare, Claude Code lists what there is; with a name, the header's choice is set.
    case 'model': return args === '' ? null : { kind: 'model', value: args.toLowerCase() === 'default' ? '' : args }
    case 'effort': {
      const level = args.toLowerCase()
      if (level === 'auto' || level === 'default') return { kind: 'effort', value: '' }
      return (EFFORTS as readonly string[]).includes(level) ? { kind: 'effort', value: level } : null
    }
    case 'hooks': return { kind: 'hooks' }
    case 'diff': return { kind: 'diff' }
    case 'tasks': case 'bashes': return { kind: 'tasks' }
    case 'export': return { kind: 'export', fileName: args }
    case 'plugin': case 'plugins': return pluginCommand(args)
    case 'marketplace': return pluginCommand(`marketplace ${args}`)
    case 'focus': return { kind: 'focus', on: args.toLowerCase() === 'on' ? true : args.toLowerCase() === 'off' ? false : null }
    default: return null
  }
}

/** `/plugin …` as the terminal takes it: bare, `manage`, `list` or `marketplace` alone open the
 *  Plugins screen; `install|uninstall|enable|disable|update <plugin>` and
 *  `marketplace add|remove|update …` run at once. Anything else opens the screen too. */
function pluginCommand(args: string): AppCommand {
  const words = args.split(/\s+/).filter(w => w !== '')
  const open: AppCommand = { kind: 'settings', section: 'plugins' }
  const verb = (words[0] ?? '').toLowerCase()
  const alias: Record<string, string> = { i: 'install', remove: 'uninstall', rm: 'uninstall' }
  const action = alias[verb] ?? verb
  if (['install', 'uninstall', 'enable', 'disable', 'update'].includes(action)) return words.length >= 2 ? { kind: 'pluginAction', args: [action, ...words.slice(1)] } : open
  if (action === 'marketplace') {
    const sub = (words[1] ?? '').toLowerCase()
    const m = sub === 'rm' ? 'remove' : sub
    if (m === 'add' || m === 'remove') return words.length >= 3 ? { kind: 'pluginAction', args: ['marketplace', m, ...words.slice(2)] } : open
    if (m === 'update') return { kind: 'pluginAction', args: ['marketplace', 'update', ...words.slice(2)] }
  }
  return open
}

/** The nth-latest reply of Claude's, as `/copy N` counts them, or null. */
export function nthLatestReply(items: RenderItem[], nth: number): string | null {
  const replies = items.filter((it): it is Extract<RenderItem, { kind: 'text' }> => it.kind === 'text' && it.role === 'assistant' && it.text.trim() !== '')
  return replies[replies.length - nth]?.text ?? null
}

export type McpCommand = { action: 'open' } | { action: 'reconnect' | 'enable' | 'disable'; target: string }

/** `/mcp` as Claude Code takes it: bare opens the servers, and `reconnect <server>`,
 *  `enable [<server>|all]` and `disable [<server>|all]` act at once (no name means all, for
 *  enable and disable). Null for anything else, which goes to Claude as typed. */
export function mcpCommandOf(text: string): McpCommand | null {
  const m = /^\s*\/mcp(?:\s+([\s\S]*))?$/i.exec(text)
  if (m === null) return null
  const [verb = '', ...rest] = (m[1] ?? '').trim().split(/\s+/).filter(w => w.length > 0)
  const target = rest.join(' ')
  const action = verb.toLowerCase()
  if (action === 'reconnect' && target !== '') return { action, target }
  if (action === 'enable' || action === 'disable') return { action, target: target === '' ? 'all' : target }
  return { action: 'open' }
}

/** The folder in `/add-dir folder`, '' for a bare `/add-dir`, or null for anything else. */
export function addDirCommandOf(text: string): string | null {
  const m = /^\s*\/add-dir(?:\s+([\s\S]*))?$/.exec(text)
  return m === null ? null : (m[1] ?? '').trim().replace(/^"(.*)"$/, '$1')
}

/** /rewind, and the name it also goes by in the terminal. */
export function isRewindCommand(text: string): boolean {
  return /^\s*\/(rewind|checkpoint)\s*$/.test(text)
}

/** Whether a background task has output the app can read: shell commands and monitors. */
export function taskHasOutput(type: string): boolean {
  return /bash|shell|monitor/i.test(type)
}

/** A command's output as plain text: colors and cursor codes removed, as the screen would show it. */
export function plainTerminalText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n').map(line => { const at = line.lastIndexOf('\r'); return at === -1 ? line : line.slice(at + 1) }).join('\n')
}

export function isForkCommand(text: string): boolean {
  return /^\s*\/(fork|branch)\s*$/.test(text)
}

export function isClearCommand(text: string): boolean {
  const name = leadingCommand(text)
  return name !== null && CLEAR_COMMANDS.has(name)
}

/** What the composer should offer at the caret: a command while the first word
 *  is being typed, or after whitespace later on (`mid`), and a file or agent after
 *  an "@" that starts a word (optionally quoted). */
export type CompletionContext = { kind: 'command' | 'file'; query: string; start: number; end: number; mid?: true }

/** Where the terminal starts a mid-message / or @: after whitespace or 。、？！ */
const MID_COMMAND = /[\s\u3002\u3001\uFF1F\uFF01]\/([a-zA-Z0-9._:-]*)$/
/** Leading commands whose arguments are paths or names: the terminal has no mid-message / after them. */
const PATH_ARG_COMMANDS = /^\/(add-dir|cd|resume|plugin|plugins|marketplace)(\s|$)/

export function completionAt(text: string, caret: number): CompletionContext | null {
  const before = text.slice(0, caret)
  const command = /^\/([^\s/]*)$/.exec(before)
  if (command !== null && /^\S*(\s|$)/.test(text.slice(caret))) {
    return { kind: 'command', query: command[1]!, start: 0, end: caret + /^\S*/.exec(text.slice(caret))![0].length }
  }
  const mid = MID_COMMAND.exec(before)
  // A `!` line is a shell command, where a / is a path or a flag.
  if (mid !== null && !PATH_ARG_COMMANDS.test(text) && !/^\s*!/.test(text)) {
    const rest = /^[a-zA-Z0-9._:-]*/.exec(text.slice(caret))![0]
    // A path such as /usr/bin isn't a command.
    if (!text.slice(caret + rest.length).startsWith('/')) {
      return { kind: 'command', query: mid[1]!, start: caret - mid[1]!.length - 1, end: caret + rest.length, mid: true }
    }
  }
  const file = /(?:^|\s)@("[^"]*|[^\s"]*)$/.exec(before)
  if (file === null) return null
  const token = file[1]!
  return { kind: 'file', query: token.replace(/^"/, ''), start: caret - token.length - 1, end: caret }
}

/** The commands worth offering mid-message. Claude Code only tells Claude about skills
 *  and prompt commands there; a built-in or an MCP prompt is just text. A bundled skill
 *  is listed as a built-in, so `skills` (from the chat's init) says which ones are skills. */
export function midMessageCommands(commands: ClaudeCommand[], skills: readonly string[] | null): ClaudeCommand[] {
  const skillNames = new Set(skills ?? [])
  return commands.filter(c => !c.name.startsWith('mcp__') && c.source !== 'mcp'
    && (c.source !== 'builtin' || skillNames.has(c.name)))
}

const SOURCE_ORDER: Record<CommandSource, number> = { project: 0, user: 1, plugin: 2, synced: 3, builtin: 4, mcp: 5 }

const DESCRIPTION_ONLY = 5

function commandScore(c: ClaudeCommand, q: string): number {
  const name = c.name.toLowerCase()
  const aliases = c.aliases.map(a => a.toLowerCase())
  if (name === q || aliases.includes(q)) return 0
  if (name.startsWith(q)) return 1
  if (aliases.some(a => a.startsWith(q))) return 2
  if (name.slice(name.indexOf(':') + 1).startsWith(q)) return 3
  if (name.includes(q) || aliases.some(a => a.includes(q))) return 4
  return c.description.toLowerCase().includes(q) ? DESCRIPTION_ONLY : -1
}

/** Commands matching what's been typed, best first: exact name, start of the
 *  name, of an alias, of the part after "plugin:", anywhere in the name, then the
 *  description, with shorter names first. With nothing typed, everything grouped
 *  by where it's from. */
export function filterCommands(commands: ClaudeCommand[], query: string, limit = 50): ClaudeCommand[] {
  const q = query.toLowerCase()
  return commands
    .map(c => ({ c, s: q === '' ? 0 : commandScore(c, q) }))
    .filter(x => x.s >= 0)
    .sort((a, b) => a.s - b.s
      || (q === '' ? SOURCE_ORDER[a.c.source] - SOURCE_ORDER[b.c.source] : a.c.name.length - b.c.name.length)
      || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map(x => x.c)
}

/** Whether what's typed is really this command's name, not just a word in its
 *  description. Only then may Enter complete it unasked: "/hooks" must not turn
 *  into some other command that merely mentions hooks. */
export function matchesCommandName(c: ClaudeCommand, query: string): boolean {
  const q = query.toLowerCase()
  return q === '' || (commandScore(c, q) >= 0 && commandScore(c, q) < DESCRIPTION_ONLY)
}

function isSubsequence(query: string, text: string): boolean {
  let i = 0
  for (const ch of text) if (ch === query[i] && ++i === query.length) return true
  return query.length === 0
}

/** Project paths matching what's been typed, best first: file name starts with
 *  it, file name contains it, path contains it, then its letters in order. */
export function rankFiles(paths: string[], query: string, limit = 30): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/')
  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const p = path.toLowerCase()
    const base = p.replace(/\/$/, '').slice(p.replace(/\/$/, '').lastIndexOf('/') + 1)
    const score = base.startsWith(q) ? 0 : base.includes(q) ? 1 : p.includes(q) ? 2 : isSubsequence(q, p) ? 3 : -1
    if (score >= 0) scored.push({ path, score })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(x => x.path)
}

/** The token a chosen file becomes. Claude Code reads a path with spaces only
 *  when it's quoted. */
export function fileMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

/** `text` with the completion's token replaced by `value` and a trailing space. */
export function applyCompletion(text: string, at: CompletionContext, value: string): { text: string; caret: number } {
  const rest = text.slice(at.end).replace(/^ /, '')
  const inserted = `${value} `
  return { text: text.slice(0, at.start) + inserted + rest, caret: at.start + inserted.length }
}

/** How much of `text`'s start is a real command (for highlighting), or 0. */
export function commandTokenLength(text: string, commands: ClaudeCommand[]): number {
  const m = /^\/([^\s]+)/.exec(text)
  if (m === null) return 0
  const name = m[1]!.toLowerCase()
  const known = commands.some(c => c.name.toLowerCase() === name || c.aliases.some(a => a.toLowerCase() === name))
  return known || CLEAR_COMMANDS.has(name) ? m[0].length : 0
}

/** Every known command in `text`, for highlighting, as the terminal does: the leading
 *  one, and any /name after whitespace later on. A trailing "." isn't part of it. */
export function commandTokenRanges(text: string, commands: ClaudeCommand[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const lead = commandTokenLength(text, commands)
  if (lead > 0) ranges.push({ start: 0, end: lead })
  const known = new Set(commands.flatMap(c => [c.name, ...c.aliases]).map(n => n.toLowerCase()))
  const token = /(^|[\s。、？！])(\/[a-zA-Z][a-zA-Z0-9.:\-_]*)/g
  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    const start = m.index + m[1]!.length
    if (start === 0) continue
    const name = m[2]!.replace(/\.+$/, '')
    if (known.has(name.slice(1).toLowerCase())) ranges.push({ start, end: start + name.length })
  }
  return ranges
}

/** Opening and closing marks of the spans Claude Code skips when it looks for a keyword. */
const KEYWORD_QUOTES: Record<string, string> = { '`': '`', '"': '"', '<': '>', '{': '}', '[': ']', '(': ')', "'": "'" }

/** Where `word` counts as a keyword in `text`, by Claude Code's rule (2.1.319, `Fi`): a
 *  whole word, case aside, not in quotes, backticks or brackets, not next to / \ or -,
 *  not before ? or a "." that runs on, and never in a message starting with /. */
export function keywordRanges(text: string, word: string): Array<{ start: number; end: number }> {
  if (!text.toLowerCase().includes(word.toLowerCase()) || text.startsWith('/')) return []
  const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
  const skipped: Array<{ start: number; end: number }> = []
  let open: string | null = null
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (open !== null) {
      if (open === '[' && ch === '[') { from = i; continue }
      if (ch !== KEYWORD_QUOTES[open]) continue
      if (open === "'" && isWordChar(text[i + 1])) continue
      skipped.push({ start: from, end: i + 1 })
      open = null
    } else if ((ch === '<' && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!))
      || (ch === "'" && !isWordChar(text[i - 1]))
      || (ch !== '<' && ch !== "'" && ch in KEYWORD_QUOTES)) {
      open = ch
      from = i
    }
  }
  const found: Array<{ start: number; end: number }> = []
  for (const m of text.matchAll(new RegExp(`\\b${word}\\b`, 'gi'))) {
    const start = m.index, end = start + m[0].length
    if (skipped.some(s => start >= s.start && start < s.end)) continue
    const prev = text[start - 1], next = text[end]
    if (prev === '/' || prev === '\\' || prev === '-') continue
    if (next === '/' || next === '\\' || next === '-' || next === '?') continue
    if (next === '.' && isWordChar(text[end + 1])) continue
    found.push({ start, end })
  }
  return found
}

/** Whether a message goes to Claude Code marked as typed by the user. Claude Code looks for
 *  "ultracode" only in what was typed, never in pasted text, which it keeps apart. Delegatto
 *  folds pasted text in, so a message whose only live "ultracode" is pasted goes unmarked,
 *  and so can't start a workflow the user never asked for. */
export function sendsAsTyped(boxText: string, pastedTexts: PastedTextChip[]): boolean {
  if (pastedTexts.length === 0) return true
  return keywordRanges(boxText, 'ultracode').length > 0
    || keywordRanges(buildOutgoingText(boxText, pastedTexts), 'ultracode').length === 0
}

/** The agents for the @ menu: the names the chat's init lists when it has run, else
 *  Claude Code's own list. Descriptions come from Claude Code's list either way. A type
 *  with a space is left out: Claude Code's `@agent-<type>` can't name it. */
export function agentOptions(initAgents: readonly string[] | null, infoAgents: readonly ClaudeAgent[]): ClaudeAgent[] {
  const about = new Map(infoAgents.map(a => [a.type, a.description]))
  const all = initAgents === null ? [...infoAgents] : initAgents.map(type => ({ type, description: about.get(type) ?? '' }))
  return all.filter(a => !/\s/.test(a.type))
}

/** What a chosen agent becomes, as Claude Code reads it. */
export function agentMention(type: string): string {
  return `@agent-${type}`
}

export type MentionOption = { kind: 'file'; path: string } | { kind: 'agent'; agent: ClaudeAgent }

/** Files and agents for what's typed after "@". An agent whose name starts with it goes
 *  first; one that only contains it comes after the files. A path being typed is files only. */
export function rankMentions(paths: string[], agents: readonly ClaudeAgent[], query: string): MentionOption[] {
  const files: MentionOption[] = rankFiles(paths, query).map(path => ({ kind: 'file', path }))
  if (/[/\\]/.test(query)) return files
  const q = query.toLowerCase().replace(/^agent-/, '')
  const first: MentionOption[] = [], after: MentionOption[] = []
  for (const agent of agents) {
    const name = agent.type.toLowerCase()
    if (q !== '' && name.startsWith(q)) first.push({ kind: 'agent', agent })
    else if (name.includes(q) || `${name} (agent)`.includes(q)) after.push({ kind: 'agent', agent })
  }
  return [...first, ...files, ...after]
}

/** Servers worth warning about: failed ones, and ones needing a sign-in. claude.ai
 *  connectors are the exception: signed-out ones are normal if you don't use them. */
export function mcpProblems(servers: McpServerStatus[], ignored: string[]): McpServerStatus[] {
  return servers.filter(s => !ignored.includes(s.name)
    && (s.status === 'failed' || (s.status === 'needs-auth' && s.source !== 'claudeai')))
}

export function mcpStatusLabel(status: string): string {
  switch (status) {
    case 'connected': return 'Connected'
    case 'pending': return 'Starting'
    case 'failed': return 'Failed'
    case 'needs-auth': return 'Needs sign-in'
    case 'disabled': return 'Off'
    default: return status
  }
}

/** A displayable URL for a stored image block, or null. Only base64 bitmaps: an SVG
 *  can carry script, and a remote URL would make opening a chat fetch from it. */
export function imageSourceUrl(source: unknown): string | null {
  if (typeof source !== 'object' || source === null) return null
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown }
  if (s.type !== 'base64' || typeof s.data !== 'string' || s.data.length === 0) return null
  if (typeof s.media_type !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(s.media_type)) return null
  return `data:${s.media_type};base64,${s.data}`
}

/** A message as one plain line for the chat list, without its markdown symbols. */
export function plainPreview(text: string): string {
  return text
    .replace(/^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/gm, ' ') // table rulers
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+)/gm, '') // line starts
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1') // links keep their words
    .replace(/(\*\*|__|~~|```|`)/g, '')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*/g, '$1$2')
    .replace(/\s*\|[\s|]*/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·]+|[\s·]+$/g, '')
}

/** "11m 49s", "1h 2m", "8s". */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** "53.9k", "1.2M", "850". */
export function tokenLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Where to scroll a list so that this item sits in the middle, or as near as the list's ends
 *  allow. `itemTop` is measured from the top of the list's content. */
export function centeredScrollTop(itemTop: number, itemHeight: number, viewHeight: number, contentHeight: number): number {
  const wanted = itemTop - (viewHeight - itemHeight) / 2
  return Math.max(0, Math.min(Math.max(0, contentHeight - viewHeight), wanted))
}

export type TurnPart = { group: false; index: number } | { group: true; indices: number[] } | { group: 'thoughts'; indices: number[] }

/** These items in order, with each unbroken stretch of thoughts as one entry. */
export function thoughtRuns(indices: number[], items: RenderItem[]): number[][] {
  const runs: number[][] = []
  indices.forEach((index, at) => {
    const last = runs.at(-1)
    if (at > 0 && items[index]?.kind === 'thinking' && items[indices[at - 1]!]?.kind === 'thinking' && last !== undefined) last.push(index)
    else runs.push([index])
  })
  return runs
}

/** "thought · 494 chars" for one, "thoughts · 6 · 2,250 chars" for several together. */
export function thoughtsLabel(texts: string[]): string {
  const chars = texts.reduce((sum, t) => sum + t.length, 0).toLocaleString()
  return texts.length === 1 ? `thought · ${chars} chars` : `thoughts · ${texts.length} · ${chars} chars`
}

/** Splits a Claude turn so that each run of two or more tool calls and thoughts can
 *  collapse into one line. The text between them stays visible. Thoughts in a row count as
 *  one thing, so they alone are never "steps". */
export function groupToolRuns(items: RenderItem[]): TurnPart[] {
  const parts: TurnPart[] = []
  let run: number[] = []
  const flush = (): void => {
    const merged = thoughtRuns(run, items)
    if (merged.length >= 2) parts.push({ group: true, indices: run })
    else if (run.length >= 2) parts.push({ group: 'thoughts', indices: run })
    else for (const index of run) parts.push({ group: false, index })
    run = []
  }
  items.forEach((item, index) => {
    if (item.kind === 'tool' || item.kind === 'thinking') run.push(index)
    else { flush(); parts.push({ group: false, index }) }
  })
  flush()
  return parts
}

/** "14 steps · Bash ×6, Write ×5, thought ×3", most used first. */
export function toolRunSummary(items: RenderItem[]): string {
  const steps = thoughtRuns(items.map((_, i) => i), items).map(run => items[run[0]!]!)
  const counts = new Map<string, number>()
  for (const item of steps) {
    const name = item.kind === 'tool' ? item.name : item.kind === 'thinking' ? 'thought' : null
    if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const list = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => n > 1 ? `${name} ×${n}` : name)
  return `${steps.length} steps · ${list.join(', ')}`
}

/** One line in the New Chat dialog's list of projects to start from. */
export type CheckoutRow = {
  key: string
  label: string
  description: string | null
  isPrivate: boolean
  isArchived: boolean
  onThisPc: boolean
  folder: string
  /** The GitHub repo, for a project that has one. */
  repo: string | null
  /** Set when another PC syncs this project: picking it brings the chats over too. */
  sync: { projectId: string; from: string; chats: number } | null
  /** This PC already syncs it. */
  syncedHere: boolean
  /** It has synced chats this PC doesn't have yet, so picking it offers to bring them. */
  hasHistory: boolean
}

/** Projects syncing from other PCs come first, including any with no GitHub repo, then the rest
 *  in the order given. The sync repos themselves aren't projects, so they're left out.
 *  `syncedHere` lists the GitHub repos of projects this PC syncs; `withHistory`, the repos with
 *  synced chats, which a PC knows before it has the key. */
export function checkoutRows(repos: GithubRepoOption[], remote: RemoteProject[], syncRepos: string[], syncedHere: string[] = [], withHistory: string[] = []): CheckoutRow[] {
  const here = new Set(syncedHere.map(r => r.toLowerCase()))
  const history = new Set(withHistory.map(r => r.toLowerCase()))
  const hidden = new Set(syncRepos.map(r => r.toLowerCase()))
  const byRepo = new Map(repos.map(r => [r.fullName.toLowerCase(), r]))
  const synced = new Set<string>()
  const first = remote.map((p): CheckoutRow => {
    const known = p.github === null ? undefined : byRepo.get(p.github.toLowerCase())
    if (p.github !== null) synced.add(p.github.toLowerCase())
    return {
      key: `sync:${p.projectId}`, label: p.github ?? p.name, description: known?.description ?? null,
      isPrivate: known?.isPrivate ?? false, isArchived: known?.isArchived ?? false, onThisPc: known?.onThisPc ?? false,
      folder: known?.onThisPc === true ? known.destination : p.suggestedFolder, repo: p.github,
      sync: { projectId: p.projectId, from: p.updatedBy, chats: p.chats }, syncedHere: false, hasHistory: true
    }
  })
  const rest = repos.filter(r => !hidden.has(r.fullName.toLowerCase()) && !synced.has(r.fullName.toLowerCase())).map((r): CheckoutRow => {
    const name = r.fullName.toLowerCase()
    return {
      key: `repo:${r.fullName}`, label: r.fullName, description: r.description, isPrivate: r.isPrivate, isArchived: r.isArchived,
      onThisPc: r.onThisPc, folder: r.destination, repo: r.fullName, sync: null,
      syncedHere: here.has(name), hasHistory: history.has(name) && !here.has(name)
    }
  })
  // Repos with chats waiting go up with the synced ones, so they're easy to find.
  return [...first, ...rest.filter(r => r.hasHistory), ...rest.filter(r => !r.hasHistory)]
}

/** Rows matching every word typed, in the name or description. */
export function filterCheckoutRows(rows: CheckoutRow[], query: string): CheckoutRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0)
  return rows.filter(r => { const text = `${r.label} ${r.description ?? ''}`.toLowerCase(); return words.every(w => text.includes(w)) })
}
