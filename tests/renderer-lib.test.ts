import { describe, it, expect } from 'vitest'
import {
  channelName, isStaleResponse, stableItemKeys, shouldScrollToBottom, followAfterScroll, relativeTime, clamp,
  channelInitials, avatarColor, collapsePastedText, queueReducer, imageFromDataUrl, buildOutgoingText,
  resolveNewProjectOptions, summarizePermissionRequest, isPlanApproval, previewAllowAlwaysRule,
  planTextFromInput, parseEditedInput, reduceLivePreview, appendRowsToItems, renderItemsFromStreamedRows,
  liveIndicatorState, shouldApplyReload, clearsRunning, hasAssistantRenderItem, suppressSealedPreview,
  resolveChannelName, resolveChannelIcon, groupChannels, clampMenuPosition, dataUrlSizeOk,
  MAX_ICON_IMAGE_BYTES, parseSnippet, groupSearchHits, flattenSearchPositions, groupIntoTurns,
  firstBlockedElsewhere, projectDirFromSessionKey, timeBucket,
  formatClock, localDayKey, dayDividerLabel
} from '../src/renderer/lib'
import type { RenderItem, ChannelRow, SearchHit } from '../src/shared/types'
import type { QueuedMessage, ComposerImage, PastedTextChip, NewChatDefaults, NewProjectOptions, LivePreview } from '../src/renderer/lib'
import type { LiveEvent } from '../src/shared/engine-types'
import type { StreamedRow } from '../src/main/jsonl/stream'
import type { ChannelMeta, ChannelGroup } from '../src/shared/shell-types'
// Tests (unlike the renderer proper) are allowed to reach into main-process
// modules -- this is the ONE place the real allowAlwaysRule gets imported, so
// the parity test below can assert the renderer's preview never lies about
// what the bridge is about to persist.
import { allowAlwaysRule } from '../src/main/engine/permission-bridge'

describe('channelName', () => {
  it('returns the last segment of a posix path', () => {
    expect(channelName('/home/user/projects/foo', 'foo-dir')).toBe('foo')
  })

  it('returns the last segment of a windows path', () => {
    expect(channelName('C:\\Users\\me\\projects\\bar', 'bar-dir')).toBe('bar')
  })

  it('falls back to dirName for an empty string', () => {
    expect(channelName('', 'fallback')).toBe('fallback')
  })

  it('falls back to dirName for a bare posix root', () => {
    expect(channelName('/', 'fallback')).toBe('fallback')
  })

  it('returns the drive letter segment for a bare drive root (matches the pre-existing split/filter/pop behavior)', () => {
    // 'C:\\'.split(/[\\/]/) -> ['C:', ''] -> filter(Boolean) -> ['C:'] -> pop() -> 'C:'.
    // Only a path with NO non-empty segments at all (e.g. '/' or '') falls back.
    expect(channelName('C:\\', 'fallback')).toBe('C:')
  })

  it('returns the last real segment for a path ending in a posix separator', () => {
    expect(channelName('/home/user/projects/foo/', 'fallback')).toBe('foo')
  })

  it('returns the last real segment for a path ending in a windows separator', () => {
    expect(channelName('C:\\Users\\me\\projects\\bar\\', 'fallback')).toBe('bar')
  })

  it('falls back to dirName for a null cwd', () => {
    expect(channelName(null, 'fallback')).toBe('fallback')
  })
})

describe('isStaleResponse', () => {
  it('is not stale when the request id matches the current id', () => {
    expect(isStaleResponse(3, 3)).toBe(false)
  })

  it('is stale when the request id no longer matches the current id', () => {
    expect(isStaleResponse(3, 4)).toBe(true)
  })
})

describe('shouldApplyReload', () => {
  // Task 10 fix pass 2: an onIndexed reload for the still-open session must
  // not wholesale-replace `items` if a NEWER turn started on that same
  // session while the reload's loadTranscript was in flight (a queued
  // back-to-back turn -- see App.tsx's reloadGenRef). Both the session-switch
  // guard (sessionReqId) and the same-session-newer-turn guard (gen) must
  // agree for a reload to be authoritative.
  it('applies when both the session id and generation are unchanged', () => {
    expect(shouldApplyReload(1, 1, 5, 5)).toBe(true)
  })

  it('skips when the session was switched away from (sessionReqId advanced)', () => {
    expect(shouldApplyReload(1, 2, 5, 5)).toBe(false)
  })

  it('skips when a newer turn started on the SAME session (gen advanced)', () => {
    expect(shouldApplyReload(1, 1, 5, 6)).toBe(false)
  })
})

describe('stableItemKeys', () => {
  const text = (uuid: string, text: string): RenderItem =>
    ({ kind: 'text', uuid, role: 'assistant', ts: null, model: null, text })

  it('gives every item a unique key even when several items share a uuid', () => {
    const items: RenderItem[] = [text('a1', 'one'), text('a1', 'two'), text('b2', 'three')]
    const keys = stableItemKeys(items)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps the same key for a logical item after older items are prepended', () => {
    const before: RenderItem[] = [text('a1', 'one'), text('a1', 'two'), text('b2', 'three')]
    const beforeKeys = stableItemKeys(before)

    // Simulate loadOlder prepending an older page with its own, disjoint uuids.
    const older: RenderItem[] = [text('z9', 'older-one'), text('z9', 'older-two')]
    const after = [...older, ...before]
    const afterKeys = stableItemKeys(after)

    // The three original items now sit at indices 2, 3, 4 instead of 0, 1, 2,
    // but their keys (derived from uuid + position-within-uuid-run) must be
    // unchanged, since neither their uuid nor their run position changed.
    expect(afterKeys.slice(2)).toEqual(beforeKeys)
  })
})

describe('followAfterScroll', () => {
  const MARGIN = 80
  it('stops following on any move up, even within the margin', () => {
    expect(followAfterScroll(true, 990, 1000, 10, MARGIN)).toBe(false)
  })
  it('keeps following when the position holds and the content grew', () => {
    expect(followAfterScroll(true, 1000, 1000, 500, MARGIN)).toBe(true)
  })
  it('stays out while scrolling down far from the end', () => {
    expect(followAfterScroll(false, 500, 400, 600, MARGIN)).toBe(false)
  })
  it('comes back when scrolling down near the end', () => {
    expect(followAfterScroll(false, 950, 900, 50, MARGIN)).toBe(true)
  })
  it('follows at the very end, even if the browser moved up because content shrank', () => {
    expect(followAfterScroll(false, 800, 1000, 0, MARGIN)).toBe(true)
  })
})

describe('shouldScrollToBottom', () => {
  it('is true the first time a freshly opened session gets non-empty items', () => {
    expect(shouldScrollToBottom(false, 60)).toBe(true)
  })

  it('is false while a session has not loaded any items yet (nothing to scroll to)', () => {
    expect(shouldScrollToBottom(false, 0)).toBe(false)
  })

  it('is false once the initial scroll-to-bottom has already happened, even as more items arrive via loadOlder', () => {
    expect(shouldScrollToBottom(true, 120)).toBe(false)
  })

  it('is false once already-scrolled even if items were to become momentarily empty', () => {
    expect(shouldScrollToBottom(true, 0)).toBe(false)
  })
})

describe('relativeTime', () => {
  // Fixed reference instant so the buckets are deterministic. Weekday/date
  // formatting is locale/timezone dependent, so those buckets are asserted by
  // shape (regex) rather than an exact string.
  const now = Date.parse('2026-07-25T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('returns "" for null and unparseable input', () => {
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime('not a date', now)).toBe('')
  })

  it('shows "now" under a minute', () => {
    expect(relativeTime(ago(30_000), now)).toBe('now')
  })

  it('shows minutes under an hour', () => {
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5m')
    expect(relativeTime(ago(59 * 60_000), now)).toBe('59m')
  })

  it('shows hours under a day', () => {
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3h')
    expect(relativeTime(ago(23 * 3_600_000), now)).toBe('23h')
  })

  it('shows a weekday under a week', () => {
    expect(relativeTime(ago(2 * 86_400_000), now)).toMatch(/^[A-Z][a-z]{2}$/)
  })

  it('shows a short date a week or more back', () => {
    expect(relativeTime(ago(10 * 86_400_000), now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
  })

  it('includes the year when it differs from the reference year', () => {
    expect(relativeTime('2024-02-03T00:00:00Z', now)).toMatch(/2024/)
  })
})

