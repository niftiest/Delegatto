import { useEffect, useRef, useState } from 'react'
import { SPLIT_LAYOUTS, type SplitLayout } from '../../shared/split-view'

export const LAYOUT_LABELS: Record<SplitLayout, string> = {
  halves: 'Two side by side',
  'wide-narrow': 'Wide and narrow',
  thirds: 'Three side by side',
  'one-two': 'One and two stacked',
  grid: 'Four in a grid'
}

/** A layout's panes as a small picture. `highlight` marks one pane (the slot being filled). */
export function LayoutGlyph({ layout, highlight, className }: { layout: SplitLayout; highlight?: number; className?: string }) {
  const cells: Array<[number, number, number, number]> =
    layout === 'halves' ? [[1, 1, 6.5, 10], [8.5, 1, 6.5, 10]]
      : layout === 'wide-narrow' ? [[1, 1, 8.5, 10], [10.5, 1, 4.5, 10]]
        : layout === 'thirds' ? [[1, 1, 4, 10], [6, 1, 4, 10], [11, 1, 4, 10]]
        : layout === 'one-two' ? [[1, 1, 6.5, 10], [8.5, 1, 6.5, 4.5], [8.5, 6.5, 6.5, 4.5]]
          : [[1, 1, 6.5, 4.5], [8.5, 1, 6.5, 4.5], [1, 6.5, 6.5, 4.5], [8.5, 6.5, 6.5, 4.5]]
  return (
    <svg viewBox="0 0 16 12" aria-hidden="true" className={`layout-glyph${className === undefined ? '' : ` ${className}`}`}>
      {cells.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="none" stroke="currentColor" className={i === highlight ? 'on' : undefined} />
      ))}
    </svg>
  )
}

/** The split view button and its dropdown of the five layouts. `current` is the open split
 *  window's layout, or null when none is open. The header look sits in a chat header beside
 *  the terminal button; the strip look is the split window's own layout button. */
export function LayoutMenu({ current, onPick, look = 'header' }: {
  current: SplitLayout | null
  onPick(layout: SplitLayout): void
  look?: 'header' | 'strip'
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }
  const toggle = (): void => {
    if (open) { close(false); return }
    setActive(Math.max(0, current === null ? 0 : SPLIT_LAYOUTS.indexOf(current)))
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    // Ahead of everything else: behind this menu, Esc would stop a running turn.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close(true)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  useEffect(() => { if (open) itemRefs.current[active]?.focus() }, [open, active])

  const pick = (layout: SplitLayout): void => {
    close(true)
    onPick(layout)
  }
  const onMenuKey = (e: React.KeyboardEvent): void => {
    const n = SPLIT_LAYOUTS.length
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % n) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + n) % n) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1) }
    else if (e.key === 'Tab') close(false)
  }

  return (
    <div className={`layout-menu layout-menu-${look}`} ref={rootRef}>
      {look === 'header'
        ? (
            <button ref={buttonRef} type="button" className="chead-term chead-term-icon" title="Split view" aria-label="Split view"
              aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <svg viewBox="0 0 20 18" aria-hidden="true">
                <rect x=".5" y=".5" width="19" height="17" rx="1.5" fill="none" stroke="currentColor" />
                <rect x="1" y="1" width="18" height="3.5" fill="currentColor" opacity=".35" />
                <rect x="3" y="6.5" width="5.5" height="9" rx=".75" fill="currentColor" opacity=".55" />
                <rect x="11.5" y="6.5" width="5.5" height="9" rx=".75" fill="currentColor" opacity=".55" />
              </svg>
            </button>
          )
        : (
            <button ref={buttonRef} type="button" className="split-strip-layout" title="Layout" aria-label="Layout"
              aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <LayoutGlyph layout={current ?? 'halves'} />
            </button>
          )}
      {open && (
        <div className="layout-menu-pop" role="menu" aria-label="Split view layouts" onKeyDown={onMenuKey}>
          {SPLIT_LAYOUTS.map((layout, i) => (
            <button key={layout} ref={el => { itemRefs.current[i] = el }} type="button" role="menuitemradio"
              aria-checked={layout === current} tabIndex={i === active ? 0 : -1}
              className={`layout-menu-item${layout === current ? ' current' : ''}`}
              title={LAYOUT_LABELS[layout]} aria-label={LAYOUT_LABELS[layout]}
              onFocus={() => setActive(i)} onClick={() => pick(layout)}>
              <LayoutGlyph layout={layout} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
