import { clampPosition } from './window'

// Dragging a dialog card by its title. The card starts wherever its backdrop's flex centring
// puts it; the first drag takes it out of that layout (fixed, at the same spot) and from then on
// it stays where it is put, kept inside the viewport.
//
// Listeners on `window`, not pointer capture: the same choice as ./window.ts, whose README says
// why (a capture is dropped when the element moves in the tree, and the drag never ends).

/** Make `card` draggable by `handle`. A press that starts on a control inside the handle is that
 * control's. Returns a disposer. */
export function dragByHandle(card: HTMLElement, handle: HTMLElement): () => void {
  let grab: { dx: number; dy: number; pointerId: number } | null = null

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, select, input, textarea, label, a')) return
    const rect = card.getBoundingClientRect()
    grab = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, pointerId: event.pointerId }
    // Out of the backdrop's centring, pinned exactly where it is now, so it does not jump.
    card.style.position = 'fixed'
    card.style.margin = '0'
    card.style.left = `${rect.left}px`
    card.style.top = `${rect.top}px`
    card.classList.add('is-dragging')
    event.preventDefault()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onMove = (event: PointerEvent): void => {
    if (!grab || event.pointerId !== grab.pointerId) return
    const pos = clampPosition(
      { x: event.clientX - grab.dx, y: event.clientY - grab.dy },
      { width: card.offsetWidth, height: card.offsetHeight },
      { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    )
    card.style.left = `${pos.x}px`
    card.style.top = `${pos.y}px`
  }

  const onUp = (event: PointerEvent): void => {
    if (!grab || event.pointerId !== grab.pointerId) return
    end()
  }

  function end(): void {
    grab = null
    card.classList.remove('is-dragging')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

  handle.addEventListener('pointerdown', onDown)
  return () => {
    end()
    handle.removeEventListener('pointerdown', onDown)
  }
}