describe('formatClock', () => {
  it('returns "" for null/undefined/unparseable input', () => {
    expect(formatClock(null)).toBe('')
    expect(formatClock(undefined)).toBe('')
    expect(formatClock('not a date')).toBe('')
  })

  it('renders a local hour:minute clock (not a raw 24h UTC slice)', () => {
    // Built from a local Date so the assertion holds in any test timezone.
    const iso = new Date(2026, 0, 2, 15, 34).toISOString()
    expect(formatClock(iso)).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/i)
  })
})

describe('localDayKey', () => {
  it('is null for null/unparseable input', () => {
    expect(localDayKey(null)).toBeNull()
    expect(localDayKey('nope')).toBeNull()
  })

  it('shares a key across the same local day and differs across days', () => {
    const morning = new Date(2026, 0, 15, 9, 0).toISOString()
    const night = new Date(2026, 0, 15, 23, 0).toISOString()
    const nextDay = new Date(2026, 0, 16, 1, 0).toISOString()
    expect(localDayKey(morning)).toBe(localDayKey(night))
    expect(localDayKey(morning)).not.toBe(localDayKey(nextDay))
    expect(localDayKey(morning)).toBe(20260115)
  })
})

describe('dayDividerLabel', () => {
  const now = new Date(2026, 5, 15, 12, 0).getTime()

  it('labels today and yesterday relatively', () => {
    expect(dayDividerLabel(new Date(2026, 5, 15, 8, 0).toISOString(), now)).toBe('Today')
    expect(dayDividerLabel(new Date(2026, 5, 14, 8, 0).toISOString(), now)).toBe('Yesterday')
  })

  it('uses a full localized date further back', () => {
    const label = dayDividerLabel(new Date(2026, 5, 1, 8, 0).toISOString(), now)
    expect(label).not.toBe('Today')
    expect(label).not.toBe('Yesterday')
    expect(label).toMatch(/2026/)
  })

  it('returns "" for a null timestamp', () => {
    expect(dayDividerLabel(null, now)).toBe('')
  })
})

describe('clamp', () => {
  it('returns the value when in range', () => { expect(clamp(300, 200, 560)).toBe(300) })
  it('clamps below min', () => { expect(clamp(100, 200, 560)).toBe(200) })
  it('clamps above max', () => { expect(clamp(900, 200, 560)).toBe(560) })
})

describe('channelInitials', () => {
  it('takes one letter per camelCase word, capped at 3', () => {
    expect(channelInitials('SideQuest')).toBe('SQ')
    expect(channelInitials('LuckyElkMonitor')).toBe('LEM')
    expect(channelInitials('CardCenterScraper')).toBe('CCS')
  })
  it('splits on separators', () => {
    expect(channelInitials('netiquetteads-tasks-telegram')).toBe('NTT')
    expect(channelInitials('TrackCruisePrices.com')).toBe('TCP')
  })
  it('falls back to the first two letters of a single word', () => {
    expect(channelInitials('Sheets')).toBe('SH')
  })
  it('handles an acronym-prefixed word', () => {
    expect(channelInitials('CLBox')).toBe('CB')
  })
  it('handles a degenerate name', () => {
    expect(channelInitials('C:')).toBe('C')
    expect(channelInitials('!!!')).toBe('?')
  })
})

