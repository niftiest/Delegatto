import { useRef, useState } from 'react'

/** A thin drag handle between two panels. A vertical one (the default) reports the
 *  horizontal pointer delta since the last move, so the parent can grow/shrink the panel
 *  on its left; a horizontal one reports the vertical delta, for the panel above it. Uses
 *  pointer capture + window listeners so a fast drag that outruns the 6px handle doesn't
 *  drop the gesture. */
export function Resizer({ onResize, label, orientation = 'vertical', className, style, onDoubleClick }: {
  onResize: (delta: number) => void
  label: string
  orientation?: 'vertical' | 'horizontal'
  /** Extra classes, for a handle placed over a grid line. */
  className?: string
  style?: React.CSSProperties
  onDoubleClick?: () => void
}) {
  const last = useRef(0)
  const [dragging, setDragging] = useState(false)
  const horizontal = orientation === 'horizontal'

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    last.current = horizontal ? e.clientY : e.clientX
    setDragging(true)
    // Listen on window, not the handle: a drag can move faster than the
    // pointer stays over a 6px strip, and window listeners never lose it.
    const move = (ev: PointerEvent) => {
      const at = horizontal ? ev.clientY : ev.clientX
      onResize(at - last.current)
      last.current = at
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const classes = [horizontal ? 'resizer resizer-h' : 'resizer', dragging ? 'dragging' : '', className ?? ''].filter(c => c.length > 0).join(' ')
  return (
    <div
      className={classes}
      style={style}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
    />
  )
}
