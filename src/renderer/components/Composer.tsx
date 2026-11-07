import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type KeyboardEvent, type SetStateAction } from 'react'
import { api } from '../api'
import {
  collapsePastedText, queueReducer, imageFromDataUrl, buildOutgoingText, isRewindCommand,
  applyCompletion, commandTokenLength, completionAt, fileMention, filterCommands, matchesCommandName, rankFiles,
  type ComposerImage, type PastedTextChip, type QueueAction, type QueuedMessage
} from '../lib'
import { composeStore, nextHeld, shellCommandOf } from '../compose-store'
import { filterHistory, stepHistory } from '../prompt-history'
import type { ExternalLock } from '../../shared/engine-types'
import { HIJACK_WORKING_TEXT, hijackBlock } from '../../shared/hijack'
import type { ClaudeCommand, CommandSource } from '../../shared/claude-info-types'
import { CompletionMenu, useClaudeCommands, useProjectFiles, type MenuItem } from './ComposerMenu'
import { ComposerThumbnail } from './ChatImage'

const MAX_TEXTAREA_PX = 200
/** How long after one Esc a second one clears the box. */
const CLEAR_WINDOW_MS = 1000
/** How long Shift+Tab's new mode stays on show. */
const MODE_NOTE_MS = 2500

const SOURCE_TAG: Record<CommandSource, string | null> = { project: 'project', user: 'personal', plugin: null, synced: 'synced', mcp: 'MCP', builtin: null }

function commandMenuItem(c: ClaudeCommand): MenuItem {
  return { key: c.name, primary: `/${c.name}`, secondary: c.description || c.argumentHint, tag: c.plugin ?? SOURCE_TAG[c.source] }
}

function fileMenuItem(path: string): MenuItem {
  const trimmed = path.replace(/\/$/, '')
  const slash = trimmed.lastIndexOf('/')
  return { key: path, primary: path.endsWith('/') ? `${trimmed.slice(slash + 1)}/` : trimmed.slice(slash + 1), secondary: slash === -1 ? '' : trimmed.slice(0, slash + 1), tag: null }
}

let nextChipId = 0
/** Local-only id generator for chips/queue entries (never sent to the
 *  engine). A plain incrementing counter is enough -- these ids only need to
 *  be unique within one Composer instance's lifetime, not globally, and
 *  avoids pulling in a uuid dependency for pure UI bookkeeping. */
function localId(prefix: string): string {
  nextChipId += 1
  return `${prefix}-${nextChipId}`
}

/** Reads a File (an image pasted from the clipboard or dropped) as a data
 *  URL, then hands it to imageFromDataUrl. Isolated in its own function so
 *  the FileReader/async plumbing stays out of the event handlers below. */
function readImageFile(file: File): Promise<ComposerImage | null> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(imageFromDataUrl(result, localId('img'), file.name))
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** The message input at the bottom of an open chat: multiline textarea
 *  (Enter sends, Shift+Enter newlines), large pastes collapse to a chip,
 *  pasted/dropped images become chips, and typing while a turn is running
 *  queues the message instead of sending it. Esc takes the newest queued message
 *  back into the box, leaving Claude working. With nothing queued it stops the turn, and
 *  a message Claude hadn't answered yet comes back too. With Claude idle, Esc Esc clears
 *  the box and Up brings the text back.
 *
 *  Keyed by the parent on `sessionPk` (App.tsx passes `key={session.id}`) so
 *  switching sessions remounts this component fresh -- nothing of session A can
 *  bleed into session B. All of it survives a switch: the draft's text through
 *  the parent-owned initialDraft/onDraftChange pair, chips and the queue in
 *  composeStore.
 */
/** "a terminal" / "another Claude app" + pid, for the read-only notice. */
function lockHolder(lock: ExternalLock): string {
  const who = lock.entrypoint === 'cli' ? 'a terminal' : 'another Claude process'
  return `${who} (PID ${lock.pid})`
}

