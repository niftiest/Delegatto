import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { centeredScrollTop, type NavSection } from '../lib'

/** When the open project moves in the list, say to the top of Today once you send in it,
 *  scrolls the list after it, just far enough that it stays in view. */
export function useFollowSelected(listRef: RefObject<HTMLElement | null>, sections: NavSection[], selectedId: number | null): void {
  const spot = useMemo(() => {
    for (const [s, section] of sections.entries()) {
      const i = section.channels.findIndex(c => c.id === selectedId)
      if (i >= 0) return `${s}:${i}`
    }
    return null
  }, [sections, selectedId])
  const last = useRef<{ id: number | null; spot: string | null }>({ id: selectedId, spot })
  useEffect(() => {
    const before = last.current
    last.current = { id: selectedId, spot }
    // Only a move of the same project: picking another one is the person's own scrolling.
    if (selectedId === null || spot === null || before.id !== selectedId || before.spot === spot) return
    const list = listRef.current
    const item = list?.querySelector<HTMLElement>(`[data-channel="${selectedId}"]`)
    if (list == null || item == null) return
    const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    const bottom = top + item.offsetHeight
    if (top < list.scrollTop) list.scrollTo({ top: top - 8, behavior: 'smooth' })
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom - list.clientHeight + 8, behavior: 'smooth' })
  }, [spot, selectedId])
}

/** Scrolls a project list so this project sits in the middle, then says it's done, so going
 *  back and forth between the chat list and the icon rail later doesn't do it again. Waits two
 *  frames: the project's section may be opening in the same update. */
export function useRevealChannel(listRef: RefObject<HTMLElement | null>, reveal: number | null, onRevealed?: () => void): void {
  useEffect(() => {
    if (reveal === null) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const list = listRef.current
        const item = list?.querySelector<HTMLElement>(`[data-channel="${reveal}"]`)
        if (list !== null && list !== undefined && item !== null && item !== undefined) {
          const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
          list.scrollTop = centeredScrollTop(top, item.offsetHeight, list.clientHeight, list.scrollHeight)
        }
        onRevealed?.()
      })
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [reveal])
}
