// A long-press on a touch screen, as the right-click it stands in for.
//
// iPhone Safari never fires `contextmenu` for a long-press -- not on a canvas, not anywhere --
// so a menu opened only by that event cannot be reached on an iPhone at all. This recognises
// the hold itself: one finger, down for LONG_PRESS_MS, never straying LONG_PRESS_SLOP from
// where it landed. A second finger (a pinch) or a drag (a pan) is not a hold.
//
// Touch events, not pointer events: the chart handles its own touches, and on iOS a pointer
// stream the browser decides is a scroll ends in `pointercancel` part-way -- a timer keyed off
// pointers would be cancelled by the very gesture it is timing.
//
// Two things a long-press must not ALSO be:
//  - a tap. Lifting the finger after the menu opened can deliver a click to whatever is under
//    it -- the wall's click-to-scroll, or the menu row that just appeared beneath the finger --
//    so the click that follows a fired hold is swallowed.
//  - a second menu. Android and Windows DO fire `contextmenu` for the same hold, at about the
//    same moment; `cancel()` is for that listener, and `firedRecently()` for the other order.

export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP = 10
/** How long after the finger lifts a click is taken to be the hold's own release. A
 * deliberate tap on the opened menu takes longer than this to land. */
export const RELEASE_CLICK_MS = 400
/** How long after a fired hold a native `contextmenu` is taken to be the same gesture. */
export const SAME_GESTURE_MS = 1000

export interface LongPressPoint {
  clientX: number
  clientY: number
}

export interface LongPressOptions {
  onLongPress(point: LongPressPoint): void
  delayMs?: number
  slopPx?: number
  /** Where the release click is swallowed. Default: `window`, in the capture phase, so it is
   * stopped before any listener in the page sees it. */
  clickTarget?: EventTarget
  now?: () => number
}

export interface LongPress {
  /** Abandon a hold in progress (a native contextmenu got there first). */
  cancel(): void
  /** Whether a hold fired within SAME_GESTURE_MS. */
  firedRecently(): boolean
  dispose(): void
}

interface TouchLike {
  clientX: number
  clientY: number
}

type TouchListEvent = Event & { touches: ArrayLike<TouchLike> }

export function attachLongPress(element: EventTarget, options: LongPressOptions): LongPress {
  const delay = options.delayMs ?? LONG_PRESS_MS
  const slop = options.slopPx ?? LONG_PRESS_SLOP
  const now = options.now ?? Date.now
  const clickTarget: EventTarget | undefined =
    options.clickTarget ?? (typeof window === 'undefined' ? undefined : window)

  let timer: ReturnType<typeof setTimeout> | null = null
  let origin: LongPressPoint | null = null
  let fired = false
  let firedAt = Number.NEGATIVE_INFINITY

  function cancel(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    origin = null
  }

  function onStart(event: Event): void {
    cancel()
    fired = false
    const { touches } = event as TouchListEvent
    if (touches.length !== 1) return
    const at = { clientX: touches[0].clientX, clientY: touches[0].clientY }
    origin = at
    timer = setTimeout(() => {
      timer = null
      origin = null
      fired = true
      firedAt = now()
      options.onLongPress(at)
    }, delay)
  }

  function onMove(event: Event): void {
    if (!origin) return
    const { touches } = event as TouchListEvent
    const touch = touches.length === 1 ? touches[0] : null
    if (!touch || Math.hypot(touch.clientX - origin.clientX, touch.clientY - origin.clientY) > slop) {
      cancel()
    }
  }

  function onEnd(): void {
    cancel()
    if (!fired || !clickTarget) return
    fired = false
    const swallow = (event: Event): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    clickTarget.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => clickTarget.removeEventListener('click', swallow, { capture: true }), RELEASE_CLICK_MS)
  }

  element.addEventListener('touchstart', onStart, { passive: true })
  element.addEventListener('touchmove', onMove, { passive: true })
  element.addEventListener('touchend', onEnd)
  element.addEventListener('touchcancel', onEnd)

  return {
    cancel,
    firedRecently: () => now() - firedAt < SAME_GESTURE_MS,
    dispose(): void {
      cancel()
      element.removeEventListener('touchstart', onStart)
      element.removeEventListener('touchmove', onMove)
      element.removeEventListener('touchend', onEnd)
      element.removeEventListener('touchcancel', onEnd)
    }
  }
}