describe('avatarColor', () => {
  it('is deterministic for a given seed', () => {
    expect(avatarColor('Delegatto')).toBe(avatarColor('Delegatto'))
  })
  it('returns a hex color from the palette', () => {
    expect(avatarColor('LuckyElkMonitor')).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('collapsePastedText', () => {
  it('is not large for short, few-line text', () => {
    const r = collapsePastedText('hello\nworld')
    expect(r.isLarge).toBe(false)
    expect(r.charCount).toBe(11)
    expect(r.lineCount).toBe(2)
  })

  it('is not large at exactly the char threshold (800 chars, single line)', () => {
    const text = 'a'.repeat(800)
    const r = collapsePastedText(text)
    expect(r.charCount).toBe(800)
    expect(r.isLarge).toBe(false)
  })

  it('is large just over the char threshold (801 chars)', () => {
    const text = 'a'.repeat(801)
    const r = collapsePastedText(text)
    expect(r.isLarge).toBe(true)
  })

  it('is not large at exactly 10 lines', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const r = collapsePastedText(text)
    expect(r.lineCount).toBe(10)
    expect(r.isLarge).toBe(false)
  })

  it('is large at 11 lines even when short', () => {
    const text = Array.from({ length: 11 }, (_, i) => `l${i}`).join('\n')
    const r = collapsePastedText(text)
    expect(r.lineCount).toBe(11)
    expect(r.isLarge).toBe(true)
  })

  it('counts a single empty string as one line, zero chars, not large', () => {
    const r = collapsePastedText('')
    expect(r.lineCount).toBe(1)
    expect(r.charCount).toBe(0)
    expect(r.isLarge).toBe(false)
  })
})

describe('queueReducer', () => {
  const msg = (id: string, text = 'hi'): QueuedMessage => ({ id, text, images: [] })

  it('add appends a message to the end', () => {
    const s1 = queueReducer([], { type: 'add', msg: msg('a') })
    const s2 = queueReducer(s1, { type: 'add', msg: msg('b') })
    expect(s2.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('remove drops the message with the matching id and leaves the rest untouched', () => {
    const state = [msg('a'), msg('b'), msg('c')]
    const next = queueReducer(state, { type: 'remove', id: 'b' })
    expect(next.map(m => m.id)).toEqual(['a', 'c'])
  })

  it('remove is a no-op when the id is not present', () => {
    const state = [msg('a'), msg('b')]
    const next = queueReducer(state, { type: 'remove', id: 'zzz' })
    expect(next.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('move up swaps a message with its predecessor', () => {
    const state = [msg('a'), msg('b'), msg('c')]
    const next = queueReducer(state, { type: 'move', id: 'b', dir: 'up' })
    expect(next.map(m => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('move down swaps a message with its successor', () => {
    const state = [msg('a'), msg('b'), msg('c')]
    const next = queueReducer(state, { type: 'move', id: 'b', dir: 'down' })
    expect(next.map(m => m.id)).toEqual(['a', 'c', 'b'])
  })

  it('move up at the top is a no-op', () => {
    const state = [msg('a'), msg('b')]
    const next = queueReducer(state, { type: 'move', id: 'a', dir: 'up' })
    expect(next.map(m => m.id)).toEqual(['a', 'b'])
    expect(next).toEqual(state)
  })

  it('move down at the bottom is a no-op', () => {
    const state = [msg('a'), msg('b')]
    const next = queueReducer(state, { type: 'move', id: 'b', dir: 'down' })
    expect(next.map(m => m.id)).toEqual(['a', 'b'])
    expect(next).toEqual(state)
  })

  it('move is a no-op when the id is not present', () => {
    const state = [msg('a'), msg('b')]
    const next = queueReducer(state, { type: 'move', id: 'zzz', dir: 'up' })
    expect(next).toEqual(state)
  })

  it('clear empties the queue', () => {
    const state = [msg('a'), msg('b')]
    expect(queueReducer(state, { type: 'clear' })).toEqual([])
  })
})

describe('imageFromDataUrl', () => {
  it('parses a media type and base64 payload from a data URL', () => {
    const img = imageFromDataUrl('data:image/png;base64,iVBORw0KGgo=', 'img1')
    expect(img).toEqual({ id: 'img1', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' })
  })

  it('carries an optional name through when provided', () => {
    const img = imageFromDataUrl('data:image/jpeg;base64,/9j/4AAQ', 'img2', 'photo.jpg')
    expect(img).toEqual({ id: 'img2', mediaType: 'image/jpeg', dataBase64: '/9j/4AAQ', name: 'photo.jpg' })
  })

  it('returns null for a non-data URL', () => {
    expect(imageFromDataUrl('https://example.com/pic.png', 'img3')).toBeNull()
  })

  it('returns null for a data URL that is not base64-encoded', () => {
    expect(imageFromDataUrl('data:text/plain,hello', 'img4')).toBeNull()
  })

  it('returns null for a malformed data URL missing the comma payload', () => {
    expect(imageFromDataUrl('data:image/png;base64', 'img5')).toBeNull()
  })
})

describe('buildOutgoingText', () => {
  const chip = (id: string, text: string, lineCount: number): PastedTextChip => ({ id, text, lineCount })

  it('returns the box text unchanged when there are no pasted chips', () => {
    expect(buildOutgoingText('hello', [])).toBe('hello')
  })

  it('appends a single pasted chip after the box text with a labeled header', () => {
    const out = buildOutgoingText('look at this', [chip('p1', 'line1\nline2', 2)])
    expect(out).toBe('look at this\n\n[Pasted text #1 · 2 lines]\nline1\nline2')
  })

  it('numbers multiple pasted chips in order', () => {
    const out = buildOutgoingText('', [chip('p1', 'aaa', 1), chip('p2', 'bbb', 1)])
    expect(out).toBe('[Pasted text #1 · 1 lines]\naaa\n\n[Pasted text #2 · 1 lines]\nbbb')
  })

  it('omits an empty box text rather than leaving a leading blank line', () => {
    const out = buildOutgoingText('   ', [chip('p1', 'x', 1)])
    expect(out).toBe('[Pasted text #1 · 1 lines]\nx')
  })
})

describe('resolveNewProjectOptions', () => {
  const defaults: NewChatDefaults = { skipPermissions: true }

  it('requires a working directory when neither input nor defaults supply one', () => {
    expect(resolveNewProjectOptions({}, defaults)).toEqual({ ok: false, error: 'Choose a working directory' })
  })

  it('rejects a whitespace-only cwd', () => {
    expect(resolveNewProjectOptions({ cwd: '   ' }, defaults)).toEqual({ ok: false, error: 'Choose a working directory' })
  })

  it('trims the resolved cwd', () => {
    const result = resolveNewProjectOptions({ cwd: '  C:\\proj  ' }, defaults)
    expect(result).toEqual({ ok: true, options: { cwd: 'C:\\proj', skipPermissions: true } })
  })

  it('falls back to defaults.cwd when input omits cwd entirely', () => {
    const result = resolveNewProjectOptions({}, { ...defaults, cwd: 'C:\\default' })
    expect(result).toEqual({ ok: true, options: { cwd: 'C:\\default', skipPermissions: true } })
  })

  it('input.cwd wins over defaults.cwd when both are given', () => {
    const result = resolveNewProjectOptions({ cwd: 'C:\\explicit' }, { ...defaults, cwd: 'C:\\default' })
    expect(result.ok && result.options.cwd).toBe('C:\\explicit')
  })

  it('skipPermissions falls back to the default when input omits it', () => {
    const result = resolveNewProjectOptions({ cwd: 'C:\\proj' }, { skipPermissions: false })
    expect(result).toEqual({ ok: true, options: { cwd: 'C:\\proj', skipPermissions: false } })
  })

  it('input.skipPermissions overrides the default', () => {
    const result = resolveNewProjectOptions({ cwd: 'C:\\proj', skipPermissions: true }, { skipPermissions: false })
    expect(result.ok && result.options.skipPermissions).toBe(true)
  })

  it('input.skipPermissions === false overrides a true default (pins ?? over ||: false || true would wrongly be true)', () => {
    const result = resolveNewProjectOptions({ cwd: 'C:\\proj', skipPermissions: false }, { skipPermissions: true })
    expect(result.ok && result.options.skipPermissions).toBe(false)
  })

  it('model/effort pass through from input and fall back to defaults independently', () => {
    const result = resolveNewProjectOptions(
      { cwd: 'C:\\proj', model: 'opus' },
      { skipPermissions: true, effort: 'high' }
    )
    expect(result).toEqual({ ok: true, options: { cwd: 'C:\\proj', skipPermissions: true, model: 'opus', effort: 'high' } })
  })

  it('model/effort are omitted (not set to undefined) when neither input nor defaults supply them', () => {
    const result = resolveNewProjectOptions({ cwd: 'C:\\proj' }, defaults)
    expect(result.ok).toBe(true)
    const options = (result as { ok: true; options: NewProjectOptions }).options
    expect('model' in options).toBe(false)
    expect('effort' in options).toBe(false)
  })

  it('trims a given name', () => {
    const result = resolveNewProjectOptions({ cwd: 'C:\\proj', name: '  My Chat  ' }, defaults)
    expect(result).toEqual({ ok: true, options: { cwd: 'C:\\proj', skipPermissions: true, name: 'My Chat' } })
  })

  it('an empty or whitespace-only name resolves to undefined, not an empty string', () => {
    const result = resolveNewProjectOptions({ cwd: 'C:\\proj', name: '   ' }, defaults)
    expect(result.ok).toBe(true)
    const options = (result as { ok: true; options: NewProjectOptions }).options
    expect(options.name).toBeUndefined()
    expect('name' in options).toBe(false)
  })

  it('returns a clean NewProjectOptions with no stray defaults-only fields', () => {
    const result = resolveNewProjectOptions(
      { cwd: 'C:\\proj', skipPermissions: false },
      { cwd: 'C:\\ignored-because-input-has-one', skipPermissions: true, model: 'sonnet', effort: 'low' }
    )
    expect(result).toEqual({
      ok: true,
      options: { cwd: 'C:\\proj', skipPermissions: false, model: 'sonnet', effort: 'low' }
    })
  })
})

// ── Permission + plan-approval cards (Plan 2 Task 9) ────────────────────────

describe('summarizePermissionRequest', () => {
  it('summarizes a Bash request as "Bash: <command>"', () => {
    expect(summarizePermissionRequest('Bash', { command: 'npx playwright test' })).toBe('Bash: npx playwright test')
  })

  it('falls back to the bare tool name for Bash with no command', () => {
    expect(summarizePermissionRequest('Bash', {})).toBe('Bash')
  })

  it('truncates a very long Bash command', () => {
    const long = 'echo ' + 'x'.repeat(200)
    const summary = summarizePermissionRequest('Bash', { command: long })
    expect(summary.startsWith('Bash: echo ')).toBe(true)
    expect(summary.endsWith('…')).toBe(true)
    expect(summary.length).toBeLessThan(long.length)
  })

  it('summarizes a Read request as "Read: <path>"', () => {
    expect(summarizePermissionRequest('Read', { file_path: '/tmp/foo.txt' })).toBe('Read: /tmp/foo.txt')
  })

  it('summarizes an Edit request using the path fallback field', () => {
    expect(summarizePermissionRequest('Edit', { path: '/tmp/bar.txt' })).toBe('Edit: /tmp/bar.txt')
  })

  it('falls back to the bare tool name for Write with no discoverable path', () => {
    expect(summarizePermissionRequest('Write', { content: 'hello' })).toBe('Write')
  })

  it('falls back to tool name + key=value pairs for an unrecognized tool', () => {
    expect(summarizePermissionRequest('WebFetch', { url: 'https://example.com', method: 'GET' }))
      .toBe('WebFetch: url=https://example.com method=GET')
  })

  it('falls back to the bare tool name for an unrecognized tool with an empty object', () => {
    expect(summarizePermissionRequest('WebFetch', {})).toBe('WebFetch')
  })

  it('never throws for non-object input: a string', () => {
    expect(summarizePermissionRequest('Bash', 'npx playwright test')).toBe('Bash')
  })

  it('never throws for non-object input: null', () => {
    expect(summarizePermissionRequest('Read', null)).toBe('Read')
  })

  it('never throws for non-object input: undefined', () => {
    expect(summarizePermissionRequest('Other', undefined)).toBe('Other')
  })

  it('never throws for non-object input: a number', () => {
    expect(summarizePermissionRequest('Other', 42)).toBe('Other')
  })

  it('never throws for non-object input: an array', () => {
    expect(summarizePermissionRequest('Other', ['a', 'b'])).toBe('Other')
  })
})

describe('isPlanApproval', () => {
  it('is true for ExitPlanMode', () => {
    expect(isPlanApproval('ExitPlanMode')).toBe(true)
  })

  it('is false for an ordinary tool', () => {
    expect(isPlanApproval('Bash')).toBe(false)
    expect(isPlanApproval('Read')).toBe(false)
    expect(isPlanApproval('')).toBe(false)
  })
})

describe('previewAllowAlwaysRule', () => {
  it('never throws for non-object input', () => {
    expect(previewAllowAlwaysRule('Bash', 'npx playwright test')).toBe('Bash')
    expect(previewAllowAlwaysRule('Read', null)).toBe('Read')
    expect(previewAllowAlwaysRule('Other', 42)).toBe('Other')
  })

  // THE IMPORTANT TEST: the renderer's preview must show EXACTLY the rule the
  // main-process bridge is actually about to persist -- a preview that lies
  // about what gets granted would be worse than no preview at all.
  it('matches the real allowAlwaysRule for a multi-token Bash command', () => {
    const input = { command: 'npx playwright test' }
    expect(previewAllowAlwaysRule('Bash', input)).toBe(allowAlwaysRule('Bash', input))
    expect(previewAllowAlwaysRule('Bash', input)).toBe('Bash(npx playwright *)')
  })

  it('matches the real allowAlwaysRule for a single-token Bash command', () => {
    const input = { command: 'ls' }
    expect(previewAllowAlwaysRule('Bash', input)).toBe(allowAlwaysRule('Bash', input))
    expect(previewAllowAlwaysRule('Bash', input)).toBe('Bash(ls *)')
  })

  it('matches the real allowAlwaysRule for Bash with no command', () => {
    expect(previewAllowAlwaysRule('Bash', {})).toBe(allowAlwaysRule('Bash', {}))
  })

  it('matches the real allowAlwaysRule for a Read with a file_path', () => {
    const input = { file_path: '/repo/src/index.ts' }
    expect(previewAllowAlwaysRule('Read', input)).toBe(allowAlwaysRule('Read', input))
    expect(previewAllowAlwaysRule('Read', input)).toBe('Read(/repo/src/index.ts)')
  })

  it('matches the real allowAlwaysRule for an Edit with a path fallback field', () => {
    const input = { path: '/repo/src/foo.ts' }
    expect(previewAllowAlwaysRule('Edit', input)).toBe(allowAlwaysRule('Edit', input))
  })

  it('matches the real allowAlwaysRule for Write with no discoverable path', () => {
    expect(previewAllowAlwaysRule('Write', { content: 'x' })).toBe(allowAlwaysRule('Write', { content: 'x' }))
    expect(previewAllowAlwaysRule('Write', { content: 'x' })).toBe('Write')
  })

  it('matches the real allowAlwaysRule for an unrecognized tool', () => {
    expect(previewAllowAlwaysRule('WebFetch', { url: 'https://example.com' }))
      .toBe(allowAlwaysRule('WebFetch', { url: 'https://example.com' }))
    expect(previewAllowAlwaysRule('WebFetch', { url: 'https://example.com' })).toBe('WebFetch')
  })
})

describe('planTextFromInput', () => {
  it('extracts the plan field when present', () => {
    expect(planTextFromInput({ plan: '1. Do the thing\n2. Ship it' })).toBe('1. Do the thing\n2. Ship it')
  })

  it('falls back to raw JSON when there is no plan field', () => {
    expect(planTextFromInput({ notPlan: 'x' })).toBe(JSON.stringify({ notPlan: 'x' }, null, 2))
  })

  it('never throws for non-object input: a string falls back to its JSON form', () => {
    expect(planTextFromInput('just a string')).toBe(JSON.stringify('just a string', null, 2))
  })

  it('never throws for non-object input: null', () => {
    expect(planTextFromInput(null)).toBe('null')
  })

  it('never throws for non-object input: undefined', () => {
    expect(planTextFromInput(undefined)).toBe('')
  })
})

// ── Live streaming reconciliation (Plan 2 Task 10) ──────────────────────────

describe('reduceLivePreview', () => {
  it('starts a preview from a delta on a null preview', () => {
    const result = reduceLivePreview(null, { kind: 'delta', text: 'o' })
    expect(result).toEqual({ text: 'o', sealed: false })
  })

  it('appends successive deltas', () => {
    const p1 = reduceLivePreview(null, { kind: 'delta', text: 'o' })
    const p2 = reduceLivePreview(p1, { kind: 'delta', text: 'k' })
    expect(p2).toEqual({ text: 'ok', sealed: false })
  })

  it('replaces the preview wholesale with an assistant event carrying text, and seals it', () => {
    const prev: LivePreview = { text: 'partial', sealed: false }
    const event: LiveEvent = { kind: 'assistant', uuid: 'a1', blocks: [{ type: 'text', text: 'full reply' }] }
    expect(reduceLivePreview(prev, event)).toEqual({ text: 'full reply', sealed: true })
  })

  it('joins multiple text blocks in an assistant event', () => {
    const event: LiveEvent = {
      kind: 'assistant', uuid: 'a1',
      blocks: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]
    }
    expect(reduceLivePreview(null, event)).toEqual({ text: 'line one\nline two', sealed: true })
  })

  it('leaves the preview unchanged for a tool-only assistant event (no text blocks)', () => {
    const prev: LivePreview = { text: 'still typing', sealed: false }
    const event: LiveEvent = {
      kind: 'assistant', uuid: 'a1',
      blocks: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }]
    }
    expect(reduceLivePreview(prev, event)).toEqual(prev)
  })

  it('on result, clears text still being typed and leaves a finished bubble for its saved row', () => {
    const sealed: LivePreview = { text: 'ok', sealed: true }
    expect(reduceLivePreview(sealed, { kind: 'result', isError: false, costUsd: 0.01, text: 'ok' })).toBe(sealed)
    expect(reduceLivePreview({ text: 'ok', sealed: false }, { kind: 'result', isError: false, costUsd: 0.01, text: 'ok' })).toBeNull()
  })

  it('leaves the preview unchanged for init/rate_limit/other', () => {
    const prev: LivePreview = { text: 'mid-stream', sealed: false }
    expect(reduceLivePreview(prev, { kind: 'init', sessionId: 's1', cwd: 'C:\\x', model: 'opus', permissionMode: 'bypassPermissions' })).toBe(prev)
    expect(reduceLivePreview(prev, { kind: 'rate_limit', status: 'allowed', resetsAt: null })).toBe(prev)
    expect(reduceLivePreview(prev, { kind: 'other', type: 'refused-external-live' })).toBe(prev)
  })

  // ── Fix 1 (Task 10 review): the `exit` LiveEvent ────────────────────────
  it('clears the preview on exit, same as result', () => {
    const prev: LivePreview = { text: 'mid-stream', sealed: false }
    expect(reduceLivePreview(prev, { kind: 'exit', code: null })).toBeNull()
    expect(reduceLivePreview(prev, { kind: 'exit', code: 1 })).toBeNull()
  })

  it('a null preview stays null across a non-text-producing event', () => {
    expect(reduceLivePreview(null, { kind: 'rate_limit', status: 'allowed', resetsAt: null })).toBeNull()
  })

  // ── Finding 2 (Task 10 review): message-boundary sealing ──────────────────
  // Without sealing, a tool-calling turn's second message's deltas would run
  // on directly after the first message's already-finished text (no message
  // boundary is carried by `delta` itself) -- these tests pin down the fix.

  it('delta after delta (same message) keeps appending, unsealed', () => {
    const p1 = reduceLivePreview(null, { kind: 'delta', text: 'Hel' })
    const p2 = reduceLivePreview(p1, { kind: 'delta', text: 'lo' })
    expect(p2).toEqual({ text: 'Hello', sealed: false })
  })

  it('a delta arriving after a sealed (assistant-finished) preview starts FRESH, not appended', () => {
    const afterMessage1: LivePreview = { text: 'message one, done.', sealed: true }
    const next = reduceLivePreview(afterMessage1, { kind: 'delta', text: 'Mess' })
    // Must be a brand-new preview seeded with just this delta's text -- NOT
    // 'message one, done.Mess', which would be the run-on bug.
    expect(next).toEqual({ text: 'Mess', sealed: false })
  })

  it('full tool-calling turn: text1 deltas -> assistant seals -> text2 deltas start fresh -> assistant seals again', () => {
    let preview: LivePreview | null = null
    preview = reduceLivePreview(preview, { kind: 'delta', text: 'First' })
    preview = reduceLivePreview(preview, { kind: 'delta', text: ' message' })
    expect(preview).toEqual({ text: 'First message', sealed: false })

    // assistant event closes out message 1 (may include a tool_use alongside the text)
    preview = reduceLivePreview(preview, {
      kind: 'assistant', uuid: 'a1',
      blocks: [{ type: 'text', text: 'First message' }, { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }]
    })
    expect(preview).toEqual({ text: 'First message', sealed: true })

    // message 2's first delta must NOT run onto message 1's text
    preview = reduceLivePreview(preview, { kind: 'delta', text: 'Second' })
    expect(preview).toEqual({ text: 'Second', sealed: false })
    preview = reduceLivePreview(preview, { kind: 'delta', text: ' message' })
    expect(preview).toEqual({ text: 'Second message', sealed: false })

    preview = reduceLivePreview(preview, {
      kind: 'assistant', uuid: 'a2', blocks: [{ type: 'text', text: 'Second message' }]
    })
    expect(preview).toEqual({ text: 'Second message', sealed: true })

    expect(reduceLivePreview(preview, { kind: 'result', isError: false, costUsd: 0.01, text: 'Second message' })).toEqual({ text: 'Second message', sealed: true })
  })
})

describe('clearsRunning (Task 10 review Fix 1)', () => {
  it('true for result', () => {
    expect(clearsRunning({ kind: 'result', isError: false, costUsd: 0, text: '' })).toBe(true)
  })

  it('true for exit, regardless of code', () => {
    expect(clearsRunning({ kind: 'exit', code: null })).toBe(true)
    expect(clearsRunning({ kind: 'exit', code: 0 })).toBe(true)
    expect(clearsRunning({ kind: 'exit', code: 1 })).toBe(true)
  })

  it('true for other/refused-external-live and other/unknown-session', () => {
    expect(clearsRunning({ kind: 'other', type: 'refused-external-live' })).toBe(true)
    expect(clearsRunning({ kind: 'other', type: 'unknown-session' })).toBe(true)
  })

  it('false for an unrelated other type, and for delta/assistant/init/rate_limit', () => {
    expect(clearsRunning({ kind: 'other', type: 'system' })).toBe(false)
    expect(clearsRunning({ kind: 'delta', text: 'x' })).toBe(false)
    expect(clearsRunning({ kind: 'assistant', uuid: 'a1', blocks: [] })).toBe(false)
    expect(clearsRunning({ kind: 'init', sessionId: 's1', cwd: 'C:\\x', model: 'opus', permissionMode: 'default' })).toBe(false)
    expect(clearsRunning({ kind: 'rate_limit', status: 'allowed', resetsAt: null })).toBe(false)
  })
})

describe('appendRowsToItems', () => {
  const text = (uuid: string, t: string): RenderItem =>
    ({ kind: 'text', uuid, role: 'assistant', ts: null, model: null, text: t })
  const tool = (uuid: string, toolUseId: string): RenderItem =>
    ({ kind: 'tool', uuid, toolUseId, name: 'Read', input: {}, result: null, subagentToolUseId: null })

  it('appends genuinely new items', () => {
    const items = [text('a1', 'hello')]
    const next = appendRowsToItems(items, [text('a2', 'world')])
    expect(next.map(i => (i as { text: string }).text)).toEqual(['hello', 'world'])
  })

  it('returns the same array reference when there is nothing new to append', () => {
    const items = [text('a1', 'hello')]
    const next = appendRowsToItems(items, [text('a1', 'hello')])
    expect(next).toBe(items)
  })

  it('drops an exact re-delivery of an already-rendered text item (same uuid+kind, same position)', () => {
    const items = [text('a1', 'hello'), text('a2', 'world')]
    // The watcher re-emitted the exact same two rows already present.
    const next = appendRowsToItems(items, [text('a1', 'hello'), text('a2', 'world')])
    expect(next).toEqual(items)
  })

  it('dedupes a tool item by its toolUseId regardless of position', () => {
    const items = [text('a1', 'hi'), tool('a2', 'toolu_01')]
    const next = appendRowsToItems(items, [tool('a2', 'toolu_01')])
    expect(next.filter(i => i.kind === 'tool').length).toBe(1)
  })

  it('appends a genuinely new tool item with a different toolUseId', () => {
    const items = [tool('a1', 'toolu_01')]
    const next = appendRowsToItems(items, [tool('a2', 'toolu_02')])
    expect(next.length).toBe(2)
  })

  it('appends both text items when a single row with two text blocks arrives in one batch (same-batch occurrence counting, not a false dedup)', () => {
    // A row's blocks are always rendered together by buildRenderItems within
    // ONE batch -- so two text blocks from the same uuid always arrive
    // side-by-side in newItems, never split across two separate calls.
    const items = [text('z9', 'unrelated')]
    const next = appendRowsToItems(items, [text('a1', 'first block'), text('a1', 'second block')])
    expect(next.map(i => (i as { text: string }).text)).toEqual(['unrelated', 'first block', 'second block'])
  })
})

describe('hasAssistantRenderItem (Task 10 review Fix 5)', () => {
  const assistantText = (uuid: string): RenderItem =>
    ({ kind: 'text', uuid, role: 'assistant', ts: null, model: null, text: 'hi' })
  const userText = (uuid: string): RenderItem =>
    ({ kind: 'text', uuid, role: 'user', ts: null, model: null, text: 'hi' })
  const tool = (uuid: string): RenderItem =>
    ({ kind: 'tool', uuid, toolUseId: 'toolu_01', name: 'Read', input: {}, result: null, subagentToolUseId: null })
  const thinking = (uuid: string): RenderItem => ({ kind: 'thinking', uuid, ts: null, text: 'thinking' })

  it('true for an assistant text item', () => {
    expect(hasAssistantRenderItem([assistantText('a1')])).toBe(true)
  })

  it('true for a tool item (always assistant-initiated)', () => {
    expect(hasAssistantRenderItem([tool('a1')])).toBe(true)
  })

  it('false for a user text item alone', () => {
    expect(hasAssistantRenderItem([userText('u1')])).toBe(false)
  })

  it('false for a thinking item alone (no role, not a durable assistant message/tool)', () => {
    expect(hasAssistantRenderItem([thinking('t1')])).toBe(false)
  })

  it('false for an empty list', () => {
    expect(hasAssistantRenderItem([])).toBe(false)
  })

  it('true when an assistant item is mixed in among others', () => {
    expect(hasAssistantRenderItem([userText('u1'), thinking('t1'), assistantText('a1')])).toBe(true)
  })
})

describe('suppressSealedPreview (Task 10 review Fix 5)', () => {
  it('clears a SEALED preview once a durable assistant row has landed', () => {
    const sealed: LivePreview = { text: 'First message', sealed: true }
    expect(suppressSealedPreview(sealed, true)).toBeNull()
  })

  it('leaves an UNSEALED (still-streaming) preview untouched even when a durable assistant row lands', () => {
    const streaming: LivePreview = { text: 'Second mess', sealed: false }
    expect(suppressSealedPreview(streaming, true)).toBe(streaming)
  })

  it('leaves a sealed preview untouched when no durable assistant row landed in this batch', () => {
    const sealed: LivePreview = { text: 'First message', sealed: true }
    expect(suppressSealedPreview(sealed, false)).toBe(sealed)
  })

  it('passes a null preview through unchanged either way', () => {
    expect(suppressSealedPreview(null, true)).toBeNull()
    expect(suppressSealedPreview(null, false)).toBeNull()
  })
})

describe('renderItemsFromStreamedRows', () => {
  function row(r: unknown, byteOffset = 0, seq = 0): StreamedRow {
    return { row: r as StreamedRow['row'], byteOffset, seq }
  }

  it('converts a message row into render items via the same model as the read path', () => {
    const rows = [
      row({ type: 'assistant', uuid: 'a1', parentUuid: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    ]
    const items = renderItemsFromStreamedRows(rows)
    expect(items).toEqual([{ kind: 'text', uuid: 'a1', role: 'assistant', ts: null, model: null, text: 'hi' }])
  })

  it('filters out non-message rows (e.g. file-history-snapshot)', () => {
    const rows = [row({ type: 'file-history-snapshot', snapshot: 1 })]
    expect(renderItemsFromStreamedRows(rows)).toEqual([])
  })

  it('pairs a tool_use with its tool_result when both are in the same batch', () => {
    const rows = [
      row({ type: 'assistant', uuid: 'a1', parentUuid: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }] } }),
      row({ type: 'user', uuid: 'u1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'done' }] } })
    ]
    const items = renderItemsFromStreamedRows(rows)
    const tool = items.find(i => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.result?.text).toBe('done')
  })
})

describe('liveIndicatorState', () => {
  it('is idle when not running', () => {
    expect(liveIndicatorState(false, 0)).toBe('idle')
    expect(liveIndicatorState(false, 3)).toBe('idle')
  })

  it('is streaming while running with an empty queue', () => {
    expect(liveIndicatorState(true, 0)).toBe('streaming')
  })

  it('is queued while running with messages parked behind the current turn', () => {
    expect(liveIndicatorState(true, 2)).toBe('queued')
  })
})

describe('parseEditedInput', () => {
  it('parses valid JSON', () => {
    expect(parseEditedInput('{"command":"ls -la"}')).toEqual({ ok: true, value: { command: 'ls -la' } })
  })

  it('parses a JSON primitive', () => {
    expect(parseEditedInput('42')).toEqual({ ok: true, value: 42 })
  })

  it('reports an error for invalid JSON rather than throwing', () => {
    const result = parseEditedInput('{not valid json')
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error.length).toBeGreaterThan(0)
  })

  it('reports an error for an empty string', () => {
    const result = parseEditedInput('')
    expect(result.ok).toBe(false)
  })
})

// ── Nav metadata (Plan 3 Task 2) — resolveChannelName / resolveChannelIcon /
// groupChannels / clampMenuPosition / dataUrlSizeOk ─────────────────────────

function meta(overrides: Partial<ChannelMeta> = {}): ChannelMeta {
  return { dirName: 'd1', friendlyName: null, starred: false, groupId: null, icon: { kind: 'initials' }, hidden: false, ...overrides }
}

let nextChannelId = 1
function channelRow(overrides: Partial<ChannelRow> = {}): ChannelRow {
  const id = nextChannelId++
  return {
    id, dirName: `dir-${id}`, cwd: null, sessionCount: 1, lastActivity: null, preview: null,
    meta: meta({ dirName: `dir-${id}` }),
    ...overrides
  }
}

describe('resolveChannelName', () => {
  it('prefers the friendly name when set', () => {
    expect(resolveChannelName(meta({ friendlyName: 'My Project' }), '/home/me/foo', 'foo-dir')).toBe('My Project')
  })

  it('falls back to channelName(cwd, dirName) when no friendly name is set', () => {
    expect(resolveChannelName(meta({ friendlyName: null }), '/home/me/foo', 'foo-dir')).toBe('foo')
  })

  it('falls back to dirName when both friendlyName and cwd are absent', () => {
    expect(resolveChannelName(meta({ friendlyName: null }), null, 'foo-dir')).toBe('foo-dir')
  })
})

describe('resolveChannelIcon', () => {
  it('resolves the initials default from the channel name (deterministic text + color)', () => {
    const resolved = resolveChannelIcon(meta({ icon: { kind: 'initials' } }), 'Delegatto')
    expect(resolved).toEqual({ kind: 'initials', text: channelInitials('Delegatto'), color: avatarColor('Delegatto') })
  })

  it('resolves an emoji icon', () => {
    const resolved = resolveChannelIcon(meta({ icon: { kind: 'emoji', emoji: '🚀' } }), 'Anything')
    expect(resolved).toEqual({ kind: 'emoji', emoji: '🚀' })
  })

  it('resolves a color icon', () => {
    const resolved = resolveChannelIcon(meta({ icon: { kind: 'color', color: '#ff00aa' } }), 'Anything')
    expect(resolved).toEqual({ kind: 'color', color: '#ff00aa' })
  })

  it('resolves an image icon', () => {
    const resolved = resolveChannelIcon(meta({ icon: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' } }), 'Anything')
    expect(resolved).toEqual({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' })
  })
})

describe('groupChannels', () => {
  it('elevates a starred channel into Starred EXCLUSIVELY, not also under its group', () => {
    const g1: ChannelGroup = { id: 1, name: 'Work', sortOrder: 0, icon: { kind: 'initials' } }
    const starredGrouped = channelRow({ meta: meta({ dirName: 'a', starred: true, groupId: 1 }) })
    const sections = groupChannels([starredGrouped], [g1])

    const starred = sections.find(s => s.kind === 'starred')
    const group = sections.find(s => s.kind === 'group' && s.groupId === 1)
    expect(starred?.channels).toEqual([starredGrouped])
    expect(group?.channels).toEqual([]) // NOT double-listed under its group
  })

  it('does not double-list a starred, ungrouped channel under the recency buckets', () => {
    const starredUngrouped = channelRow({ meta: meta({ dirName: 'a', starred: true, groupId: null }) })
    const plainUngrouped = channelRow({ meta: meta({ dirName: 'b', groupId: null }) })
    const sections = groupChannels([starredUngrouped, plainUngrouped], [])

    expect(sections.find(s => s.kind === 'starred')?.channels).toEqual([starredUngrouped])
    // the starred one is elevated out; only the plain channel remains in a bucket
    expect(sections.find(s => s.kind === 'time')?.channels).toEqual([plainUngrouped])
  })

  it('orders sections: Starred first, then groups in sortOrder, then recency buckets last', () => {
    const g1: ChannelGroup = { id: 1, name: 'B-Group', sortOrder: 1, icon: { kind: 'initials' } }
    const g2: ChannelGroup = { id: 2, name: 'A-Group', sortOrder: 0, icon: { kind: 'initials' } }
    const starredChannel = channelRow({ meta: meta({ dirName: 's', starred: true, groupId: null }) })
    const g1Channel = channelRow({ meta: meta({ dirName: 'g1c', groupId: 1 }) })
    const g2Channel = channelRow({ meta: meta({ dirName: 'g2c', groupId: 2 }) })
    const ungroupedChannel = channelRow({ meta: meta({ dirName: 'u', groupId: null }) }) // null lastActivity -> Older

    const sections = groupChannels([starredChannel, g1Channel, g2Channel, ungroupedChannel], [g1, g2])

    expect(sections.map(s => s.kind === 'group' ? `group:${s.groupId}` : s.kind === 'time' ? `time:${s.bucket}` : s.kind)).toEqual([
      'starred', 'group:2', 'group:1', 'time:older'
    ])
    // sortOrder 0 (g2, "A-Group") comes before sortOrder 1 (g1, "B-Group").
    expect(sections[1]!.title).toBe('A-Group')
    expect(sections[2]!.title).toBe('B-Group')
  })

  it('splits ungrouped channels into recency buckets, most-recent first', () => {
    const now = Date.parse('2026-08-02T12:00:00Z')
    const D = 86_400_000
    const at = (offset: number, dirName: string) =>
      channelRow({ lastActivity: new Date(now - offset).toISOString(), meta: meta({ dirName, groupId: null }) })
    const todayC = at(0, 'today')
    const yestC = at(D, 'yest')
    const weekC = at(3 * D, 'week')
    const monthC = at(15 * D, 'month')
    const olderC = at(200 * D, 'older')

    const sections = groupChannels([monthC, olderC, todayC, weekC, yestC], [], now)
    expect(sections.map(s => (s.kind === 'time' ? s.bucket : s.kind))).toEqual(['today', 'yesterday', 'week', 'month', 'older'])
    expect(sections[0]!.title).toBe('Today')
  })

  it('omits the Starred section entirely when no channel is starred', () => {
    const sections = groupChannels([channelRow()], [])
    expect(sections.some(s => s.kind === 'starred')).toBe(false)
  })

  it('shows a group with no member channels (empty groups are not hidden)', () => {
    const g1: ChannelGroup = { id: 1, name: 'Empty Group', sortOrder: 0, icon: { kind: 'initials' } }
    const sections = groupChannels([], [g1])
    const group = sections.find(s => s.kind === 'group' && s.groupId === 1)
    expect(group).toBeDefined()
    expect(group?.channels).toEqual([])
  })

  it('shows no recency buckets when every channel belongs to a group', () => {
    const g1: ChannelGroup = { id: 1, name: 'Work', sortOrder: 0, icon: { kind: 'initials' } }
    const sections = groupChannels([channelRow({ meta: meta({ groupId: 1 }) })], [g1])
    expect(sections.some(s => s.kind === 'time')).toBe(false)
  })

  it('falls a channel whose groupId points at a missing group back into a recency bucket', () => {
    const dangling = channelRow({ meta: meta({ groupId: 999 }) })
    const sections = groupChannels([dangling], [])
    expect(sections.find(s => s.kind === 'time')?.channels).toEqual([dangling])
  })

  it('routes hidden channels to a Hidden section and out of every other section', () => {
    const visible = channelRow({ meta: meta({ dirName: 'v', groupId: null }) })
    // hidden despite being starred + grouped: it must appear ONLY under Hidden.
    const buried = channelRow({ meta: meta({ dirName: 'h', starred: true, groupId: 1, hidden: true }) })
    const g1 = { id: 1, name: 'G1', sortOrder: 0, icon: { kind: 'initials' as const } }
    const sections = groupChannels([visible, buried], [g1])

    const hidden = sections.find(s => s.kind === 'hidden')
    expect(hidden?.channels).toEqual([buried])
    // Not in Starred, not in its group, but present in a recency bucket.
    expect(sections.some(s => s.kind === 'starred')).toBe(false)
    expect(sections.find(s => s.kind === 'group')?.channels).toEqual([])
    expect(sections.find(s => s.kind === 'time')?.channels).toEqual([visible])
  })

  it('omits the Hidden section entirely when nothing is hidden', () => {
    const sections = groupChannels([channelRow()], [])
    expect(sections.some(s => s.kind === 'hidden')).toBe(false)
  })
})

describe('clampMenuPosition', () => {
  it('leaves the position unchanged when the menu fully fits on screen', () => {
    expect(clampMenuPosition(100, 100, 200, 150, 1600, 1000)).toEqual({ x: 100, y: 100 })
  })

  it('clamps x so the menu never spills past the right edge', () => {
    expect(clampMenuPosition(1550, 100, 200, 150, 1600, 1000)).toEqual({ x: 1400, y: 100 })
  })

  it('clamps y so the menu never spills past the bottom edge', () => {
    expect(clampMenuPosition(100, 950, 200, 150, 1600, 1000)).toEqual({ x: 100, y: 850 })
  })

  it('clamps into the top-left corner rather than going negative when the menu is larger than the viewport', () => {
    expect(clampMenuPosition(-50, -50, 2000, 2000, 1600, 1000)).toEqual({ x: 0, y: 0 })
  })
})

describe('dataUrlSizeOk', () => {
  function fakeDataUrl(byteLength: number): string {
    // base64 encodes 3 bytes as 4 chars -- build a payload of the right
    // decoded size without needing a real image.
    const raw = 'A'.repeat(byteLength)
    return `data:image/png;base64,${Buffer.from(raw).toString('base64')}`
  }

  it('accepts a data URL under the size limit', () => {
    expect(dataUrlSizeOk(fakeDataUrl(1000), 256 * 1024)).toBe(true)
  })

  it('rejects a data URL over the size limit', () => {
    expect(dataUrlSizeOk(fakeDataUrl(300 * 1024), 256 * 1024)).toBe(false)
  })

  it('accepts a data URL exactly at the size limit', () => {
    expect(dataUrlSizeOk(fakeDataUrl(256 * 1024), 256 * 1024)).toBe(true)
  })

  it('defaults to MAX_ICON_IMAGE_BYTES when no explicit limit is given', () => {
    expect(dataUrlSizeOk(fakeDataUrl(1000))).toBe(true)
    expect(dataUrlSizeOk(fakeDataUrl(MAX_ICON_IMAGE_BYTES + 1000))).toBe(false)
  })

  it('rejects a malformed data URL with no comma separator', () => {
    expect(dataUrlSizeOk('not-a-data-url', 256 * 1024)).toBe(false)
  })
})

describe('parseSnippet (XSS-safe FTS snippet)', () => {
  it('splits a single mark into plain/marked/plain segments', () => {
    expect(parseSnippet('the <mark>scraper</mark> stops')).toEqual([
      { text: 'the ', marked: false },
      { text: 'scraper', marked: true },
      { text: ' stops', marked: false }
    ])
  })
  it('handles multiple marks', () => {
    const segs = parseSnippet('<mark>a</mark> and <mark>b</mark>')
    expect(segs.filter(s => s.marked).map(s => s.text)).toEqual(['a', 'b'])
  })
  it('no marks -> one plain segment', () => {
    expect(parseSnippet('just text')).toEqual([{ text: 'just text', marked: false }])
  })
  it('renders literal < and > as PLAIN TEXT, never as a tag (XSS safety)', () => {
    // A message containing an HTML/script-looking substring must come back as a
    // single plain segment so React renders it verbatim (escaped), not as markup.
    const segs = parseSnippet('look: <script>alert(1)</script> ok')
    expect(segs).toEqual([{ text: 'look: <script>alert(1)</script> ok', marked: false }])
    expect(segs.some(s => s.marked)).toBe(false)
  })
  it('tolerates an unbalanced <mark> with no close (treats rest as plain)', () => {
    expect(parseSnippet('a <mark>b')).toEqual([
      { text: 'a ', marked: false },
      { text: '<mark>b', marked: false }
    ])
  })
})

describe('groupSearchHits', () => {
  const hit = (pk: number, dir: string, seq: number): SearchHit =>
    ({ sessionPk: pk, sessionId: `s${pk}`, projectDir: dir, seq, ts: null, snippet: `hit ${seq}` })
  const chMap = new Map([
    ['C--Demo', { cwd: 'C:\Demo', dirName: 'C--Demo', meta: { dirName: 'C--Demo', friendlyName: 'My Demo', starred: false, groupId: null, icon: { kind: 'initials' as const }, hidden: false } }]
  ])

  it('groups by session in rank (first-seen) order and resolves the channel name', () => {
    const groups = groupSearchHits([hit(1, 'C--Demo', 0), hit(1, 'C--Demo', 5), hit(2, 'C--Demo', 9)], chMap)
    expect(groups.map(g => g.sessionPk)).toEqual([1, 2])
    expect(groups[0]!.channelName).toBe('My Demo')       // friendlyName wins
    expect(groups[0]!.hits).toHaveLength(2)
  })
  it('falls back to the raw slug when the channel is not loaded', () => {
    const groups = groupSearchHits([hit(9, 'C--Unknown', 0)], chMap)
    expect(groups[0]!.channelName).toBe('C--Unknown')     // no crash, shows slug
  })
  it('caps groups and hits per group', () => {
    const many = Array.from({ length: 30 }, (_, i) => hit(i, 'C--Demo', i))
    expect(groupSearchHits(many, chMap, 20).length).toBe(20)
    const oneSession = Array.from({ length: 10 }, (_, i) => hit(1, 'C--Demo', i))
    expect(groupSearchHits(oneSession, chMap, 20, 5)[0]!.hits.length).toBe(5)
  })
  it('flattenSearchPositions enumerates every hit across groups for arrow-nav', () => {
    const groups = groupSearchHits([hit(1, 'C--Demo', 0), hit(1, 'C--Demo', 1), hit(2, 'C--Demo', 2)], chMap)
    expect(flattenSearchPositions(groups)).toEqual([
      { group: 0, hit: 0 }, { group: 0, hit: 1 }, { group: 1, hit: 0 }
    ])
  })
})

describe('groupIntoTurns', () => {
  const txt = (uuid: string, role: 'user' | 'assistant', text: string): RenderItem =>
    ({ kind: 'text', uuid, role, ts: null, model: role === 'assistant' ? 'opus' : null, text })
  const think = (uuid: string): RenderItem => ({ kind: 'thinking', uuid, ts: null, text: 'hmm' })
  const tool = (uuid: string): RenderItem =>
    ({ kind: 'tool', uuid, toolUseId: 't', name: 'Bash', input: {}, result: null, subagentToolUseId: null })
  const img = (uuid: string, role: 'user' | 'assistant'): RenderItem => ({ kind: 'image', uuid, role, source: {} })

  it('splits on role alternation, one turn per side', () => {
    const turns = groupIntoTurns([txt('u1', 'user', 'hi'), txt('a1', 'assistant', 'hello'), txt('u2', 'user', 'bye')])
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user'])
    expect(turns.map(t => t.items.length)).toEqual([1, 1, 1])
    expect(turns.map(t => t.startIndex)).toEqual([0, 1, 2])
  })

  it('attaches thinking and tool items to the preceding Claude text as one turn', () => {
    const turns = groupIntoTurns([
      txt('u1', 'user', 'do it'),
      think('a1'), txt('a1', 'assistant', 'sure'), tool('a1'), txt('a1', 'assistant', 'done')
    ])
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant'])
    expect(turns[1]!.items.map(i => i.kind)).toEqual(['thinking', 'text', 'tool', 'text'])
  })

  it('keeps a user text + pasted image in the same user turn', () => {
    const turns = groupIntoTurns([txt('u1', 'user', 'look'), img('u1', 'user'), txt('a1', 'assistant', 'ok')])
    expect(turns[0]!.role).toBe('user')
    expect(turns[0]!.items.map(i => i.kind)).toEqual(['text', 'image'])
    expect(turns[1]!.role).toBe('assistant')
  })

  it('returns [] for an empty transcript', () => {
    expect(groupIntoTurns([])).toEqual([])
  })

  it('startIndex tracks position so keys line up with stableItemKeys', () => {
    const items = [txt('u1', 'user', 'a'), think('a1'), tool('a1')]
    const turns = groupIntoTurns(items)
    expect(turns[1]!.startIndex).toBe(1) // the assistant turn begins at flat index 1
  })
})

describe('firstBlockedElsewhere', () => {
  const req = (id: string, sessionKey = '/p/s.jsonl') =>
    ({ id, tool: 'Write', input: {}, sessionKey } as import('../src/shared/engine-types').PermissionRequest)

  it('ignores a pending request in the OPEN session (that has its own inline card)', () => {
    const map = new Map([[1, [req('a')]]])
    expect(firstBlockedElsewhere(map, 1)).toBeNull()
  })

  it('returns the first pending request in a chat other than the open one', () => {
    const map = new Map([[1, [req('a')]], [2, [req('b')]]])
    expect(firstBlockedElsewhere(map, 1)?.sessionPk).toBe(2)
  })

  it('skips dismissed request ids', () => {
    const map = new Map([[2, [req('b')]]])
    expect(firstBlockedElsewhere(map, 1, new Set(['b']))).toBeNull()
  })

  it('returns null when nothing is pending', () => {
    expect(firstBlockedElsewhere(new Map(), null)).toBeNull()
  })
})

describe('projectDirFromSessionKey', () => {
  it('extracts the project dir from a session file path (posix and windows)', () => {
    expect(projectDirFromSessionKey('/home/u/.claude/projects/C--Demo/abc.jsonl')).toBe('C--Demo')
    expect(projectDirFromSessionKey('C:\\Users\\u\\.claude\\projects\\C--Demo\\abc.jsonl')).toBe('C--Demo')
  })
  it('returns null for a path with too few segments', () => {
    expect(projectDirFromSessionKey('abc.jsonl')).toBeNull()
  })
})

describe('timeBucket', () => {
  // Offsets from `now` (not fixed UTC strings) so the calendar-day boundaries
  // land in the intended bucket regardless of the test machine's timezone.
  const now = Date.parse('2026-08-02T12:00:00Z')
  const H = 3_600_000, D = 86_400_000
  const ago = (ms: number) => new Date(now - ms).toISOString()
  it('buckets by recency, calendar-based today/yesterday then rolling windows', () => {
    expect(timeBucket(ago(0), now)).toBe('today')        // now itself
    expect(timeBucket(ago(24 * H), now)).toBe('yesterday') // exactly 24h back is always the prior calendar day
    expect(timeBucket(ago(3 * D), now)).toBe('week')
    expect(timeBucket(ago(15 * D), now)).toBe('month')
    expect(timeBucket(ago(200 * D), now)).toBe('older')
  })
  it('sinks null / unparseable timestamps to older', () => {
    expect(timeBucket(null, now)).toBe('older')
    expect(timeBucket('not a date', now)).toBe('older')
  })
})

describe('terminalOnlyCommand', () => {
  it('flags commands that need the terminal', async () => {
    const { terminalOnlyCommand } = await import('../src/renderer/lib')
    expect(terminalOnlyCommand('/ide')).toBe('/ide')
    expect(terminalOnlyCommand('  /Login  ')).toBe('/login')
    // Delegatto has its own screen for these.
    for (const c of ['/chrome', '/memory', '/hooks', '/tasks', '/bashes', '/diff', '/export', '/plugin', '/plugins', '/marketplace']) expect(terminalOnlyCommand(c)).toBeNull()
  })
  it('leaves commands that work headlessly, skills and ordinary text alone', async () => {
    const { terminalOnlyCommand } = await import('../src/renderer/lib')
    for (const text of ['/compact', '/usage', '/model opus', '/mcp', '/context', '/build a login page', '/usr/bin is a path', 'please run /hooks later', '/hooksy']) {
      expect(terminalOnlyCommand(text)).toBeNull()
    }
  })
})
