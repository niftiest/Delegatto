import { useRef, useState } from 'react'

/** A thin vertical drag handle between two panels. Reports the horizontal
 *  pointer delta since the last move so the parent can grow/shrink the panel
 *  on its left. Uses pointer capture + window listeners so a fast drag that
 *  outruns the 6px handle doesn't drop the gesture. */
export function Resizer({ onResize, label }: {
  onResize: (deltaX: number) => void
  label: string
}) {
  const lastX = useRef(0)
  const [dragging, setDragging] = useState(false)

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    lastX.current = e.clientX
    setDragging(true)
    // Listen on window, not the handle: a drag can move faster than the
    // pointer stays over a 6px strip, and window listeners never lose it.
    const move = (ev: PointerEvent) => {
      onResize(ev.clientX - lastX.current)
      lastX.current = ev.clientX
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className={dragging ? 'resizer dragging' : 'resizer'}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
    />
  )
}
