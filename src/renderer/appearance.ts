import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from './api'
import type { AppSettings } from '../shared/shell-types'
import type { LocalTheme } from '../shared/themes'
import { FONT_SCALE_DEFAULT, fontStack, stepFontScale } from '../shared/font-settings'
import { applyTheme, applyThemeColors, cachedTheme, type ThemeChoice } from './theme'

/** How far the wheel travels for one step of text size. A mouse's notch is more than this. */
const WHEEL_NOTCH = 50
const CHAT_SCALE_NOTE_MS = 1200
const CHAT_SCALE_SAVE_MS = 300

/** A window's look from the settings: the theme, the font, the text sizes, and Ctrl + wheel
 *  over a chat for its text size, which is one setting for every chat in every window.
 *  Answers the theme choice (for `<main data-theme>`) and the size note to show, if any. */
export function useAppearance(settings: AppSettings | null, setSettings: Dispatch<SetStateAction<AppSettings | null>>): { themeChoice: ThemeChoice; chatScaleNote: number | null } {
  // Text sizes and font, on the page root so dialogs and pop-ups get the font too.
  const chatScaleRef = useRef(FONT_SCALE_DEFAULT)
  const chatScaleSaving = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [chatScaleNote, setChatScaleNote] = useState<number | null>(null)
  const chatFontScale = settings?.chatFontScale ?? FONT_SCALE_DEFAULT
  const sidebarFontScale = settings?.sidebarFontScale ?? FONT_SCALE_DEFAULT
  const appFont = settings?.appFont ?? ''
  useEffect(() => {
    // Mid-scroll the wheel is ahead of what's saved, so an older answer mustn't pull it back.
    if (chatScaleSaving.current !== null) return
    chatScaleRef.current = chatFontScale
    document.documentElement.style.setProperty('--chat-zoom', String(chatFontScale / 100))
  }, [chatFontScale])
  useEffect(() => { document.documentElement.style.setProperty('--sidebar-zoom', String(sidebarFontScale / 100)) }, [sidebarFontScale])
  useEffect(() => {
    const root = document.documentElement
    if (appFont === '') {
      root.removeAttribute('data-custom-font')
      root.style.removeProperty('--app-font')
    } else {
      root.setAttribute('data-custom-font', '')
      root.style.setProperty('--app-font', fontStack(appFont))
    }
  }, [appFont])

  // Ctrl + wheel over the chat: its text size, for every chat. Keeps the reader's place.
  useEffect(() => {
    let leftover = 0
    let hideNote: ReturnType<typeof setTimeout> | null = null
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      const stream = (e.target as Element | null)?.closest?.('.stream') ?? null
      if (stream === null) return
      e.preventDefault()
      leftover += e.deltaY
      if (Math.abs(leftover) < WHEEL_NOTCH) return
      const next = stepFontScale(chatScaleRef.current, leftover < 0 ? 'up' : 'down')
      leftover = 0
      if (next === chatScaleRef.current) return
      const place = stream.scrollTop / Math.max(stream.scrollHeight, 1)
      chatScaleRef.current = next
      document.documentElement.style.setProperty('--chat-zoom', String(next / 100))
      stream.scrollTop = place * stream.scrollHeight
      setChatScaleNote(next)
      if (hideNote !== null) clearTimeout(hideNote)
      hideNote = setTimeout(() => setChatScaleNote(null), CHAT_SCALE_NOTE_MS)
      if (chatScaleSaving.current !== null) clearTimeout(chatScaleSaving.current)
      chatScaleSaving.current = setTimeout(() => {
        chatScaleSaving.current = null
        void api.updateSettings({ chatFontScale: chatScaleRef.current }).then(setSettings)
      }, CHAT_SCALE_SAVE_MS)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('wheel', onWheel)
      if (hideNote !== null) clearTimeout(hideNote)
    }
  }, [])

  // Theme: `<html data-theme>` picks the theme's block in styles.css, or a theme
  // file from this PC's themes folder. Cached in localStorage so main.tsx can
  // apply it before first paint (no flash of the default while settings load).
  // `themeScope` decides whether the skin covers the whole window (<html>) or
  // just the chat pane (<main data-theme>). Until settings load, the
  // cached choice is used so the first paint already matches.
  const cachedChoice = useMemo(cachedTheme, [])
  const themeChoice: ThemeChoice = settings === null
    ? cachedChoice
    : { theme: settings.theme, scope: settings.themeScope }
  // Read again on each change, so an edited theme file shows when it's chosen.
  const [localThemes, setLocalThemes] = useState<LocalTheme[] | null>(null)
  useEffect(() => { void api.listLocalThemes().then(setLocalThemes) }, [themeChoice.theme])
  useEffect(() => {
    if (settings === null) return
    applyTheme(themeChoice, localThemes ?? [])
    applyThemeColors(settings.themeColors)
  }, [themeChoice.theme, themeChoice.scope, localThemes, JSON.stringify(settings?.themeColors ?? {})]) // eslint-disable-line react-hooks/exhaustive-deps

  return { themeChoice, chatScaleNote }
}
