import { useRef, useState } from 'react'

export interface PaneResizeHandleProps {
  label: string
  /** Which edge of the parent pane the handle sits on. */
  edge: 'start' | 'end'
  minWidth: number
  maxWidth: (containerWidth: number) => number
  onResize: (width: number) => void
  onReset: () => void
}

interface DragState {
  pointerId: number
  startX: number
  startWidth: number
  containerWidth: number
}

/**
 * Vertical drag handle that resizes its parent pane within the parent's container.
 * Widths are measured at drag start, so the pane may be sized by any CSS default.
 */
export function PaneResizeHandle({ label, edge, minWidth, maxWidth, onResize, onReset }: PaneResizeHandleProps): React.JSX.Element {
  const drag = useRef<DragState | undefined>(undefined)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const pane = event.currentTarget.parentElement
    const container = pane?.parentElement
    if (!pane || !container) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: pane.getBoundingClientRect().width,
      containerWidth: container.getBoundingClientRect().width
    }
    setDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    const delta = event.clientX - state.startX
    const raw = state.startWidth + (edge === 'end' ? delta : -delta)
    const limit = Math.max(minWidth, maxWidth(state.containerWidth))
    onResize(Math.round(Math.min(limit, Math.max(minWidth, raw))))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = undefined
    setDragging(false)
  }

  return (
    <div
      className={`pane-resize-handle is-${edge} ${dragging ? 'is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
    />
  )
}