export function Composer({ sessionPk, running, settled = false, shellStops = 0, onCycleMode, lock = null, cwd = null, suggestion = null, onHijack, onShellCommand, initialDraft, onDraftChange, onSend, onSubmit, onInterrupt, onRewind, onCancelSending, onQueueLengthChange }: {
  /** True while a turn is in flight for this session. Enter queues instead
   *  of sending, and Esc interrupts, only while this is true. */
  running: boolean
  /** True once `running` and `lock` describe this chat, rather than the moment of opening it. */
  settled?: boolean
  /** Shift+Tab, as in the terminal. Answers with the mode it moved to. */
  onCycleMode?: () => string
  /** Goes up each time a `!` in this chat is stopped, which is a chance to send what's next. */
  shellStops?: number
  /** Set while a process outside Delegatto holds this chat: the composer
   *  goes read-only (typing/sending disabled, queued messages held, not
   *  drained) until it's released. Any draft text is kept. */
  lock?: ExternalLock | null
  /** The chat's folder: where / commands and @ files come from. */
  cwd?: string | null
  /** Ends the terminal holding this chat. Resolves to why it couldn't, or null. */
  /** Claude's guess at the next message: a click or Tab fills the box, never sends. */
  suggestion?: string | null
  onHijack?: () => Promise<string | null>
  /** A message starting with `!`. As in the terminal, during a turn it waits for the
   *  turn to end. Claude then gets the output and replies, with nothing more to send. */
  onShellCommand?: (command: string) => void
  initialDraft?: string
  onDraftChange?: (text: string) => void
  /** `text` is already fully combined (box text + any pasted chips folded
   *  in via buildOutgoingText) -- the parent just forwards it to
   *  api.send(sessionPk, text, images) verbatim. `pastedTexts` rides along
   *  for a parent that wants the raw chips (e.g. richer optimistic
   *  rendering); it's empty for a drained queue entry, since that text was
   *  already combined once at enqueue time. */
  onSend: (text: string, images: ComposerImage[], pastedTexts: PastedTextChip[], uuid?: string) => void
  /** The user sent something themselves, as opposed to a queued message going by itself. */
  onSubmit?: () => void
  onInterrupt: () => void
  /** Esc Esc on an empty box, with Claude idle: go back to an earlier message. */
  onRewind?: () => void
  /** A message that hasn't gone anywhere yet: calls it off. False if there's none. */
  onCancelSending?: () => boolean
  /** Fires whenever the queued-message count changes, so a parent (App.tsx)
   *  can drive a LiveIndicator badge without owning the queue itself (the
   *  queue's add/remove/reorder state stays fully internal to Composer,
   *  same as every other in-progress compose state -- only the count is
   *  surfaced). Optional: a Composer with no listener works exactly as
   *  before. */
  onQueueLengthChange?: (count: number) => void
  sessionPk: number
}) {
  const [text, setText] = useState(initialDraft ?? '')
  const { pasted: pastedChips, images: imageChips, queue, returned } = useSyncExternalStore(composeStore.subscribe, () => composeStore.get(sessionPk))
  function setPastedChips(next: SetStateAction<PastedTextChip[]>) {
    composeStore.update(sessionPk, s => ({ ...s, pasted: typeof next === 'function' ? next(s.pasted) : next }))
  }
  function setImageChips(next: SetStateAction<ComposerImage[]>) {
    composeStore.update(sessionPk, s => ({ ...s, images: typeof next === 'function' ? next(s.images) : next }))
  }
  function dispatchQueue(action: QueueAction) {
    composeStore.dispatch(sessionPk, action)
  }
  useEffect(() => {
    composeStore.setOpen(sessionPk)
    return () => composeStore.setOpen(null)
  }, [sessionPk])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)

  // "Hijack conversation": a second click confirms, since it ends a process.
  const [hijackConfirm, setHijackConfirm] = useState(false)
  const [hijacking, setHijacking] = useState(false)
  const [hijackError, setHijackError] = useState<string | null>(null)
  const hijackState = lock === null ? null : hijackBlock(lock)
  useEffect(() => { if (hijackState !== null) setHijackConfirm(false) }, [hijackState])
  useEffect(() => { if (lock === null) { setHijackConfirm(false); setHijackError(null) } }, [lock])
  async function hijack() {
    if (onHijack === undefined) return
    setHijacking(true)
    setHijackError(null)
    const error = await onHijack()
    setHijacking(false)
    setHijackConfirm(false)
    setHijackError(error)
    if (error === null) textareaRef.current?.focus()
  }

  // The / and @ menus. `dismissedFor` is the text Esc closed the menu on, so it
  // stays closed until the text changes.
  const [caret, setCaret] = useState(text.length)
  const [selected, setSelected] = useState(0)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const completion = lock === null && dismissedFor !== text ? completionAt(text, caret) : null
  const commands = useClaudeCommands(text.startsWith('/'), cwd)
  const files = useProjectFiles(completion?.kind === 'file', cwd)
  const knownCommands = useMemo(() => Array.isArray(commands) ? commands : [], [commands])
  const matches = useMemo(() => {
    if (completion === null) return { values: [] as string[], items: [] as MenuItem[], found: [] as ClaudeCommand[] }
    if (completion.kind === 'command') {
      const found = filterCommands(knownCommands, completion.query)
      return { values: found.map(c => `/${c.name}`), items: found.map(commandMenuItem), found }
    }
    const found = rankFiles(files ?? [], completion.query)
    return { values: found.map(fileMention), items: found.map(fileMenuItem), found: [] }
  }, [completion?.kind, completion?.query, knownCommands, files]) // eslint-disable-line react-hooks/exhaustive-deps
  const loading = completion !== null && (completion.kind === 'command' ? commands === 'loading' : files === null)
  const menuNote = loading ? 'Loading…' : null
  const menuOpen = completion !== null && (loading || matches.items.length > 0)
  const highlight = commandTokenLength(text, knownCommands)

  // Set once the user has arrowed to an item: Enter then always takes it.
  const navigated = useRef(false)
  useEffect(() => { setSelected(0); navigated.current = false }, [completion?.kind, completion?.query])

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [text])

  const showSuggestion = suggestion !== null && text === '' && !running && lock === null
  function useSuggestion() {
    if (suggestion === null) return
    pendingCaret.current = suggestion.length
    setCaret(suggestion.length)
    updateText(suggestion)
    textareaRef.current?.focus()
  }

  function pick(index: number) {
    const value = matches.values[index]
    if (completion === null || value === undefined) return
    const next = applyCompletion(text, completion, value)
    pendingCaret.current = next.caret
    setCaret(next.caret)
    updateText(next.text)
    textareaRef.current?.focus()
  }

  useEffect(() => {
    onQueueLengthChange?.(queue.length)
  }, [queue, onQueueLengthChange])

  // Auto-grow the textarea up to a capped height, then let it scroll.
  useEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  // Messages already in Claude Code's queue reach Claude by themselves. What's held
  // here goes when a turn ends: the transition from running=true to running=false (not
  // merely "is false") is what fires the next send, so a component that mounts already
  // idle doesn't spuriously fire on mount.
  function sendHeld(next: QueuedMessage) {
    dispatchQueue({ type: 'remove', id: next.id })
    const command = shellCommandOf(next.text)
    if (command !== null && onShellCommand !== undefined) onShellCommand(command)
    else onSend(next.text, next.images, [])
  }
  const prevRunning = useRef(running)
  useEffect(() => {
    const next = nextHeld(queue)
    if (prevRunning.current && !running && next !== undefined && lock === null) sendHeld(next)
    prevRunning.current = running
  }, [running, queue, onSend, lock]) // eslint-disable-line react-hooks/exhaustive-deps

  const seenStops = useRef(shellStops)
  useEffect(() => {
    if (seenStops.current === shellStops) return
    seenStops.current = shellStops
    const next = nextHeld(queue)
    if (!running && next !== undefined && lock === null) sendHeld(next)
  }, [shellStops]) // eslint-disable-line react-hooks/exhaustive-deps

  // A turn that ended while this chat wasn't on screen left no transition to see, so
  // what's held is checked once, as soon as it's known whether a turn is running.
  const checkedOnOpen = useRef(false)
  useEffect(() => {
    if (!settled || checkedOnOpen.current) return
    checkedOnOpen.current = true
    const next = nextHeld(queue)
    if (!running && next !== undefined && lock === null) sendHeld(next)
  }, [settled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Follows the queue's messages through Claude Code.
  const queueRef = useRef(queue)
  queueRef.current = queue
  const textRef = useRef(text)
  textRef.current = text
  const withdrawing = useRef(new Set<string>())
  const [queueBusy, setQueueBusy] = useState(false)
  const [queueNote, setQueueNote] = useState<string | null>(null)
  useEffect(() => {
    if (queueNote === null) return
    const timer = setTimeout(() => setQueueNote(null), 4000)
    return () => clearTimeout(timer)
  }, [queueNote])
  // A message that never reached Claude comes back ahead of anything typed since.
  useEffect(() => {
    if (returned === null || returned === undefined) return
    composeStore.update(sessionPk, s => ({ ...s, returned: null }))
    updateText([returned, textRef.current].filter(s => s.trim().length > 0).join('\n'))
    textareaRef.current?.focus()
  }, [returned]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => api.onEvent((pk, ev) => {
    if (pk !== sessionPk || ev.kind !== 'commandLifecycle') return
    if (ev.state === 'cancelled' && !withdrawing.current.has(ev.uuid)) {
      // Dropped by something other than this queue: it mustn't simply vanish.
      const lost = queueRef.current.find(m => m.uuid === ev.uuid)
      if (lost !== undefined) putInBox(lost)
    }
  }), [sessionPk])

  /** Takes a message back from Claude Code. False if Claude has it by now. */
  async function withdraw(m: QueuedMessage): Promise<boolean> {
    if (!m.uuid) return true
    withdrawing.current.add(m.uuid)
    const ok = await api.withdrawQueued(sessionPk, m.uuid)
    if (!ok) {
      // If Claude Code drops it after all, it still has to come back.
      withdrawing.current.delete(m.uuid)
      setQueueNote('Too late to change that one: Claude already has it.')
    }
    return ok
  }

  function putInBox(m: QueuedMessage) {
    dispatchQueue({ type: 'remove', id: m.id })
    updateText([m.text, textRef.current].map(s => s.trim()).filter(s => s.length > 0).join('\n'))
    if (m.images.length > 0) setImageChips(prev => [...m.images, ...prev])
    textareaRef.current?.focus()
  }

  const editingQueued = useRef(false)
  async function editQueued(m: QueuedMessage) {
    // A second Esc mustn't reach for the same message while it's on its way back.
    if (editingQueued.current) return
    editingQueued.current = true
    setQueueBusy(true)
    if (await withdraw(m)) putInBox(m)
    setQueueBusy(false)
    editingQueued.current = false
  }

  async function removeQueued(m: QueuedMessage) {
    setQueueBusy(true)
    if (await withdraw(m)) dispatchQueue({ type: 'remove', id: m.id })
    setQueueBusy(false)
  }

  /** Claude Code's queue runs in the order it was given, so from the first message that
   *  moves onward they're all taken back and sent again in the new order. */
  async function moveQueued(m: QueuedMessage, dir: 'up' | 'down') {
    const before = queueRef.current
    const after = queueReducer(before, { type: 'move', id: m.id, dir })
    const from = after.findIndex((item, i) => item !== before[i])
    if (from === -1) return
    setQueueBusy(true)
    const tail = after.slice(from)
    const kept = await Promise.all(tail.map(withdraw))
    const resent = tail.filter((_, i) => kept[i]).map(item => {
      if (!item.uuid) return item
      const uuid = crypto.randomUUID()
      onSend(item.text, item.images, [], uuid)
      return { ...item, uuid }
    })
    dispatchQueue({ type: 'set', items: [...after.slice(0, from), ...resent] })
    setQueueBusy(false)
  }

  const [modeNote, setModeNote] = useState<string | null>(null)
  useEffect(() => {
    if (modeNote === null) return
    const timer = setTimeout(() => setModeNote(null), MODE_NOTE_MS)
    return () => clearTimeout(timer)
  }, [modeNote])

  // Esc Esc clears the box, as in the terminal: the first press only says so.
  const [clearHint, setClearHint] = useState(false)
  const clearArmedAt = useRef(0)
  const rewindArmedAt = useRef(0)
  useEffect(() => {
    if (!clearHint) return
    const timer = setTimeout(() => setClearHint(false), CLEAR_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [clearHint])
  function escClears() {
    const now = Date.now()
    if (now - clearArmedAt.current > CLEAR_WINDOW_MS) {
      clearArmedAt.current = now
      setClearHint(true)
      return
    }
    clearArmedAt.current = 0
    setClearHint(false)
    const cleared = buildOutgoingText(text, pastedChips).trim()
    if (cleared.length > 0) {
      void api.keepInHistory(sessionPk, cleared)
      setHistory(prev => prev === null ? prev : [cleared, ...prev.filter(t => t !== cleared)])
    }
    clearCompose()
  }

  function updateText(next: string) {
    setText(next)
    if (next === '') setHistoryAt(-1)
    onDraftChange?.(next)
  }

  function clearCompose() {
    updateText('')
    setPastedChips([])
    setImageChips([])
  }

  function addImages(images: ComposerImage[]) {
    if (images.length === 0) return
    setImageChips(prev => [...prev, ...images])
  }

  async function filesToImageChips(files: FileList | File[]): Promise<ComposerImage[]> {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return []
    const results = await Promise.all(imageFiles.map(readImageFile))
    return results.filter((img): img is ComposerImage => img !== null)
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData.files
    if (files.length > 0) {
      const hasImage = Array.from(files).some(f => f.type.startsWith('image/'))
      if (hasImage) {
        e.preventDefault()
        void filesToImageChips(files).then(addImages)
        return
      }
    }
    const pasted = e.clipboardData.getData('text/plain')
    const { isLarge, lineCount } = collapsePastedText(pasted)
    if (isLarge) {
      e.preventDefault()
      setPastedChips(prev => [...prev, { id: localId('paste'), text: pasted, lineCount }])
    }
    // Small pastes: let the browser's default paste-into-textarea behavior run.
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault()
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    void filesToImageChips(e.dataTransfer.files).then(addImages)
  }

  function attemptSend() {
    // Guard against an empty send using what would actually go out: box text
    // combined with any pasted chips (a lone image with no text still
    // counts as non-empty; nothing at all is a no-op) -- neither sent nor
    // queued.
    const wouldSend = buildOutgoingText(text, pastedChips)
    if (wouldSend.trim().length === 0 && imageChips.length === 0) return
    if (lock !== null) return
    onSubmit?.()
    if (onShellCommand !== undefined && wouldSend.trimStart().startsWith('!')) {
      const command = wouldSend.trimStart().slice(1).trim()
      if (command.length > 0) {
        if (running) dispatchQueue({ type: 'add', msg: { id: localId('queued'), text: wouldSend, images: [], uuid: null } })
        else onShellCommand(command)
        clearCompose()
      }
      return
    }
    // A side question doesn't wait for the turn: that's what it's for.
    // Nor does /rewind: it says to stop first, which is only any use now.
    if (running && !/^\s*\/btw\s/.test(wouldSend) && !isRewindCommand(wouldSend)) {
      // QueuedMessage has a single `text` field with no separate pasted-chip
      // slot, so the combine has to happen now, at enqueue time.
      // It goes straight to Claude Code, which feeds it in at Claude's next step and
      // shows it here until then, as in the terminal. A slash command has to run on its
      // own, and some are handled here, so those wait for the turn to end.
      const uuid = wouldSend.trimStart().startsWith('/') ? null : crypto.randomUUID()
      dispatchQueue({ type: 'add', msg: { id: localId('queued'), text: wouldSend, images: imageChips, uuid } })
      if (uuid !== null) onSend(wouldSend, imageChips, [], uuid)
    } else {
      // Not running: hand the parent the raw pieces and let it do the
      // combine (it calls buildOutgoingText(text, pastedTexts) itself before
      // api.send) -- this mirrors exactly what the drain path below does
      // with an already-combined text and an empty pastedTexts array.
      onSend(text, imageChips, pastedChips)
    }
    clearCompose()
  }

  // Up and Down go through what was typed in this project, and Ctrl+R searches it.
  const [history, setHistory] = useState<string[] | null>(null)
  const [historyAt, setHistoryAt] = useState(-1)
  const historyDraft = useRef('')
  const [searching, setSearching] = useState<string | null>(null)
  const [searchSelected, setSearchSelected] = useState(0)
  async function loadHistory(): Promise<string[]> {
    if (history !== null) return history
    const loaded = await api.promptHistory(sessionPk)
    setHistory(loaded)
    return loaded
  }
  function moveHistory(dir: 'older' | 'newer', list: string[]) {
    if (historyAt === -1) historyDraft.current = text
    const step = stepHistory(list, historyAt, dir)
    if (step === null) return
    setHistoryAt(step.at)
    const next = step.at === -1 ? historyDraft.current : step.text
    pendingCaret.current = dir === 'older' ? 0 : next.length
    setCaret(pendingCaret.current)
    updateText(next)
  }
  const searchResults = searching === null ? [] : filterHistory(history ?? [], searching)
  function acceptSearch(send: boolean) {
    const picked = searchResults[Math.min(searchSelected, searchResults.length - 1)]
    setSearching(null)
    if (picked === undefined) return
    updateText(picked)
    pendingCaret.current = picked.length
    setCaret(picked.length)
    textareaRef.current?.focus()
    if (send) setTimeout(() => textareaRef.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })), 0)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab' && e.shiftKey && onCycleMode !== undefined) { e.preventDefault(); setModeNote(`Mode: ${onCycleMode()}`); return }
    if (e.key === 'r' && e.ctrlKey) {
      e.preventDefault()
      void loadHistory().then(() => { setSearching(''); setSearchSelected(0) })
      return
    }
    if (!menuOpen && !e.shiftKey && e.key === 'ArrowUp' && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      // As in the terminal: with something queued, Up goes to that first.
      const last = queue[queue.length - 1]
      if (text.length === 0 && historyAt === -1 && last !== undefined) { e.preventDefault(); void editQueued(last); return }
      e.preventDefault()
      void loadHistory().then(list => moveHistory('older', list))
      return
    }
    if (!menuOpen && !e.shiftKey && e.key === 'ArrowDown' && historyAt !== -1 && !text.slice(e.currentTarget.selectionEnd).includes('\n')) {
      e.preventDefault()
      void loadHistory().then(list => moveHistory('newer', list))
      return
    }
    if (menuOpen) {
      const count = matches.items.length
      if (e.key === 'Escape') { e.preventDefault(); setDismissedFor(text); return }
      if (count > 0 && e.key === 'ArrowDown') { e.preventDefault(); navigated.current = true; setSelected(s => (s + 1) % count); return }
      if (count > 0 && e.key === 'ArrowUp') { e.preventDefault(); navigated.current = true; setSelected(s => (s - 1 + count) % count); return }
      if (count > 0 && e.key === 'Tab') { e.preventDefault(); pick(selected); return }
      // A command typed out in full sends on Enter; otherwise Enter fills it in.
      const current = matches.found[selected]
      const typedInFull = completion?.kind === 'command' && matches.values[selected] === `/${completion.query}`
      const offNameOnly = completion?.kind === 'command' && current !== undefined && !matchesCommandName(current, completion.query)
      if (count > 0 && e.key === 'Enter' && !e.shiftKey && !typedInFull && (navigated.current || !offNameOnly)) { e.preventDefault(); pick(selected); return }
    }
    if (e.key === 'Tab' && showSuggestion) { e.preventDefault(); useSuggestion(); return }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      attemptSend()
      return
    }
    if (e.key === 'Escape') {
      // Unlike the terminal, what's queued comes back first and Claude keeps working, so
      // fixing a typo doesn't cost the work under way. Then Esc stops the turn.
      const last = queue[queue.length - 1]
      if (last !== undefined) { e.preventDefault(); void editQueued(last); return }
      if (running) { e.preventDefault(); onInterrupt(); return }
      if (onCancelSending?.() === true) { e.preventDefault(); return }
      if (text.length > 0 || pastedChips.length > 0 || imageChips.length > 0) { e.preventDefault(); escClears() }
      else if (onRewind !== undefined) {
        e.preventDefault()
        const now = Date.now()
        if (now - rewindArmedAt.current > CLEAR_WINDOW_MS) {
          rewindArmedAt.current = now
        } else {
          rewindArmedAt.current = 0
          onRewind()
        }
      }
    }
  }

  return (
    <div className="composer">
      {searching !== null && (
        <div className="history-search" role="dialog" aria-label="Search what you've typed">
          <input autoFocus type="text" className="question-other" placeholder="Search what you've typed in this project" value={searching}
            onChange={e => { setSearching(e.target.value); setSearchSelected(0) }}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); setSearching(null); textareaRef.current?.focus() }
              else if (e.key === 'Tab') { e.preventDefault(); acceptSearch(false) }
              else if (e.key === 'Enter') { e.preventDefault(); acceptSearch(false) }
              else if (e.key === 'ArrowDown' || (e.key === 'r' && e.ctrlKey)) { e.preventDefault(); setSearchSelected(i => Math.min(i + 1, searchResults.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchSelected(i => Math.max(i - 1, 0)) }
            }} />
          <div className="history-results">
            {searchResults.length === 0 && <div className="history-none">Nothing matches.</div>}
            {searchResults.slice(0, 12).map((r, i) => (
              <button type="button" key={r} className={`history-result${i === searchSelected ? ' selected' : ''}`} onMouseDown={e => { e.preventDefault(); setSearchSelected(i); updateText(r); setSearching(null); textareaRef.current?.focus() }}>{r}</button>
            ))}
          </div>
        </div>
      )}
      {menuOpen && (
        <CompletionMenu label={completion.kind === 'command' ? 'Commands' : 'Files'} items={matches.items}
          selected={Math.min(selected, Math.max(matches.items.length - 1, 0))} note={menuNote}
          onPick={pick} onHover={setSelected} />
      )}
      {queue.length > 0 && (
        <ul className="composer-queue" aria-label="Queued messages">
          {queue.map((m, i) => (
            <li key={m.id} className="queue-item">
              <span className="queue-num">{i + 1}</span>
              <span className="queue-text">{m.text}</span>
              <button type="button" className="queue-btn queue-edit" title="Edit" aria-label="Edit" disabled={queueBusy}
                onClick={() => void editQueued(m)}>✎</button>
              <button type="button" className="queue-btn" title="Move up" aria-label="Move up" disabled={queueBusy || i === 0}
                onClick={() => void moveQueued(m, 'up')}>▲</button>
              <button type="button" className="queue-btn" title="Move down" aria-label="Move down" disabled={queueBusy || i === queue.length - 1}
                onClick={() => void moveQueued(m, 'down')}>▼</button>
              <button type="button" className="queue-btn queue-remove" title="Remove" aria-label="Remove" disabled={queueBusy}
                onClick={() => void removeQueued(m)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {(pastedChips.length > 0 || imageChips.length > 0) && (
        <div className="composer-chip-row">
          {pastedChips.map((c, i) => (
            <span key={c.id} className="chip">
              Pasted text #{i + 1} · {c.lineCount} lines
              <button type="button" className="chip-x" title="Remove pasted text"
                onClick={() => setPastedChips(prev => prev.filter(p => p.id !== c.id))}>✕</button>
            </span>
          ))}
          {imageChips.map(img => (
            <ComposerThumbnail key={img.id} image={img} onRemove={() => {
              setImageChips(prev => prev.filter(p => p.id !== img.id))
              textareaRef.current?.focus()
            }} />
          ))}
        </div>
      )}
      {lock !== null && (
        <div className="composer-lock" role="status">
          <span className="composer-lock-icon" aria-hidden="true">🔒</span>
          <span>
            Open in {lockHolder(lock)}{lock.status === 'busy' || lock.status === 'shell' ? ' · working' : ''} — read-only here until it exits.
            New messages from it appear live.
            {hijackConfirm && <> Hijacking closes Claude in that terminal. Anything typed there but not sent is lost.</>}
            {hijackError !== null && <span className="composer-lock-error"> {hijackError}</span>}
          </span>
          {onHijack !== undefined && hijackState !== 'not-terminal' && (
            <span className="composer-lock-actions">
              {hijackConfirm
                ? <>
                    <button type="button" className="btn-primary" disabled={hijacking} onClick={() => void hijack()}>{hijacking ? 'Hijacking…' : 'Yes, hijack'}</button>
                    <button type="button" className="btn-secondary" disabled={hijacking} onClick={() => setHijackConfirm(false)}>Cancel</button>
                  </>
                : <button type="button" className="btn-secondary" disabled={hijackState !== null}
                    title={hijackState === null ? 'Close Claude in that terminal and continue this chat here' : HIJACK_WORKING_TEXT}
                    onClick={() => { setHijackError(null); setHijackConfirm(true) }}>Hijack conversation</button>}
            </span>
          )}
        </div>
      )}
      {showSuggestion && (
        <button type="button" className="composer-suggestion" title="Tab or click to use it; it won’t send until you press Enter" onClick={useSuggestion}>
          <span aria-hidden="true">✦</span> {suggestion}
        </button>
      )}
      <div className={`composer-box${lock !== null ? ' composer-box-locked' : ''}`} onDragOver={handleDragOver} onDrop={handleDrop}>
        <div className="composer-field">
          {highlight > 0 && (
            <div ref={highlightRef} className="composer-highlight" aria-hidden="true">
              <mark>{text.slice(0, highlight)}</mark>{text.slice(highlight)}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer-input"
            placeholder={lock !== null ? 'Chat is open elsewhere' : 'Message Claude  ·  / for commands  ·  @ for files  ·  ! for a shell command'}
            disabled={lock !== null}
            value={text}
            rows={1}
            onChange={e => { setCaret(e.target.selectionStart); clearArmedAt.current = 0; setClearHint(false); updateText(e.target.value) }}
            onSelect={e => setCaret(e.currentTarget.selectionStart)}
            onScroll={e => { if (highlightRef.current !== null) highlightRef.current.scrollTop = e.currentTarget.scrollTop }}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
          />
        </div>
        <button type="button" className="composer-send" title="Send" aria-label="Send message"
          disabled={lock !== null} onClick={attemptSend}>
          ➤
        </button>
      </div>
      {onShellCommand !== undefined && text.trimStart().startsWith('!') && (
        <div className="composer-hint">{running ? 'Runs in a shell in this folder when Claude finishes. Claude then sees the output and replies.' : 'Runs in a shell in this folder. Claude then sees the output and replies.'}</div>
      )}
      {running && (
        <div className="composer-hint" aria-hidden="true">
          {queueNote ?? (queue.length > 0
            ? 'Claude reads queued messages at its next step · Esc takes the last one back'
            : 'Enter queues for Claude\'s next step · Esc stops')}
        </div>
      )}
      {clearHint && <div className="composer-hint" role="status">Esc again to clear</div>}
      {modeNote !== null && <div className="composer-hint" role="status">{modeNote}</div>}
    </div>
  )
}
